// Cold-start schema bootstrap for AGRI-NEXUS Phase III.
//
// Vercel serverless containers re-evaluate modules on cold start but never run
// database migrations automatically — migrations only apply via the CLI
// (`node api/_migrate.js`) or the token-gated endpoint. Production therefore had
// migration 001 (applied manually) but not 002, so every Phase III query against
// the new columns/tables raised a missing-relation/column error and surfaced as a
// generic 500. This module closes that gap: each Phase III endpoint awaits
// `ensureSchema()` before touching the database, which idempotently applies any
// un-applied migration exactly once per database — safe across simultaneous cold
// starts and cheap on warm containers.

import { query, withClient } from './_db.js';
import { loadMigrations } from './_migrate.js';

// Fixed advisory-lock key (two 32-bit ints). Arbitrary but stable so every
// container contends on the same lock while bootstrapping.
const LOCK_KEY_HI = 0x41475249; // "AGRI"
const LOCK_KEY_LO = 0x4e455853; // "NEXS"

async function bootstrap() {
  await withClient(async (client) => {
    // Serialize bootstrap across all concurrent cold starts. Only one container
    // holds the lock at a time; the rest block here, then observe an already
    // fully-applied ledger and do no work.
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           filename   TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query('SELECT filename FROM schema_migrations');
      const done = new Set(rows.map((r) => r.filename));
      for (const { name, sql } of loadMigrations()) {
        if (done.has(name)) continue;
        // Each migration file is itself idempotent (IF NOT EXISTS / guarded
        // enum creation), so re-running a partially-applied file is safe.
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [name],
        );
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_HI, LOCK_KEY_LO]);
    }
  });
}

// Ensure the schema is up to date, running the bootstrap at most once per warm
// container. The in-flight promise is cached on globalThis so concurrent
// requests on the same container share a single run; on failure the cache is
// cleared so a later request retries rather than being stuck with a rejected
// promise forever.
export function ensureSchema() {
  if (!globalThis.__AGRI_SCHEMA_READY__) {
    globalThis.__AGRI_SCHEMA_READY__ = bootstrap().catch((err) => {
      globalThis.__AGRI_SCHEMA_READY__ = null;
      throw err;
    });
  }
  return globalThis.__AGRI_SCHEMA_READY__;
}
