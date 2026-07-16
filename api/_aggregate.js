// Aggregation orchestrator: runs every adapter under the resilience primitives
// (timeout, retry/backoff, circuit breaker, stale-while-revalidate cache,
// last-known-good fallback, bounded concurrency), then normalizes, validates,
// dedupes and summarizes. One bad source never fails the aggregate.
//
// Pure w.r.t. the network: fetchImpl is injected all the way down, so this is
// exercised deterministically in tests with fixture adapters.

import {
  SOURCES, normalizeEvent, isValidEvent, dedupeEvents, aggregateStatus,
  withRetry, withDeadline, mapLimit, breakerAllows, breakerSuccess, breakerFailure,
  cacheGet, cacheSet,
} from './_sources.js';
import { ADAPTERS } from './_adapters.js';

// Hard wall-clock ceiling for a single adapter, retries and fan-out included.
// Serverless routes have a short total budget, so no one upstream may exceed
// this — a slow/hanging source is abandoned (status `timeout`) rather than
// stalling the whole /api/intel response. Overridable per-adapter (entry.deadlineMs)
// or per-call (deps.adapterDeadlineMs).
const ADAPTER_DEADLINE_MS = 3000;

// Run a single adapter with full resilience. Returns a health row plus events.
async function runSource(entry, deps) {
  const { fetchImpl, now = Date.now(), env = process.env, force = false, sleep } = deps;
  const meta = SOURCES[entry.id] || { id: entry.id, name: entry.id };
  const cacheKey = 'src:' + entry.id;
  const fetchedAt = new Date(now).toISOString();

  // Serve fresh cache unless a forced refresh was requested.
  if (!force) {
    const c = cacheGet(cacheKey, entry.ttlMs, now);
    if (c.hit && c.fresh) {
      return { source: healthRow(meta, 'ok', c.value.length, fetchedAt, { cached: true }), events: c.value };
    }
  }

  // Circuit breaker: if open, skip the call and use last-known-good.
  if (!breakerAllows(entry.id, now)) {
    const c = cacheGet(cacheKey, Infinity, now);
    const events = (c.hit && c.value) || [];
    return { source: healthRow(meta, events.length ? 'stale' : 'down', events.length, fetchedAt, { circuit: 'open' }), events };
  }

  const deadlineMs = entry.deadlineMs || deps.adapterDeadlineMs || ADAPTER_DEADLINE_MS;
  try {
    const raw = await withDeadline(
      withRetry(
        () => entry.run({ fetchImpl, now: new Date(now), env, timeoutMs: entry.timeoutMs }),
        { retries: 1, baseDelayMs: 150, sleep }
      ),
      deadlineMs,
      entry.id
    );
    const events = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeEvent(r, { sourceId: entry.id, fetchedAt }))
      .filter(isValidEvent);
    breakerSuccess(entry.id);
    cacheSet(cacheKey, events, now);
    return { source: healthRow(meta, 'ok', events.length, fetchedAt, {}), events };
  } catch (err) {
    // A source that opted out (missing free registration) is 'disabled', not a
    // failure — it must not trip the breaker or degrade the aggregate status.
    if (err && err.disabled) {
      return { source: healthRow(meta, 'disabled', 0, fetchedAt, { reason: safeMsg(err) }), events: [] };
    }
    breakerFailure(entry.id, now);
    // Fall back to last-known-good if we have it.
    const c = cacheGet(cacheKey, Infinity, now);
    if (c.hit && c.value && c.value.length) {
      return { source: healthRow(meta, 'stale', c.value.length, fetchedAt, { error: safeMsg(err) }), events: c.value };
    }
    // No cache: surface a distinct `timeout` state for a blown deadline so the
    // UI can say "timed out" rather than mislabeling a reachable source.
    const status = (err && err.timeout) ? 'timeout' : 'down';
    return { source: healthRow(meta, status, 0, fetchedAt, { error: safeMsg(err) }), events: [] };
  }
}

function healthRow(meta, status, count, fetchedAt, extra) {
  return Object.assign({
    id: meta.id, name: meta.name, domain: meta.domain,
    keyless: !!meta.keyless, env: meta.env || null,
    license: meta.license || null, homepage: meta.homepage || null,
    status, count, fetchedAt,
  }, extra || {});
}

function safeMsg(err) {
  const m = err && (err.message || String(err));
  return String(m || 'unavailable').slice(0, 120);
}

// Run the whole pipeline. deps: { fetchImpl, now, env, adapters?, concurrency?,
// force?, sleep? }. Returns { status, asOf, sources, events, summary }.
export async function aggregate(deps = {}) {
  const adapters = deps.adapters || ADAPTERS;
  const now = deps.now || Date.now();
  // Run wide: every adapter is independently deadline-capped, so the whole
  // aggregate settles in ~ceil(adapters/concurrency) * ADAPTER_DEADLINE_MS worst
  // case. Higher concurrency keeps that product comfortably under the route budget.
  const concurrency = deps.concurrency || 8;
  const results = await mapLimit(adapters, concurrency, (entry) => runSource(entry, Object.assign({}, deps, { now })));

  const sources = results.map((r) => r.source);
  let events = [];
  results.forEach((r) => { events = events.concat(r.events); });
  events = dedupeEvents(events);
  events.sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt));

  const summary = summarize(events, sources);
  // Aggregate status ignores 'disabled' sources (they are opt-in, not failures).
  const active = sources.filter((s) => s.status !== 'disabled');
  const status = aggregateStatus(active);

  return { ok: summary.total > 0, status, asOf: new Date(now).toISOString(), sources, events, summary };
}

function summarize(events, sources) {
  const byDomain = {};
  const bySeverity = { stable: 0, moderate: 0, high: 0, critical: 0 };
  let observed = 0, modeled = 0;
  events.forEach((e) => {
    byDomain[e.domain] = (byDomain[e.domain] || 0) + 1;
    if (bySeverity[e.severity] != null) bySeverity[e.severity] += 1;
    if (e.evidence === 'modeled') modeled += 1; else observed += 1;
  });
  return {
    total: events.length,
    observed, modeled,
    byDomain, bySeverity,
    sourcesOk: sources.filter((s) => s.status === 'ok').length,
    sourcesStale: sources.filter((s) => s.status === 'stale').length,
    sourcesDown: sources.filter((s) => s.status === 'down').length,
    sourcesDisabled: sources.filter((s) => s.status === 'disabled').length,
    sourcesTotal: sources.length,
  };
}

// --------------------------------------------------------------- snapshots ---
// Bounded in-memory ring of recent aggregate summaries. No database migration:
// this is a warm-container history that resets on cold start (documented).
const SNAPS = globalThis.__AGRI_SNAPS__ || (globalThis.__AGRI_SNAPS__ = []);
const SNAP_MAX = 48;

export function recordSnapshot(agg) {
  SNAPS.push({
    asOf: agg.asOf,
    status: agg.status,
    total: agg.summary.total,
    bySeverity: agg.summary.bySeverity,
    byDomain: agg.summary.byDomain,
    sourcesOk: agg.summary.sourcesOk,
    sourcesTotal: agg.summary.sourcesTotal,
  });
  while (SNAPS.length > SNAP_MAX) SNAPS.shift();
}

export function getSnapshots() { return SNAPS.slice(); }
export function clearSnapshots() { SNAPS.length = 0; }
