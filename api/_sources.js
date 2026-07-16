// Ingestion pipeline core for AGRI-NEXUS live-data fusion.
//
// Pure, dependency-free, server-side primitives shared by every source adapter
// and by the /api/intel endpoint. Nothing here touches the network on import;
// fetch is always injected so the whole layer is deterministically testable.
//
// Responsibilities:
//   - a single normalized event/indicator schema (normalizeEvent)
//   - deterministic severity mapping (severityFromLevel / severityFromScale)
//   - dedupe (native id + cross-source spatiotemporal collapse)
//   - resilient fetch (per-call timeout + response-size guard)
//   - retry with exponential backoff, honoring an injectable sleeper
//   - bounded concurrency (mapLimit)
//   - a per-source circuit breaker (closed/open/half-open) with health state
//   - a stale-while-revalidate cache with last-known-good fallback
//   - the normalized source registry (SOURCES) with license/provenance metadata
//
// All caches and breaker state live on globalThis so they persist across warm
// serverless invocations but reset cleanly on a cold start (documented, bounded).

// ---------------------------------------------------------------------------
// Severity model — deterministic, ordered, colour-coded downstream.
// ---------------------------------------------------------------------------
export const SEVERITY_LEVELS = ['stable', 'moderate', 'high', 'critical'];
const SEVERITY_SCORE = { stable: 0.2, moderate: 0.45, high: 0.7, critical: 0.95 };

// Map a free-text alert word (red/orange/famine/warning/…) to a level.
// Deterministic: same input always yields the same level.
export function severityFromLevel(word) {
  const w = String(word == null ? '' : word).toLowerCase();
  if (/famine|catastroph|critical|severe|extreme|major|red\b/.test(w)) return 'critical';
  if (/emergency|high|significant|orange|danger/.test(w)) return 'high';
  if (/warning|moderate|watch|yellow|elevated|alert/.test(w)) return 'moderate';
  if (/stable|normal|green|low|minor|none/.test(w)) return 'stable';
  return 'moderate';
}

// Map a numeric magnitude to a level via ascending thresholds
// [moderate, high, critical]. Below the first threshold => 'stable'.
export function severityFromScale(value, thresholds) {
  const v = Number(value);
  const t = Array.isArray(thresholds) ? thresholds : [];
  if (!Number.isFinite(v)) return 'moderate';
  if (t.length >= 3 && v >= t[2]) return 'critical';
  if (t.length >= 2 && v >= t[1]) return 'high';
  if (t.length >= 1 && v >= t[0]) return 'moderate';
  return 'stable';
}

export function severityScore(level) {
  return SEVERITY_SCORE[level] != null ? SEVERITY_SCORE[level] : 0.45;
}

// ---------------------------------------------------------------------------
// Source registry — provenance, license, and enablement for each adapter.
// `env` names are suggested identifiers only (no secrets). `keyless: true`
// means the adapter runs now with no credential.
// ---------------------------------------------------------------------------
export const SOURCES = {
  gdacs: {
    id: 'gdacs', name: 'GDACS', domain: 'hazard', keyless: true, env: null,
    homepage: 'https://www.gdacs.org',
    license: 'Public domain (syndication with attribution)',
  },
  usgs: {
    id: 'usgs', name: 'USGS', domain: 'hazard', keyless: true, env: null,
    homepage: 'https://earthquake.usgs.gov/fdsnws/event/1/',
    license: 'Public domain (US Gov)',
  },
  eonet: {
    id: 'eonet', name: 'NASA EONET', domain: 'hazard', keyless: true, env: null,
    homepage: 'https://eonet.gsfc.nasa.gov/docs/v3',
    license: 'NASA open data',
  },
  openmeteo: {
    id: 'openmeteo', name: 'Open-Meteo', domain: 'weather', keyless: true, env: 'OPEN_METEO_API_KEY',
    homepage: 'https://open-meteo.com/en/docs',
    license: 'Free for non-commercial; commercial requires key',
  },
  power: {
    id: 'power', name: 'NASA POWER', domain: 'weather', keyless: true, env: null,
    homepage: 'https://power.larc.nasa.gov/docs/services/api/temporal/daily/',
    license: 'NASA open data',
  },
  worldbank: {
    id: 'worldbank', name: 'World Bank', domain: 'market', keyless: true, env: null,
    homepage: 'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation',
    license: 'CC-BY-4.0 (World Bank terms)',
  },
  faostat: {
    id: 'faostat', name: 'FAOSTAT', domain: 'market', keyless: true, env: null,
    homepage: 'https://fenixservices.fao.org/faostat/api/v1/en/',
    license: 'CC-BY-4.0',
  },
  reliefweb: {
    id: 'reliefweb', name: 'ReliefWeb', domain: 'humanitarian', keyless: true, env: 'RELIEFWEB_APPNAME',
    homepage: 'https://reliefweb.int/help/api',
    license: 'Open (respect source copyright); appname requested',
  },
  gdelt: {
    id: 'gdelt', name: 'GDELT', domain: 'conflict', keyless: true, env: null,
    homepage: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
    license: 'GDELT terms (fair use)',
  },
  portwatch: {
    id: 'portwatch', name: 'IMF PortWatch', domain: 'logistics', keyless: true, env: null,
    homepage: 'https://portwatch.imf.org/',
    license: 'IMF / UN Global Platform (public)',
  },
  nass: {
    id: 'nass', name: 'USDA NASS', domain: 'market', keyless: false, env: 'USDA_NASS_API_KEY',
    homepage: 'https://quickstats.nass.usda.gov/',
    license: 'Public domain (US Gov, USDA NASS Quick Stats)',
  },
  firms: {
    id: 'firms', name: 'NASA FIRMS', domain: 'hazard', keyless: false, env: 'FIRMS_MAP_KEY',
    homepage: 'https://firms.modaps.eosdis.nasa.gov/',
    license: 'NASA open data (LANCE/FIRMS; attribution requested)',
  },
  faspsd: {
    id: 'faspsd', name: 'USDA FAS PSD', domain: 'market', keyless: false, env: 'USDA_FAS_API_KEY',
    homepage: 'https://apps.fas.usda.gov/psdonline/',
    license: 'Public domain (US Gov, USDA FAS PSD Online)',
  },
  hungermap: {
    id: 'hungermap', name: 'WFP HungerMap LIVE', domain: 'humanitarian', keyless: true, env: null,
    homepage: 'https://hungermap.wfp.org/',
    license: 'WFP (attribution; see HungerMap terms)',
  },
  unhcr: {
    id: 'unhcr', name: 'UNHCR Refugee Statistics', domain: 'humanitarian', keyless: true, env: null,
    homepage: 'https://www.unhcr.org/refugee-statistics/',
    license: 'UNHCR open data (attribution)',
  },
  overpass: {
    id: 'overpass', name: 'OpenStreetMap Overpass', domain: 'logistics', keyless: true, env: null,
    homepage: 'https://www.openstreetmap.org/',
    license: 'ODbL 1.0 (© OpenStreetMap contributors)',
  },
};

// ---------------------------------------------------------------------------
// Missing-data sentinels. Upstream feeds encode "no observation" as documented
// fill values rather than null — NASA POWER uses -999; others commonly use
// -9999 / 9999 / 99999. These are NOT measurements and must never be surfaced
// as telemetry (e.g. "mean temp -999°C"). isFillValue also rejects any
// non-finite input (NaN / Infinity / non-numeric).
// ---------------------------------------------------------------------------
export const FILL_SENTINELS = [-999, -999.9, -9999, -99999, 9999, 99999, 999999];

export function isFillValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return true;
  return FILL_SENTINELS.indexOf(n) !== -1;
}

// ---------------------------------------------------------------------------
// Normalized event/indicator schema.
// ---------------------------------------------------------------------------
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function cleanValue(v) { return isFillValue(v) ? null : num(v); }
function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; }
function isoOrNull(v) { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }

// Produce a single normalized record. `meta.sourceId` must be a key in SOURCES.
// Missing fields degrade to null rather than throwing; callers filter invalids.
export function normalizeEvent(raw, meta) {
  const src = SOURCES[meta && meta.sourceId] || null;
  const fetchedAt = (meta && meta.fetchedAt) || new Date().toISOString();
  const level = raw.severity && SEVERITY_LEVELS.indexOf(raw.severity) >= 0
    ? raw.severity
    : severityFromLevel(raw.severity);
  const rawId = String(raw.rawId != null ? raw.rawId : (raw.id != null ? raw.id : ''));
  const sourceUrl = raw.sourceUrl || (src ? src.homepage : null);
  return {
    id: (src ? src.id : (meta && meta.sourceId) || 'src') + ':' + rawId,
    source: src ? src.name : (raw.source || 'Unknown'),
    sourceId: src ? src.id : (meta && meta.sourceId) || null,
    rawId,
    domain: raw.domain || (src ? src.domain : 'other'),
    category: raw.category || 'Event',
    title: raw.title || raw.category || 'Event',
    geography: raw.geography || 'Global',
    lat: num(raw.lat),
    lon: num(raw.lon != null ? raw.lon : raw.lng),
    observedAt: isoOrNull(raw.observedAt || raw.published) || fetchedAt,
    fetchedAt,
    severity: level,
    severityScore: severityScore(level),
    confidence: clamp01(raw.confidence != null ? raw.confidence : (src ? 0.8 : 0.5)),
    value: cleanValue(raw.value),
    unit: raw.unit || null,
    evidence: raw.evidence === 'modeled' ? 'modeled' : 'observed',
    sourceUrl,
    license: raw.license || (src ? src.license : 'Unknown'),
    provenance: {
      source: src ? src.name : (raw.source || 'Unknown'),
      sourceUrl,
      license: raw.license || (src ? src.license : 'Unknown'),
      retrievedAt: fetchedAt,
    },
  };
}

// A record is renderable/valid if it has an id, a known severity, and either a
// coordinate pair in range or an explicit non-geo indicator (geography label).
export function isValidEvent(e) {
  if (!e || !e.id || SEVERITY_LEVELS.indexOf(e.severity) < 0) return false;
  if (e.lat != null || e.lon != null) {
    if (!(e.lat >= -90 && e.lat <= 90 && e.lon >= -180 && e.lon <= 180)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Dedupe — first by stable id, then collapse cross-source near-duplicates that
// describe the same real-world event (same domain, ~same place within a day).
// Deterministic: keeps the highest-confidence record for each cluster.
// ---------------------------------------------------------------------------
export function dedupeEvents(events) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  const unique = Array.from(byId.values());

  const clusters = new Map();
  const out = [];
  for (const e of unique) {
    if (e.lat == null || e.lon == null) { out.push(e); continue; }
    const day = (e.observedAt || '').slice(0, 10);
    const key = e.domain + '|' + day + '|' + e.lat.toFixed(1) + '|' + e.lon.toFixed(1);
    const prev = clusters.get(key);
    if (!prev) { clusters.set(key, e); }
    else if (e.confidence > prev.confidence) { clusters.set(key, e); }
  }
  for (const e of clusters.values()) out.push(e);
  return out;
}

// ---------------------------------------------------------------------------
// Resilient fetch with timeout + response-size guard. Never returns a partial
// body over the cap. fetchImpl is injectable for tests.
// ---------------------------------------------------------------------------
export async function fetchText(url, opts = {}) {
  const {
    timeoutMs = 5000,
    maxBytes = 3_000_000,
    fetchImpl = globalThis.fetch,
    method = 'GET',
    headers = {},
    body = undefined,
  } = opts;
  if (typeof fetchImpl !== 'function') throw new Error('no fetch available');
  const ctrl = new AbortController();
  let timer;
  // Race the request against a hard timer. We both signal AbortController (so a
  // well-behaved fetch cancels its socket) AND reject the race — this guarantees
  // the timeout even if the underlying fetch ignores the abort signal or hangs
  // before returning headers.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { ctrl.abort(); } catch (_) { /* ignore */ }
      const e = new Error('request aborted (timeout ' + timeoutMs + 'ms)');
      e.timeout = true;
      reject(e);
    }, timeoutMs);
  });
  const req = Promise.resolve(fetchImpl(url, { method, headers, body, signal: ctrl.signal }));
  req.catch(() => {}); // if the timer wins the race, ignore the abandoned request's late rejection
  try {
    const r = await Promise.race([req, timeout]);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const len = Number(r.headers && r.headers.get && r.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) throw new Error('response too large');
    const text = await r.text();
    if (text.length > maxBytes) throw new Error('response too large');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJSON(url, opts = {}) {
  const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
  const text = await fetchText(url, Object.assign({}, opts, { headers }));
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff. sleep is injectable so tests run instantly.
// ---------------------------------------------------------------------------
const realSleep = (ms) => new Promise((res) => setTimeout(res, ms));

export async function withRetry(fn, opts = {}) {
  const { retries = 2, baseDelayMs = 200, sleep = realSleep } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(baseDelayMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Hard wall-clock deadline. Races a promise against a timer that rejects with a
// `.timeout` error, guaranteeing the caller can never block longer than `ms`
// regardless of how the underlying work (fetch, retries, fan-out) behaves. The
// underlying promise is not cancellable, so we swallow any late rejection to
// avoid an unhandledRejection after the deadline has already fired.
// ---------------------------------------------------------------------------
export function withDeadline(promise, ms, label) {
  let timer;
  const p = Promise.resolve(promise);
  p.catch(() => {}); // late rejection after the deadline is expected; ignore it
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error((label || 'operation') + ' deadline exceeded (' + ms + 'ms)');
      e.timeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Bounded concurrency map. Preserves input order in the results array.
// ---------------------------------------------------------------------------
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Circuit breaker — isolates a flapping source so it cannot stall the aggregate
// or hammer a failing endpoint. States: closed -> open (after N fails) ->
// half-open (after cooldown) -> closed on success.
// ---------------------------------------------------------------------------
const BREAKERS = globalThis.__AGRI_BREAKERS__ || (globalThis.__AGRI_BREAKERS__ = new Map());

export function getBreaker(id, opts = {}) {
  const { threshold = 3, cooldownMs = 60_000 } = opts;
  let b = BREAKERS.get(id);
  if (!b) { b = { id, failures: 0, state: 'closed', openedAt: 0, threshold, cooldownMs }; BREAKERS.set(id, b); }
  return b;
}

// Returns true if a call should be allowed right now.
export function breakerAllows(id, now = Date.now()) {
  const b = getBreaker(id);
  if (b.state === 'open') {
    if (now - b.openedAt >= b.cooldownMs) { b.state = 'half-open'; return true; }
    return false;
  }
  return true;
}

export function breakerSuccess(id) {
  const b = getBreaker(id);
  b.failures = 0; b.state = 'closed'; b.openedAt = 0;
}

export function breakerFailure(id, now = Date.now()) {
  const b = getBreaker(id);
  b.failures += 1;
  if (b.failures >= b.threshold) { b.state = 'open'; b.openedAt = now; }
}

export function resetBreakers() { BREAKERS.clear(); }

// ---------------------------------------------------------------------------
// Stale-while-revalidate cache + last-known-good. Bounded by entry count.
// ---------------------------------------------------------------------------
const CACHE = globalThis.__AGRI_SRC_CACHE__ || (globalThis.__AGRI_SRC_CACHE__ = new Map());
const CACHE_MAX = 64;

export function cacheGet(key, ttlMs, now = Date.now()) {
  const rec = CACHE.get(key);
  if (!rec) return { hit: false, fresh: false, value: null };
  const fresh = now - rec.storedAt < ttlMs;
  return { hit: true, fresh, value: rec.value, storedAt: rec.storedAt };
}

export function cacheSet(key, value, now = Date.now()) {
  if (CACHE.size >= CACHE_MAX && !CACHE.has(key)) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, { value, storedAt: now });
}

export function cacheClear() { CACHE.clear(); }

// ---------------------------------------------------------------------------
// Aggregate status from per-source health rows.
// ---------------------------------------------------------------------------
export function aggregateStatus(sources) {
  const total = sources.length;
  if (!total) return 'degraded';
  const ok = sources.filter((s) => s.status === 'ok').length;
  const stale = sources.filter((s) => s.status === 'stale').length;
  if (ok === total) return 'live';
  if (ok === 0 && stale === 0) return 'degraded';
  if (ok === 0 && stale > 0) return 'stale';
  return 'partial';
}
