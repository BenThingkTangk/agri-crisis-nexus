-- AGRI-NEXUS Phase VI — agricultural catalog/coverage ingestion pipeline.
--
-- Adds a durable run ledger and a dead-letter (quarantine) table for the
-- server-side catalog adapters (NASA Earthdata CMR, Copernicus, FAO WaPOR,
-- WRI Aqueduct). These record WHAT ran, WHEN, and with WHAT RESULT so ingestion
-- health, freshness, and failures are auditable rather than fabricated.
--
-- Idempotent: safe to run repeatedly (IF NOT EXISTS / guarded enum blocks).
-- Non-destructive: never drops, deletes, or empties any prior-phase data.
--
-- SECURITY: these tables store NO credentials. `auth_mode` records only a mode
-- label ('authenticated' | 'public' | 'none'), never a token. `error_class` /
-- `error_message` carry a redacted, bounded summary — never raw upstream bodies,
-- Authorization headers, or query secrets.

-- ---------------------------------------------------------------------------
-- Enums (guarded — CREATE TYPE has no IF NOT EXISTS)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE ingest_auth_mode AS ENUM ('authenticated', 'public', 'none', 'unauthenticated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Ingestion runs — one row per provider per pipeline run. Bounded, append-only
-- audit of catalog/coverage discovery. Global (not tenant-scoped): these are
-- platform data-source health facts, identical for every team.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            TEXT NOT NULL,                       -- deterministic run identifier
  provider          TEXT NOT NULL,                       -- nasa-cmr | copernicus | fao-wapor | wri-aqueduct
  adapter_version   TEXT NOT NULL,                       -- wire-contract version of the adapter
  state             TEXT NOT NULL,                       -- provider roll-up state (LIVE/CATALOG_ONLY/...)
  auth_mode         ingest_auth_mode NOT NULL DEFAULT 'none',
  layers            INTEGER NOT NULL DEFAULT 0,
  records_discovered INTEGER NOT NULL DEFAULT 0,
  records_accepted  INTEGER NOT NULL DEFAULT 0,
  records_rejected  INTEGER NOT NULL DEFAULT 0,
  http_category     TEXT NOT NULL DEFAULT 'ok',          -- ok | rate_limit | auth | server | client | timeout | network
  freshest_as_of    TIMESTAMPTZ,                         -- newest granule/coverage timestamp discovered
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  error_class       TEXT,                                -- coarse class only (never a secret)
  error_message     TEXT,                                -- redacted, bounded (<=160 chars)
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-layer contract summaries (no secrets)
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_runs_provider_idx ON ingestion_runs (provider, completed_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_runs_created_idx  ON ingestion_runs (created_at DESC);

-- ---------------------------------------------------------------------------
-- Dead-letter / quarantine — malformed or rejected records captured as SAFE,
-- bounded summaries so a bad upstream payload can be diagnosed without ever
-- persisting raw blobs, secrets, or unbounded content.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_dead_letter (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider    TEXT NOT NULL,
  reason      TEXT NOT NULL,                             -- redacted, bounded
  sample      TEXT,                                      -- key list / redacted snippet, bounded
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingestion_dead_letter_provider_idx ON ingestion_dead_letter (provider, occurred_at DESC);
