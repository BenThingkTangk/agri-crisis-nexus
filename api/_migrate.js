// Idempotent migration runner. Applies migrations/*.sql in filename order.
//
// Usage (local / CI, with DATABASE_URL exported):
//   node api/_migrate.js
//
// Also exported as a Vercel function so the schema can be applied from the
// deployed environment. The endpoint requires MIGRATE_TOKEN and a matching
// `?token=` (or x-migrate-token header) so it cannot be triggered anonymously.
// Returns which files ran; never echoes the connection string.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from './_db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

export async function runMigrations() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await query(sql);
    applied.push(file);
  }
  return applied;
}

export default async function handler(req, res) {
  const expected = (process.env.MIGRATE_TOKEN || '').trim();
  const provided = (
    req.headers['x-migrate-token'] ||
    (req.query && req.query.token) ||
    ''
  ).toString().trim();
  if (!expected || provided !== expected) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  try {
    const applied = await runMigrations();
    return res.status(200).json({ ok: true, applied });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'migration_failed', detail: String(err.message || err) });
  }
}

// Allow `node api/_migrate.js` as a CLI.
const isCli = process.argv[1] && process.argv[1].endsWith('_migrate.js');
if (isCli) {
  runMigrations()
    .then((applied) => {
      console.log('Applied migrations:', applied.join(', ') || '(none)');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err.message || err);
      process.exit(1);
    });
}
