-- AGRI-NEXUS persistence schema (PostgreSQL 16).
-- Idempotent: safe to run repeatedly. All objects use IF NOT EXISTS or guarded
-- DO blocks. UUID primary keys, tenant scoping via team_id, typed columns for
-- anything filtered/sorted, JSONB only for flexible domain metadata.

CREATE EXTENSION IF NOT EXISTS pgcrypto;      -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums (guarded — CREATE TYPE has no IF NOT EXISTS)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE member_role AS ENUM ('owner', 'admin', 'analyst', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mission_status AS ENUM ('proposed', 'active', 'blocked', 'complete', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mission_priority AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE alert_severity AS ENUM ('moderate', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Core identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  email_norm    TEXT NOT NULL,                       -- lower(trim(email)) for lookups
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,                       -- scrypt-derived, salted (never plaintext)
  password_salt TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_norm_key ON users (email_norm);

CREATE TABLE IF NOT EXISTS teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_key ON teams (slug);

CREATE TABLE IF NOT EXISTS team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       member_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_members_user_idx ON team_members (user_id);
CREATE INDEX IF NOT EXISTS team_members_team_idx ON team_members (team_id);

-- ---------------------------------------------------------------------------
-- Sessions (opaque hashed tokens; the raw token lives only in the cookie)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,                        -- sha-256 of the raw session token
  active_team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  csrf_secret  TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Invitations (single-use, expiring; token stored hashed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email_norm  TEXT,                                  -- optional targeted invite
  role        member_role NOT NULL DEFAULT 'viewer',
  token_hash  TEXT NOT NULL,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_key ON invitations (token_hash);
CREATE INDEX IF NOT EXISTS invitations_team_idx ON invitations (team_id);

-- ---------------------------------------------------------------------------
-- Missions (tenant-scoped operational work items)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS missions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  objective   TEXT NOT NULL DEFAULT '',
  status      mission_status NOT NULL DEFAULT 'proposed',
  priority    mission_priority NOT NULL DEFAULT 'medium',
  pillar      TEXT,                                  -- one of the four fixed pillars
  geography   TEXT,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source_ref  TEXT,                                  -- originating event id (e.g. alert/live event)
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  due_at      TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS missions_team_idx ON missions (team_id);
CREATE INDEX IF NOT EXISTS missions_status_idx ON missions (team_id, status);
CREATE INDEX IF NOT EXISTS missions_priority_idx ON missions (team_id, priority);
CREATE INDEX IF NOT EXISTS missions_assignee_idx ON missions (assignee_id);

-- ---------------------------------------------------------------------------
-- War Room scenarios (saved simulations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scenarios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  threat      TEXT NOT NULL,
  pillar      TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- intensity, horizon, coa, etc.
  result      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- simulation output snapshot
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_team_idx ON scenarios (team_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Alert rules + alerts + per-user read state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  min_severity alert_severity NOT NULL DEFAULT 'moderate',
  categories   TEXT[] NOT NULL DEFAULT '{}',         -- empty = any category
  geographies  TEXT[] NOT NULL DEFAULT '{}',         -- empty = any geography (substring match)
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_rules_team_idx ON alert_rules (team_id);

CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rule_id     UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  event_key   TEXT NOT NULL,                         -- dedup key from the live feed event
  source      TEXT,
  title       TEXT NOT NULL,
  category    TEXT,
  severity    alert_severity NOT NULL DEFAULT 'moderate',
  geography   TEXT,
  url         TEXT,
  event_at    TIMESTAMPTZ,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, event_key)
);
CREATE INDEX IF NOT EXISTS alerts_team_idx ON alerts (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_severity_idx ON alerts (team_id, severity);

CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, user_id)
);
CREATE INDEX IF NOT EXISTS alert_reads_user_idx ON alert_reads (user_id);

-- ---------------------------------------------------------------------------
-- Audit log (append-only record of important writes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID REFERENCES teams(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   UUID,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_team_idx ON audit_log (team_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','teams','team_members','missions','alert_rules']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;
