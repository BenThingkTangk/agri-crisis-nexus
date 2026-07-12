-- AGRI-NEXUS Phase III — predictive alerts lifecycle, mission orchestration,
-- and War Room collaboration. Idempotent: safe to run repeatedly. Extends the
-- 001 schema in place (ALTER ... IF NOT EXISTS / guarded DO blocks) and adds new
-- tenant-scoped tables. No destructive changes; existing digest alerts keep
-- working (new columns are nullable / defaulted).

-- ---------------------------------------------------------------------------
-- New enums (guarded — CREATE TYPE has no IF NOT EXISTS)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE alert_status AS ENUM ('new', 'acknowledged', 'escalated', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('todo', 'doing', 'blocked', 'done');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE presence_status AS ENUM ('online', 'away', 'offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Alert lifecycle + predictive/explainability fields
-- Existing alerts stay a live-feed digest; these columns turn them into
-- operational, triageable, explainable alerts. `basis` distinguishes an
-- observed trigger from a modeled projection or an analyst-entered signal.
-- ---------------------------------------------------------------------------
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS status       alert_status NOT NULL DEFAULT 'new';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS basis        TEXT NOT NULL DEFAULT 'observed';  -- observed | modeled | analyst
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS confidence   REAL;                              -- 0..1, NULL when not modeled
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS horizon      TEXT;                              -- 24h | 7d | 30d | seasonal
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS regions      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS commodities  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS causal_chain JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS assumptions  JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_id     UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS mission_id   UUID REFERENCES missions(id) ON DELETE SET NULL;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated_at    TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS alerts_status_idx ON alerts (team_id, status);
CREATE INDEX IF NOT EXISTS alerts_mission_idx ON alerts (mission_id);

-- Missions gain an SLA target + an after-action outcome record.
ALTER TABLE missions ADD COLUMN IF NOT EXISTS sla_minutes  INTEGER;               -- NULL = no SLA clock
ALTER TABLE missions ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;           -- when it first went active (SLA start)
ALTER TABLE missions ADD COLUMN IF NOT EXISTS template_key TEXT;                  -- originating template, if any
ALTER TABLE missions ADD COLUMN IF NOT EXISTS outcome      JSONB NOT NULL DEFAULT '{}'::jsonb;  -- after-action summary

-- ---------------------------------------------------------------------------
-- Mission tasks / checkpoints
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      task_status NOT NULL DEFAULT 'todo',
  sort        INTEGER NOT NULL DEFAULT 0,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  due_at      TIMESTAMPTZ,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_tasks_mission_idx ON mission_tasks (mission_id, sort);
CREATE INDEX IF NOT EXISTS mission_tasks_team_idx ON mission_tasks (team_id);

-- ---------------------------------------------------------------------------
-- Mission decision log (decision gates + rationale)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  gate        TEXT NOT NULL,                -- decision gate label
  decision    TEXT NOT NULL,               -- approve | reject | hold | note
  rationale   TEXT NOT NULL DEFAULT '',
  decided_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_decisions_mission_idx ON mission_decisions (mission_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Mission activity stream (append-only timeline)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mission_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id  UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,               -- created | status | task | decision | assign | note | evidence
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mission_events_mission_idx ON mission_events (mission_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- War Room presence (near-real-time via heartbeat; freshness is derived, never
-- faked — the client labels last-sync and downgrades stale members to away/
-- offline based on last_seen_at).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_presence (
  team_id      UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       presence_status NOT NULL DEFAULT 'online',
  focus        TEXT,                        -- current mode/mission the member is viewing
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_presence_team_idx ON room_presence (team_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- War Room messages (comments, @mentions, assignment/approval system events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  mentions    TEXT[] NOT NULL DEFAULT '{}', -- mentioned user ids
  kind        TEXT NOT NULL DEFAULT 'message', -- message | system
  ref_type    TEXT,                         -- alert | mission | scenario (optional linkage)
  ref_id      UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_messages_team_idx ON room_messages (team_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance for the new tables that carry it
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['alerts','mission_tasks','room_presence']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END $$;
