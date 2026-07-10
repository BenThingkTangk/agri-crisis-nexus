// AgriOS live-feed smoke test — hits every real public source once and reports
// its status. Unlike tests/run.js (deterministic, fixture-based, no network),
// this makes real network calls and is NOT part of `npm test`. Run manually:
//
//   node tests/smoke.js
//
// Classifies each source as:
//   LIVE     — returned >=1 normalized event
//   EMPTY    — reachable + parsed but yielded 0 events (structurally fine)
//   DISABLED — opted out (e.g. missing free registration appname)
//   BLOCKED  — network/HTTP/parse failure (endpoint unreachable or changed)
//
// Requires Node 18+ (global fetch). Honors RELIEFWEB_APPNAME if set.

import { ADAPTERS } from '../api/_adapters.js';
import { SOURCES, normalizeEvent, isValidEvent } from '../api/_sources.js';

const TIMEOUT = 12000;

async function run(entry) {
  const meta = SOURCES[entry.id] || { id: entry.id, name: entry.id };
  const t0 = Date.now();
  try {
    const raw = await entry.run({ fetchImpl: globalThis.fetch, now: new Date(), env: process.env, timeoutMs: TIMEOUT });
    const events = (Array.isArray(raw) ? raw : [])
      .map((r) => normalizeEvent(r, { sourceId: entry.id, fetchedAt: new Date().toISOString() }))
      .filter(isValidEvent);
    const ms = Date.now() - t0;
    const status = events.length ? 'LIVE' : 'EMPTY';
    return { id: entry.id, name: meta.name, domain: meta.domain, status, count: events.length, ms, sample: events[0] && events[0].title };
  } catch (err) {
    const ms = Date.now() - t0;
    if (err && err.disabled) return { id: entry.id, name: meta.name, domain: meta.domain, status: 'DISABLED', count: 0, ms, note: String(err.message || '').slice(0, 80) };
    return { id: entry.id, name: meta.name, domain: meta.domain, status: 'BLOCKED', count: 0, ms, note: String(err && (err.message || err)).slice(0, 80) };
  }
}

(async function main() {
  if (typeof globalThis.fetch !== 'function') {
    console.error('This smoke test requires Node 18+ (global fetch).');
    process.exit(2);
  }
  console.log('AgriOS live-feed smoke test — ' + new Date().toISOString());
  console.log('RELIEFWEB_APPNAME: ' + (process.env.RELIEFWEB_APPNAME ? 'set' : 'unset (reliefweb will be DISABLED)'));
  console.log('');
  const results = await Promise.all(ADAPTERS.map(run));
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  results.forEach((r) => {
    console.log(pad(r.status, 9) + pad(r.name, 16) + pad(r.domain, 14) +
      pad(r.count + ' evt', 9) + pad(r.ms + 'ms', 8) + (r.sample ? '· ' + r.sample : (r.note ? '· ' + r.note : '')));
  });
  const tally = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  console.log('\nSummary: ' + Object.keys(tally).map((k) => k + '=' + tally[k]).join('  '));
  process.exit(0);
})();
