// Phase VI — agricultural catalog/coverage ingestion endpoint.
//
//   GET  /api/ingest                    -> full catalog: layer contracts + provider
//                                          health + summary + recent run ledger
//   GET  /api/ingest?view=health        -> provider/summary roll-up only (lightweight)
//   GET  /api/ingest?view=runs          -> ingestion run ledger (DB if present, else memory)
//   GET  /api/ingest?view=deadletter    -> quarantine summaries (redacted, bounded)
//   GET  /api/ingest?layer=<layerId>    -> a single resolved layer contract
//   POST /api/ingest?action=refresh     -> force a cache-busting re-collect.
//         Authorized by EITHER an owner account session (bearer + same-origin)
//         OR a server-only INGEST_CRON_SECRET header (for a scheduled job). A
//         per-warm-container cooldown debounces abuse.
//
// Never throws to the client: always 200 with whatever succeeded and a per-
// provider health block. NO credentials ever appear in any response, run row,
// dead-letter entry, or error message.

import {
  collectCatalog, resolveLayer, LAYER_BY_ID, LAYER_CONTRACTS,
  recordRuns, getRuns, getDeadLetter, CATALOG_ADAPTER_VERSION,
} from './_catalog.js';
import { resolveAccount } from './_accounts.js';
import { safeEqual } from './_crypto.js';
import { hasDatabase, query } from './_db.js';

// Warm-container refresh cooldown so a flood of POSTs can't hammer upstreams.
const REFRESH_COOLDOWN_MS = 30_000;

function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (!host || !src) return false;
  try { return new URL(src).host === host; } catch (_) { return false; }
}

// Authorize a refresh: owner session (same-origin) OR the server-only cron
// secret. The secret is compared in constant time and never echoed.
function authorizeRefresh(req) {
  const secret = (process.env.INGEST_CRON_SECRET || '').trim();
  const provided = String(req.headers['x-ingest-secret'] || '').trim();
  if (secret && provided && safeEqual(secret, provided)) {
    return { ok: true, via: 'cron' };
  }
  if (sameOrigin(req)) {
    const acct = resolveAccount(req, { minRole: 'owner' });
    if (acct) return { ok: true, via: 'owner', account: acct };
  }
  return { ok: false };
}

// Best-effort durable persistence of run rows + quarantine. Swallows DB errors:
// the in-memory ledger is always populated so the pipeline is never blocked by
// the database being absent or degraded.
async function persistRuns(result) {
  if (!hasDatabase()) return { persisted: false, reason: 'no_database' };
  try {
    for (const r of result.runs) {
      const detail = JSON.stringify({
        layers: result.contracts.filter((c) => c.provider === r.provider).map((c) => ({
          layerId: c.layerId, state: c.state, records: c.recordsDiscovered,
          asOf: c.freshness && c.freshness.asOf,
        })),
      });
      await query(
        `INSERT INTO ingestion_runs
           (run_id, provider, adapter_version, state, auth_mode, layers,
            records_discovered, records_accepted, records_rejected, http_category,
            freshest_as_of, duration_ms, error_class, error_message, detail,
            started_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [r.runId, r.provider, r.adapterVersion, r.state, r.authMode, r.layers,
         r.recordsDiscovered, r.recordsAccepted, r.recordsRejected, r.httpCategory,
         r.freshestAsOf, r.durationMs, r.error ? r.httpCategory : null, r.error,
         detail, r.startedAt, r.completedAt]
      );
    }
    return { persisted: true };
  } catch (_) {
    return { persisted: false, reason: 'db_error' };
  }
}

async function loadRuns(limit) {
  if (hasDatabase()) {
    try {
      const { rows } = await query(
        `SELECT run_id, provider, adapter_version, state, auth_mode, layers,
                records_discovered, records_accepted, records_rejected, http_category,
                freshest_as_of, duration_ms, error_message, started_at, completed_at
           FROM ingestion_runs ORDER BY completed_at DESC LIMIT $1`, [limit]
      );
      return { source: 'database', runs: rows };
    } catch (_) { /* fall through to memory */ }
  }
  return { source: 'memory', runs: getRuns(limit) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, 'http://localhost');
  const view = url.searchParams.get('view');
  const action = url.searchParams.get('action');
  const layerId = url.searchParams.get('layer');

  const deps = { fetchImpl: globalThis.fetch, env: process.env, now: Date.now() };

  // ---- run ledger --------------------------------------------------------
  if (req.method === 'GET' && view === 'runs') {
    res.setHeader('Cache-Control', 'no-store');
    const { source, runs } = await loadRuns(Number(url.searchParams.get('limit')) || 50);
    return res.status(200).json({ ok: true, source, adapterVersion: CATALOG_ADAPTER_VERSION, runs });
  }

  // ---- dead-letter (in-memory, redacted) ---------------------------------
  if (req.method === 'GET' && view === 'deadletter') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, deadLetter: getDeadLetter(Number(url.searchParams.get('limit')) || 25) });
  }

  // ---- single layer contract ---------------------------------------------
  if (req.method === 'GET' && layerId) {
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    const layer = LAYER_BY_ID[layerId];
    if (!layer) return res.status(404).json({ ok: false, error: 'unknown_layer' });
    const contract = await resolveLayer(layer, deps);
    return res.status(200).json({ ok: true, contract });
  }

  // ---- forced refresh (owner session or cron secret) ---------------------
  if (req.method === 'POST' && action === 'refresh') {
    const auth = authorizeRefresh(req);
    if (!auth.ok) {
      return res.status(401).json({ ok: false, error: 'unauthorized', message: 'Owner sign-in or ingestion cron secret required to refresh providers.' });
    }
    const g = globalThis;
    const last = g.__AGRI_INGEST_LAST_REFRESH__ || 0;
    if (Date.now() - last < REFRESH_COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: 'cooldown', retryAfterMs: REFRESH_COOLDOWN_MS - (Date.now() - last) });
    }
    g.__AGRI_INGEST_LAST_REFRESH__ = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    const result = await safeCollect(Object.assign({}, deps, { force: true }));
    recordRuns(result.runs);
    const persist = await persistRuns(result);
    return res.status(200).json(Object.assign({ ok: result.ok, via: auth.via, persist }, publicView(result)));
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // ---- health roll-up (lightweight) --------------------------------------
  if (view === 'health') {
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    const result = await safeCollect(deps);
    return res.status(200).json({ ok: result.ok, asOf: result.asOf, providers: result.providers, summary: result.summary });
  }

  // ---- default: full catalog + recent runs -------------------------------
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  const result = await safeCollect(deps);
  recordRuns(result.runs);
  const { runs } = await loadRuns(20);
  return res.status(200).json(Object.assign({ ok: result.ok }, publicView(result), { runs }));
}

// Collect but never let an internal error escape to the client.
async function safeCollect(deps) {
  try {
    return await collectCatalog(deps);
  } catch (_) {
    return {
      ok: false, asOf: new Date().toISOString(), adapterVersion: CATALOG_ADAPTER_VERSION,
      providers: [], contracts: [], runs: [],
      summary: { total: 0, byState: {}, live: 0, available: 0 },
    };
  }
}

function publicView(result) {
  return {
    asOf: result.asOf,
    adapterVersion: result.adapterVersion,
    providers: result.providers,
    contracts: result.contracts,
    summary: result.summary,
  };
}
