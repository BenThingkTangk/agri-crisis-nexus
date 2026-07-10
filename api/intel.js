// Unified live-intelligence endpoint for AGRI-NEXUS.
//
//   GET  /api/intel                 -> normalized aggregate events + source health + summary
//   GET  /api/intel?view=health     -> source health only (lightweight)
//   GET  /api/intel?view=snapshots  -> recent in-memory aggregate snapshots (no DB)
//   POST /api/intel?action=refresh  -> force a cache-busting re-aggregate (auth required)
//   GET  /api/intel?domain=hazard   -> aggregate filtered to a single domain
//
// Never throws to the client: always 200 with whatever succeeded and a per-source
// health block. If everything fails the client shows DEGRADED / BUNDLED INTEL.

import { aggregate, recordSnapshot, getSnapshots } from './_aggregate.js';
import { SOURCES } from './_sources.js';

async function tryResolveAuth(req) {
  // Auth is DB-backed; if the DB is unavailable we treat the caller as
  // unauthenticated rather than 500. Import lazily so a keyless deploy that
  // never calls refresh does not require the DB module at all.
  try {
    const { resolveAuth } = await import('./_auth.js');
    return await resolveAuth(req);
  } catch (_) {
    return null;
  }
}

function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const src = req.headers.origin || req.headers.referer;
  if (!host || !src) return false;
  try { return new URL(src).host === host; } catch (_) { return false; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, 'http://localhost');
  const view = url.searchParams.get('view');
  const domain = url.searchParams.get('domain');
  const action = url.searchParams.get('action');

  // ---- source health (static registry + last aggregate) --------------------
  if (req.method === 'GET' && view === 'health') {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    const agg = await safeAggregate({});
    return res.status(200).json({ ok: agg.ok, status: agg.status, asOf: agg.asOf, sources: agg.sources, summary: agg.summary });
  }

  // ---- snapshots (bounded in-memory history) -------------------------------
  if (req.method === 'GET' && view === 'snapshots') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, snapshots: getSnapshots(), note: 'In-memory ring; resets on cold start. No database migration.' });
  }

  // ---- manual refresh (authenticated + same-origin) ------------------------
  if (req.method === 'POST' && action === 'refresh') {
    if (!sameOrigin(req)) return res.status(403).json({ ok: false, error: 'bad_origin' });
    const ctx = await tryResolveAuth(req);
    if (!ctx) return res.status(401).json({ ok: false, error: 'unauthenticated', message: 'Sign in to refresh live intelligence.' });
    res.setHeader('Cache-Control', 'no-store');
    const agg = await safeAggregate({ force: true });
    recordSnapshot(agg);
    return res.status(200).json(filterDomain(agg, null));
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  // ---- default: full aggregate --------------------------------------------
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  const agg = await safeAggregate({});
  recordSnapshot(agg);
  return res.status(200).json(filterDomain(agg, domain));
}

// Aggregate but never let an internal error escape to the client.
async function safeAggregate(opts) {
  try {
    return await aggregate(Object.assign({ fetchImpl: globalThis.fetch }, opts));
  } catch (err) {
    const sources = Object.values(SOURCES).map((s) => ({
      id: s.id, name: s.name, domain: s.domain, keyless: !!s.keyless,
      status: 'down', count: 0, fetchedAt: new Date().toISOString(),
    }));
    return {
      ok: false, status: 'degraded', asOf: new Date().toISOString(),
      sources, events: [],
      summary: { total: 0, observed: 0, modeled: 0, byDomain: {}, bySeverity: { stable: 0, moderate: 0, high: 0, critical: 0 }, sourcesOk: 0, sourcesTotal: sources.length },
    };
  }
}

function filterDomain(agg, domain) {
  if (!domain) return agg;
  const events = agg.events.filter((e) => e.domain === domain);
  return Object.assign({}, agg, { events });
}
