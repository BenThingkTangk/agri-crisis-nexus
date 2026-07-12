// Shared PostgreSQL access layer for AGRI-NEXUS.
//
// Uses a single pooled connection per serverless container (cached on the Node
// global so warm invocations reuse it). All callers use parameterized queries
// only — never string-interpolate user input into SQL.
//
// Connection is driven entirely by DATABASE_URL (Akamai/Linode managed
// PostgreSQL 16). TLS is required by the managed service; we enable it and set
// rejectUnauthorized based on DB_TLS_REJECT_UNAUTHORIZED (defaults to false,
// which is the pragmatic setting for managed providers that present a CA the
// serverless runtime does not bundle). Never log or echo the connection string.

import pg from 'pg';

const { Pool } = pg;

function makePool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured');
  }
  // Managed PostgreSQL mandates TLS. Allow opting into strict verification via
  // env when a CA bundle is available; default to encrypted-but-not-verified so
  // the app works out of the box against the managed endpoint.
  const rejectUnauthorized =
    String(process.env.DB_TLS_REJECT_UNAUTHORIZED || '').toLowerCase() === 'true';
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized },
    max: Number(process.env.DB_POOL_MAX || 3),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
}

// Cache the pool on globalThis so it survives module re-evaluation within a warm
// serverless container and we don't exhaust connections.
function pool() {
  if (!globalThis.__AGRI_PG_POOL__) {
    globalThis.__AGRI_PG_POOL__ = makePool();
  }
  return globalThis.__AGRI_PG_POOL__;
}

export async function query(text, params) {
  return pool().query(text, params);
}

// Acquire a single dedicated client from the pool, run `fn(client)`, and always
// release it. Needed for session-scoped operations such as advisory locks, where
// the lock and unlock must run on the same physical connection.
export async function withClient(fn) {
  const client = await pool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Run a set of statements inside a single transaction. `fn` receives a client
// with a scoped `query` method; throwing rolls back.
export async function withTransaction(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}
