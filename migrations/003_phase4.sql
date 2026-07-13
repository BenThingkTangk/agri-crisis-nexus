-- AGRI-NEXUS Phase IV — geofenced breadbasket early-warning engine, alert
-- policies + notification center, and external command integrations.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS / guarded enum blocks /
-- ADD COLUMN IF NOT EXISTS). Non-destructive: never drops, deletes, or empties
-- any Phase II/III data. All tables are tenant-scoped via team_id and reuse the
-- 001 conventions (UUID PKs, JSONB for flexible domain metadata, typed columns
-- for anything filtered/sorted, set_updated_at() trigger).

-- ---------------------------------------------------------------------------
-- New enums (guarded — CREATE TYPE has no IF NOT EXISTS)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE watch_band AS ENUM ('calm', 'guarded', 'elevated', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_state AS ENUM ('unread', 'read', 'acknowledged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('pending', 'delivered', 'failed', 'skipped', 'dry_run');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Geofences — persistent, team-scoped agricultural watch zones. Geometry is a
-- JSONB shape (polygon | bbox | point+radius) validated in the app engine. The
-- starter catalog is product-defined (source = 'catalog'); custom zones are
-- source = 'custom'. These are AgriOS operational zones, NOT government
-- boundary definitions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geofences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,                         -- stable identity within a team
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'custom',        -- breadbasket | chokepoint | custom
  source      TEXT NOT NULL DEFAULT 'custom',        -- catalog | custom (provenance of the definition)
  geometry    JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {type:polygon|bbox|point, ...}
  crops       TEXT[] NOT NULL DEFAULT '{}',
  threats     TEXT[] NOT NULL DEFAULT '{}',          -- threat dimensions of interest (empty = any)
  region      TEXT,
  notes       TEXT NOT NULL DEFAULT '',
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);
CREATE INDEX IF NOT EXISTS geofences_team_idx ON geofences (team_id);
CREATE INDEX IF NOT EXISTS geofences_enabled_idx ON geofences (team_id, enabled);

-- ---------------------------------------------------------------------------
-- Zone score snapshots — persisted every evaluation so trend/history is real
-- (never fabricated). Separates OBSERVED / MODELED / ANALYST provenance and
-- records the interpretable exposure dimensions, evidence, assumptions, and a
-- stale-data flag. This is early-warning / scenario intelligence, not
-- deterministic prediction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zone_scores (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  geofence_id   UUID NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL DEFAULT 0,          -- 0..100 watch score
  band          watch_band NOT NULL DEFAULT 'calm',
  trend         TEXT NOT NULL DEFAULT 'steady',      -- rising | falling | steady
  delta         INTEGER NOT NULL DEFAULT 0,          -- vs previous snapshot
  dimensions    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {crop_weather, conflict_security, logistics_chokepoint, market_supply, freshness_confidence}
  provenance    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {observed:[], modeled:[], analyst:[]}
  evidence      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{title,url,source,at}]
  assumptions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence    REAL NOT NULL DEFAULT 0,             -- 0..1
  freshness_hours REAL,                              -- age of freshest supporting signal
  stale         BOOLEAN NOT NULL DEFAULT FALSE,
  explanation   TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS zone_scores_zone_idx ON zone_scores (geofence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS zone_scores_team_idx ON zone_scores (team_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Alert policies — team-scoped rules matched against fresh zone snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_policies (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  min_band          watch_band NOT NULL DEFAULT 'elevated',
  geofence_ids      UUID[] NOT NULL DEFAULT '{}',    -- empty = all zones
  threats           TEXT[] NOT NULL DEFAULT '{}',    -- dimension filter (empty = any)
  quiet_hours       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {start:HH, end:HH, tz}
  cooldown_minutes  INTEGER NOT NULL DEFAULT 360,
  repeat            BOOLEAN NOT NULL DEFAULT FALSE,  -- re-notify after cooldown while still matching
  escalation_target TEXT,                            -- integration channel id/handle (optional)
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alert_policies_team_idx ON alert_policies (team_id, enabled);

-- ---------------------------------------------------------------------------
-- Notifications — internal inbox. Deduplicated per (team_id, dedupe_key). Holds
-- unread/read/acknowledged lifecycle plus source linkage and delivery/retry
-- metadata for any external fan-out attempts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  policy_id         UUID REFERENCES alert_policies(id) ON DELETE SET NULL,
  geofence_id       UUID REFERENCES geofences(id) ON DELETE SET NULL,
  alert_id          UUID REFERENCES alerts(id) ON DELETE SET NULL,
  mission_id        UUID REFERENCES missions(id) ON DELETE SET NULL,
  dedupe_key        TEXT NOT NULL,                   -- idempotency key for the source event window
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  band              watch_band NOT NULL DEFAULT 'elevated',
  score             INTEGER NOT NULL DEFAULT 0,
  state             notification_state NOT NULL DEFAULT 'unread',
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- snapshot: dimensions/provenance/evidence/deep link
  delivery_state    delivery_status NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TIMESTAMPTZ,
  last_error        TEXT,
  read_at           TIMESTAMPTZ,
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_team_idx ON notifications (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_state_idx ON notifications (team_id, state);

-- ---------------------------------------------------------------------------
-- Integration channels — external command fan-out config. Credentials are
-- NEVER stored here: `secret_ref` names an environment variable that holds the
-- webhook URL / token. `config` carries only non-secret metadata. `health`
-- records last test/success/error for owner-visible channel health.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_channels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                         -- webhook | slack | teams | email
  name        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  secret_ref  TEXT,                                  -- env var NAME holding the URL/credential (never the value)
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- non-secret metadata (labels, default deep link, etc.)
  health      JSONB NOT NULL DEFAULT '{}'::jsonb,    -- {status,last_test_at,last_success_at,last_error}
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, kind, name)
);
CREATE INDEX IF NOT EXISTS integration_channels_team_idx ON integration_channels (team_id);

-- ---------------------------------------------------------------------------
-- Delivery log — append-only record of outbound attempts (live, test, dry-run).
-- Request/response are stored sanitized (never the secret URL or credentials).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS delivery_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  channel_id      UUID REFERENCES integration_channels(id) ON DELETE SET NULL,
  notification_id UUID REFERENCES notifications(id) ON DELETE SET NULL,
  mode            TEXT NOT NULL DEFAULT 'live',      -- live | test | dry_run
  idempotency_key TEXT,
  status          delivery_status NOT NULL DEFAULT 'pending',
  attempt         INTEGER NOT NULL DEFAULT 1,
  request         JSONB NOT NULL DEFAULT '{}'::jsonb, -- sanitized (host only, no secret path)
  response        JSONB NOT NULL DEFAULT '{}'::jsonb, -- {code, ok}
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_log_team_idx ON delivery_log (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS delivery_log_channel_idx ON delivery_log (channel_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance for the new tables that carry it
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['geofences','alert_policies','notifications','integration_channels']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;
