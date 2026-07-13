// Phase VI — server-side agricultural CATALOG/COVERAGE ingestion for AGRI-NEXUS.
//
// This layer turns the Earth Theater "registry-ready" placeholders (NASA
// Earthdata, Copernicus, FAO WaPOR/AQUASTAT, WRI Aqueduct) into a truthful,
// resilient, server-side discovery pipeline.
//
// CARDINAL HONESTY RULE — these providers deliver heavy rasters / async
// extraction jobs, NOT lightweight point telemetry. We therefore DO NOT
// fabricate scalar values. Instead each layer resolves to a LAYER CONTRACT that
// truthfully states what is available right now: catalog metadata, coverage
// (spatial bbox + temporal interval), the newest granule/dataset, freshness,
// auth mode, and a precise machine state. The map renders only genuinely
// available data; everything else is shown as disabled/ready with an exact
// explanation.
//
// SECRET HANDLING (mirrors the USDA NASS adapter template):
//   - EARTHDATA_TOKEN / COPERNICUS_TOKEN are read ONLY from env, server-side.
//   - A token is placed SOLELY in an outbound `Authorization: Bearer` header.
//   - It NEVER appears in any emitted record, provenance, sourceUrl, cache key,
//     ledger row, or error message. Thrown errors carry only generic text
//     (fetchText throws `HTTP <status>`); redactError() strips any token-shaped
//     substring defensively as a second line of defence.
//
// Pure w.r.t. the network: fetchImpl is injected all the way down, so every
// adapter and the whole state machine are deterministically unit-testable
// against saved fixtures with no network and no credentials.

import {
  fetchJSON, withRetry, mapLimit,
  breakerAllows, breakerSuccess, breakerFailure,
  cacheGet, cacheSet,
} from './_sources.js';

// Bump when the wire contract of any adapter changes; recorded in the run ledger.
export const CATALOG_ADAPTER_VERSION = '6.0.0';

// ---------------------------------------------------------------------------
// Layer-contract state machine. Ordered loosely best -> worst for summaries.
// ---------------------------------------------------------------------------
export const CATALOG_STATES = [
  'LIVE',            // catalog reachable AND a dataset/granule within freshness window
  'PUBLIC_FALLBACK', // token absent but public discovery succeeded (degraded, honest)
  'CATALOG_ONLY',    // metadata/coverage reachable; data is heavy raster/tiles, no live stream
  'HEAVY_JOB_READY', // requires an authenticated async extraction job (e.g. CDS ERA5)
  'NO_RECENT_GRANULE', // catalog reachable but newest granule older than threshold
  'AUTH_REQUIRED',   // needs a credential we do not have and no public fallback suffices
  'RATE_LIMITED',    // upstream returned HTTP 429
  'UPSTREAM_ERROR',  // 5xx / timeout / network / parse failure
  'STALE',           // served from last-known-good cache after a failure
  'DISABLED',        // switched off
];

// Freshness thresholds (hours) per cadence bucket. Beyond this a LIVE granule
// is downgraded to NO_RECENT_GRANULE.
const FRESHNESS_HOURS = {
  daily: 72,          // allow ~3 days for NRT satellite latency
  'half-hourly': 12,
  dekadal: 24 * 20,   // ~20 days for a 10-day product
  monthly: 24 * 60,
  periodic: 24 * 400, // annual/periodic catalogs
};

// ---------------------------------------------------------------------------
// Providers. `tokenEnv` names the credential (NAME only, never a value). A
// provider with tokenEnv:null is fully keyless-public.
// ---------------------------------------------------------------------------
export const PROVIDERS = {
  'nasa-cmr': {
    id: 'nasa-cmr', name: 'NASA Earthdata (CMR)', tokenEnv: 'EARTHDATA_TOKEN',
    homepage: 'https://cmr.earthdata.nasa.gov/',
    license: 'NASA open data (Earthdata)',
    publicFallback: true, // CMR search is public; token raises limits / unlocks restricted sets
  },
  copernicus: {
    id: 'copernicus', name: 'Copernicus Data Space / CDS', tokenEnv: 'COPERNICUS_TOKEN',
    homepage: 'https://dataspace.copernicus.eu/',
    license: 'Copernicus open data (attribution)',
    publicFallback: true, // STAC catalogue is public; CDS ERA5 extraction needs the token
  },
  'fao-wapor': {
    id: 'fao-wapor', name: 'FAO WaPOR / AQUASTAT', tokenEnv: null,
    homepage: 'https://data.apps.fao.org/wapor/',
    license: 'FAO open data (CC-BY-4.0)',
    publicFallback: true,
  },
  'wri-aqueduct': {
    id: 'wri-aqueduct', name: 'WRI Aqueduct (Resource Watch / ArcGIS)', tokenEnv: null,
    homepage: 'https://www.wri.org/aqueduct',
    license: 'WRI Aqueduct (CC-BY-4.0)',
    publicFallback: true,
  },
};

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function isoOrNull(v) { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
function ageHours(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

// Parse a CMR "boxes" string ("s w n e") into a [w,s,e,n] bbox.
export function parseCmrBox(boxes) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const parts = String(boxes[0]).trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [s, w, n, e] = parts;
  if (s < -90 || n > 90 || w < -180 || e > 180) return null;
  return [w, s, e, n];
}

// Redact anything token-shaped from an error/log string. Defence-in-depth: our
// messages never contain the token, but a future refactor could regress, so we
// strip Bearer blobs, key=/token= query params, and long opaque hex/JWT blobs.
export function redactError(input) {
  let s = String(input == null ? '' : (input && input.message) || input);
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/([?&](?:key|token|access[_-]?token|apikey|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9._-]{20,}/g, '[REDACTED-JWT]'); // JWT-looking blobs
  s = s.replace(/\b[A-Fa-f0-9]{40,}\b/g, '[REDACTED]');         // long hex secrets
  return s.slice(0, 160);
}

// Classify a fetch/parse error into a coarse HTTP category for the state machine
// and the run ledger, without leaking specifics.
export function classifyError(err) {
  const m = String((err && err.message) || err || '');
  if (/HTTP 429/.test(m)) return 'rate_limit';
  if (/HTTP 401|HTTP 403/.test(m)) return 'auth';
  if (/HTTP 5\d\d/.test(m)) return 'server';
  if (/HTTP 4\d\d/.test(m)) return 'client';
  if (/abort|timeout|too large/i.test(m)) return 'timeout';
  return 'network';
}

// Resolve auth mode for a provider WITHOUT exposing the value. Returns
// 'authenticated' when the token env is present+non-blank, 'public' when the
// provider degrades to keyless discovery, 'none' when keyless by design.
export function resolveAuthMode(providerId, env) {
  const p = PROVIDERS[providerId];
  if (!p) return 'none';
  if (!p.tokenEnv) return 'none';
  const raw = env && env[p.tokenEnv] != null ? env[p.tokenEnv] : undefined;
  const present = typeof raw === 'string' && raw.trim().length > 0;
  if (present) return 'authenticated';
  return p.publicFallback ? 'public' : 'unauthenticated';
}

// Build the outbound headers for a provider, injecting the bearer token ONLY
// when authenticated. The returned object is used for the request only and is
// never persisted.
function authHeaders(providerId, env) {
  const p = PROVIDERS[providerId];
  if (!p || !p.tokenEnv) return {};
  const raw = env && env[p.tokenEnv] != null ? String(env[p.tokenEnv]) : '';
  const tok = raw.trim();
  if (!tok) return {};
  return { authorization: 'Bearer ' + tok };
}

// ---------------------------------------------------------------------------
// LAYER CONTRACTS — the agricultural surfaces the Earth Theater can offer.
// Each carries the provider, product identity, cadence, domain, a public
// sourceUrl, and a `probe(deps)` that performs the real catalog/coverage
// discovery and returns a partial contract (never throws for "no data"; throws
// only on transport errors so the breaker/state machine can react).
// ---------------------------------------------------------------------------

// ---- NASA CMR generic probe (collections + newest granule) ---------------
function cmrProbe(query) {
  return async function ({ fetchImpl, env, timeoutMs = 8000 }) {
    const base = 'https://cmr.earthdata.nasa.gov/search';
    const headers = authHeaders('nasa-cmr', env);
    const qp = new URLSearchParams();
    if (query.short_name) qp.set('short_name', query.short_name);
    else if (query.keyword) qp.set('keyword', query.keyword);
    qp.set('page_size', '1');
    const col = await fetchJSON(base + '/collections.json?' + qp.toString(), { fetchImpl, timeoutMs, headers });
    const cEntry = (col && col.feed && col.feed.entry && col.feed.entry[0]) || null;

    const gp = new URLSearchParams();
    if (query.short_name) gp.set('short_name', query.short_name);
    else if (cEntry && cEntry.short_name) gp.set('short_name', cEntry.short_name);
    else if (query.keyword) gp.set('keyword', query.keyword);
    gp.set('sort_key', '-start_date');
    gp.set('page_size', '1');
    let gEntry = null;
    try {
      const gr = await fetchJSON(base + '/granules.json?' + gp.toString(), { fetchImpl, timeoutMs, headers });
      gEntry = (gr && gr.feed && gr.feed.entry && gr.feed.entry[0]) || null;
    } catch (_) { /* collection-only is still meaningful; leave gEntry null */ }

    const bbox = gEntry ? parseCmrBox(gEntry.boxes) : (cEntry ? parseCmrBox(cEntry.boxes) : null);
    const updated = isoOrNull(gEntry && gEntry.updated) || isoOrNull(cEntry && cEntry.updated);
    const granule = gEntry ? {
      id: gEntry.producer_granule_id || gEntry.title || null,
      time: isoOrNull(gEntry.time_start),
      updated: isoOrNull(gEntry.updated),
      sizeMb: Number.isFinite(Number(gEntry.granule_size)) ? Number(gEntry.granule_size) : null,
    } : null;
    return {
      recordsDiscovered: (cEntry ? 1 : 0) + (gEntry ? 1 : 0),
      productId: (cEntry && cEntry.id) || query.short_name || null,
      productTitle: (cEntry && (cEntry.dataset_id || cEntry.title)) || null,
      coverage: {
        bbox,
        temporal: {
          start: isoOrNull(gEntry && gEntry.time_start) || isoOrNull(cEntry && cEntry.time_start),
          end: isoOrNull(gEntry && gEntry.time_end) || isoOrNull(cEntry && cEntry.time_end) || updated,
        },
      },
      granule,
      freshnessRef: (granule && (granule.time || granule.updated)) || updated,
      features: [],
    };
  };
}

// ---- Copernicus STAC probe (public catalogue coverage) --------------------
function copernicusStacProbe(collectionId) {
  return async function ({ fetchImpl, timeoutMs = 8000 }) {
    const url = 'https://catalogue.dataspace.copernicus.eu/stac/collections/' + encodeURIComponent(collectionId);
    const j = await fetchJSON(url, { fetchImpl, timeoutMs });
    const ext = (j && j.extent) || {};
    const bbox = (ext.spatial && ext.spatial.bbox && ext.spatial.bbox[0]) || null;
    const interval = (ext.temporal && ext.temporal.interval && ext.temporal.interval[0]) || [null, null];
    return {
      recordsDiscovered: j && j.id ? 1 : 0,
      productId: (j && j.id) || collectionId,
      productTitle: (j && j.title) || collectionId,
      coverage: {
        bbox: Array.isArray(bbox) && bbox.length === 4 ? bbox : null,
        temporal: { start: isoOrNull(interval[0]), end: isoOrNull(interval[1]) },
      },
      granule: null,
      freshnessRef: isoOrNull(interval[1]),
      features: [],
    };
  };
}

// ---- FAO WaPOR (gismgr v2 mapset catalog) ---------------------------------
async function faoWaporProbe({ fetchImpl, timeoutMs = 8000, mapsetCode }) {
  const url = 'https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/WAPOR-3/mapsets?page=1&pageSize=50';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const items = (j && j.response && j.response.items) || [];
  const match = mapsetCode ? items.find((m) => m && m.code === mapsetCode) : items[0];
  if (!match) { const e = new Error('no-catalog: WaPOR mapset ' + (mapsetCode || '') + ' absent'); e.noData = true; throw e; }
  return {
    recordsDiscovered: items.length,
    productId: match.code || null,
    productTitle: match.caption || match.measureCaption || null,
    units: match.measureUnit || null,
    coverage: { bbox: [-180, -90, 180, 90], temporal: { start: null, end: null } },
    granule: null,
    freshnessRef: null,
    features: [],
    tags: Array.isArray(match.tags) ? match.tags.slice(0, 8) : [],
  };
}

// ---- WRI Aqueduct (public ArcGIS map service metadata) --------------------
function wriAqueductProbe(servicePath) {
  return async function ({ fetchImpl, timeoutMs = 8000 }) {
    const url = 'https://gis.wri.org/server/rest/services/' + servicePath + '?f=json';
    const j = await fetchJSON(url, { fetchImpl, timeoutMs });
    const ext = (j && j.fullExtent) || (j && j.initialExtent) || null;
    let bbox = null;
    if (ext && [ext.xmin, ext.ymin, ext.xmax, ext.ymax].every((n) => Number.isFinite(Number(n)))) {
      // WRI Aqueduct services publish in Web Mercator (wkid 102100/3857) or 4326.
      const wkid = (ext.spatialReference && (ext.spatialReference.latestWkid || ext.spatialReference.wkid)) || 4326;
      bbox = (wkid === 4326)
        ? [Number(ext.xmin), Number(ext.ymin), Number(ext.xmax), Number(ext.ymax)]
        : [-180, -85, 180, 85]; // don't fabricate a false-precision reprojection; use the service's global footprint
    }
    const layers = Array.isArray(j && j.layers) ? j.layers.length : 0;
    return {
      recordsDiscovered: layers || (j && j.mapName ? 1 : 0),
      productId: (j && j.mapName) || servicePath,
      productTitle: (j && (j.documentInfo && j.documentInfo.Title)) || (j && j.mapName) || servicePath,
      coverage: { bbox, temporal: { start: null, end: null } },
      granule: null,
      freshnessRef: null,
      features: [],
    };
  };
}

export const LAYER_CONTRACTS = [
  // ---- NASA Earthdata (CMR) — public discovery, token as enhancement ----
  {
    layerId: 'smap-soil-moisture', provider: 'nasa-cmr', domain: 'water',
    product: 'SMAP L3 Radiometer Soil Moisture', cadence: 'daily',
    kind: 'raster-coverage', units: 'volumetric soil moisture (cm³/cm³)',
    sourceUrl: 'https://nsidc.org/data/spl3smp',
    metricDefs: 'Daily global surface soil moisture on the 36 km EASE-Grid.',
    probe: cmrProbe({ short_name: 'SPL3SMP' }),
  },
  {
    layerId: 'gpm-precipitation', provider: 'nasa-cmr', domain: 'weather',
    product: 'GPM IMERG Final Daily Precipitation', cadence: 'daily',
    kind: 'raster-coverage', units: 'mm/day',
    sourceUrl: 'https://gpm.nasa.gov/data/imerg',
    metricDefs: 'Multi-satellite daily precipitation estimate (IMERG).',
    probe: cmrProbe({ short_name: 'GPM_3IMERGDF' }),
  },
  {
    layerId: 'grace-groundwater', provider: 'nasa-cmr', domain: 'water',
    product: 'GRACE-FO Mascon Groundwater / TWS Anomaly', cadence: 'monthly',
    kind: 'raster-coverage', units: 'liquid water equivalent thickness (cm)',
    sourceUrl: 'https://grace.jpl.nasa.gov/data/get-data/',
    metricDefs: 'Monthly terrestrial water-storage anomaly (mascon), a groundwater proxy.',
    probe: cmrProbe({ keyword: 'GRACE-FO mascon terrestrial water storage' }),
  },
  // ---- Copernicus — STAC public coverage + CDS heavy job ----
  {
    layerId: 'era5land-drought', provider: 'copernicus', domain: 'climate',
    product: 'ERA5-Land reanalysis (temperature / precip / soil moisture)', cadence: 'monthly',
    kind: 'heavy-job', units: 'K / m / m³·m⁻³',
    sourceUrl: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
    metricDefs: 'Hourly land reanalysis; drought/temp/soil-moisture via CDS async extraction.',
    heavyJob: { system: 'CDS', dataset: 'reanalysis-era5-land' },
    // No probe: extraction is a heavy async job we must NOT queue on page load.
    // State is decided purely from auth mode (HEAVY_JOB_READY vs AUTH_REQUIRED).
    probe: null,
  },
  {
    layerId: 'sentinel-catalog', provider: 'copernicus', domain: 'satellite',
    product: 'Copernicus CLMS Burnt Area (context catalog)', cadence: 'daily',
    kind: 'catalog', units: null,
    sourceUrl: 'https://dataspace.copernicus.eu/',
    metricDefs: 'Public STAC coverage for Copernicus Land Monitoring context layers.',
    probe: copernicusStacProbe('clms_ba_global_300m_daily_v3_cog'),
  },
  // ---- FAO WaPOR — keyless catalog ----
  {
    layerId: 'wapor-precipitation', provider: 'fao-wapor', domain: 'weather',
    product: 'FAO WaPOR v3 Precipitation (Global, Dekadal ~5km)', cadence: 'dekadal',
    kind: 'raster-tiles', units: 'mm/day',
    sourceUrl: 'https://data.apps.fao.org/wapor/',
    metricDefs: 'WaPOR dekadal precipitation mapset (water-productivity monitoring).',
    probe: ({ fetchImpl, timeoutMs }) => faoWaporProbe({ fetchImpl, timeoutMs, mapsetCode: 'L1-PCP-D' }),
  },
  {
    layerId: 'wapor-evapotranspiration', provider: 'fao-wapor', domain: 'water',
    product: 'FAO WaPOR v3 Actual Evapotranspiration (Global, Dekadal)', cadence: 'dekadal',
    kind: 'raster-tiles', units: 'mm/day',
    sourceUrl: 'https://data.apps.fao.org/wapor/',
    metricDefs: 'WaPOR actual ET & interception — crop water consumption.',
    probe: ({ fetchImpl, timeoutMs }) => faoWaporProbe({ fetchImpl, timeoutMs, mapsetCode: 'L1-AETI-D' }),
  },
  // ---- WRI Aqueduct — keyless ArcGIS map service ----
  {
    layerId: 'aqueduct-water-risk', provider: 'wri-aqueduct', domain: 'water',
    product: 'WRI Aqueduct 3.0 baseline water risk', cadence: 'periodic',
    kind: 'feature-service', units: 'indexed risk score (0-5) / category',
    sourceUrl: 'https://www.wri.org/aqueduct',
    metricDefs: 'Basin-level baseline water stress / risk indicators (Aqueduct).',
    probe: wriAqueductProbe('Aqueduct/aqueduct_aggr/MapServer'),
  },
];

export const LAYER_BY_ID = {};
LAYER_CONTRACTS.forEach((l) => { LAYER_BY_ID[l.layerId] = l; });

// ---------------------------------------------------------------------------
// State-machine resolution. Given a probe outcome (or absence) + auth mode +
// freshness, decide the single truthful state.
// ---------------------------------------------------------------------------
function decideState(layer, authMode, probe, err, now) {
  if (err) {
    const cls = classifyError(err);
    if (cls === 'rate_limit') return 'RATE_LIMITED';
    if (cls === 'auth') {
      // Auth error only matters if we actually needed the token and there is no
      // public fallback; CMR/STAC are public so this is UPSTREAM for them.
      const p = PROVIDERS[layer.provider];
      return (p && p.publicFallback) ? 'UPSTREAM_ERROR' : 'AUTH_REQUIRED';
    }
    return 'UPSTREAM_ERROR';
  }

  // Heavy-job layers (ERA5-Land) resolve purely from auth: we never queue a job.
  if (layer.kind === 'heavy-job') {
    return authMode === 'authenticated' ? 'HEAVY_JOB_READY' : 'AUTH_REQUIRED';
  }

  if (!probe || probe.recordsDiscovered === 0) return 'NO_RECENT_GRANULE';

  // Catalogs of heavy rasters/tiles/feature-services: metadata is live, but the
  // payload is not a lightweight feature stream -> CATALOG_ONLY (unless it's a
  // granule-bearing coverage we can date, handled below).
  const catalogKinds = new Set(['raster-tiles', 'feature-service', 'catalog']);

  // Granule-bearing coverage (CMR): decide by freshness of the newest granule.
  if (layer.kind === 'raster-coverage') {
    const ref = probe.freshnessRef;
    const thr = FRESHNESS_HOURS[layer.cadence] != null ? FRESHNESS_HOURS[layer.cadence] : FRESHNESS_HOURS.periodic;
    const age = ageHours(ref, now);
    const fresh = age != null && age <= thr;
    if (!fresh && age != null) return 'NO_RECENT_GRANULE';
    if (age == null) return 'CATALOG_ONLY'; // collection found, no dateable granule
    return authMode === 'public' ? 'PUBLIC_FALLBACK' : 'LIVE';
  }

  if (catalogKinds.has(layer.kind)) return 'CATALOG_ONLY';
  return 'CATALOG_ONLY';
}

// Compute the freshness block for a resolved contract.
function freshnessBlock(layer, probe, now) {
  const thr = FRESHNESS_HOURS[layer.cadence] != null ? FRESHNESS_HOURS[layer.cadence] : FRESHNESS_HOURS.periodic;
  const ref = probe && probe.freshnessRef;
  const age = ageHours(ref, now);
  return {
    asOf: ref || null,
    ageHours: age != null ? Math.round(age * 10) / 10 : null,
    thresholdHours: thr,
    stale: age != null ? age > thr : null,
  };
}

// ---------------------------------------------------------------------------
// Resolve ONE layer contract with full resilience (cache -> breaker -> retry).
// Returns a complete, client-safe contract object (never throws).
// ---------------------------------------------------------------------------
export async function resolveLayer(layer, deps = {}) {
  const { fetchImpl, env = (typeof process !== 'undefined' ? process.env : {}), now = Date.now(), sleep, force = false } = deps;
  const nowMs = typeof now === 'number' ? now : Date.parse(now) || Date.now();
  const started = Date.now();
  const authMode = resolveAuthMode(layer.provider, env);
  const cacheKey = 'cat:' + layer.layerId;
  const breakerId = 'cat:' + layer.provider;

  const base = {
    layerId: layer.layerId, provider: layer.provider,
    providerName: (PROVIDERS[layer.provider] || {}).name || layer.provider,
    product: layer.product, productId: null, productTitle: null,
    domain: layer.domain, kind: layer.kind, cadence: layer.cadence,
    authMode, units: layer.units || null, metricDefs: layer.metricDefs || null,
    sourceUrl: layer.sourceUrl, license: (PROVIDERS[layer.provider] || {}).license || null,
    heavyJob: layer.heavyJob || null,
    coverage: { bbox: null, temporal: { start: null, end: null } },
    granule: null,
    recordsDiscovered: 0, recordsAccepted: 0, recordsRejected: 0,
    features: [],
    freshness: { asOf: null, ageHours: null, thresholdHours: null, stale: null },
    error: null,
  };

  // Heavy-job contract: no network probe, decide from auth mode.
  if (layer.kind === 'heavy-job' || typeof layer.probe !== 'function') {
    const state = decideState(layer, authMode, layer.kind === 'heavy-job' ? {} : null, null, nowMs);
    return Object.assign(base, { state, durationMs: Date.now() - started });
  }

  // Serve fresh cache unless forced.
  const ttl = layer.ttlMs || 1_800_000; // 30 min default for catalog metadata
  if (!force) {
    const c = cacheGet(cacheKey, ttl, nowMs);
    if (c.hit && c.fresh && c.value) return Object.assign({}, c.value, { cached: true, durationMs: Date.now() - started });
  }

  // Breaker open -> last-known-good as STALE.
  if (!breakerAllows(breakerId, nowMs)) {
    const c = cacheGet(cacheKey, Infinity, nowMs);
    if (c.hit && c.value) return Object.assign({}, c.value, { state: 'STALE', cached: true, durationMs: Date.now() - started });
    return Object.assign(base, { state: 'UPSTREAM_ERROR', error: { class: 'circuit', message: 'circuit open' }, durationMs: Date.now() - started });
  }

  try {
    const probe = await withRetry(
      () => layer.probe({ fetchImpl, env, timeoutMs: layer.timeoutMs || 8000, now: new Date(nowMs) }),
      { retries: 1, baseDelayMs: 200, sleep }
    );
    breakerSuccess(breakerId);
    const state = decideState(layer, authMode, probe, null, nowMs);
    const accepted = probe.recordsDiscovered || 0;
    const result = Object.assign(base, {
      state,
      productId: probe.productId || null,
      productTitle: probe.productTitle || null,
      units: probe.units || base.units,
      coverage: probe.coverage || base.coverage,
      granule: probe.granule || null,
      recordsDiscovered: accepted,
      recordsAccepted: accepted,
      recordsRejected: 0,
      features: Array.isArray(probe.features) ? probe.features : [],
      tags: probe.tags || undefined,
      freshness: freshnessBlock(layer, probe, nowMs),
      durationMs: Date.now() - started,
    });
    cacheSet(cacheKey, result, nowMs);
    return result;
  } catch (err) {
    // "noData" from a probe is not a transport failure — do not trip the breaker.
    if (!(err && err.noData)) breakerFailure(breakerId, nowMs);
    else breakerSuccess(breakerId);
    // Last-known-good fallback.
    const c = cacheGet(cacheKey, Infinity, nowMs);
    if (!(err && err.noData) && c.hit && c.value) {
      return Object.assign({}, c.value, { state: 'STALE', error: { class: classifyError(err), message: redactError(err) }, durationMs: Date.now() - started });
    }
    const state = (err && err.noData) ? 'NO_RECENT_GRANULE' : decideState(layer, authMode, null, err, nowMs);
    return Object.assign(base, {
      state,
      error: { class: (err && err.noData) ? 'no_data' : classifyError(err), message: redactError(err) },
      durationMs: Date.now() - started,
    });
  }
}

// ---------------------------------------------------------------------------
// Resolve ALL layer contracts (bounded concurrency), grouped by provider, with
// a provider health roll-up and a run-ledger record per provider.
// ---------------------------------------------------------------------------
export async function collectCatalog(deps = {}) {
  const layers = deps.layers || LAYER_CONTRACTS;
  const now = deps.now || Date.now();
  const nowMs = typeof now === 'number' ? now : Date.parse(now) || Date.now();
  const concurrency = deps.concurrency || 3;

  const contracts = await mapLimit(layers, concurrency, (layer) => resolveLayer(layer, Object.assign({}, deps, { now: nowMs })));

  // Provider roll-up.
  const providers = Object.keys(PROVIDERS).map((pid) => {
    const p = PROVIDERS[pid];
    const own = contracts.filter((c) => c.provider === pid);
    return {
      id: pid, name: p.name, homepage: p.homepage, license: p.license,
      tokenEnv: p.tokenEnv || null,
      authMode: resolveAuthMode(pid, deps.env || (typeof process !== 'undefined' ? process.env : {})),
      state: providerState(own),
      layers: own.length,
      recordsDiscovered: own.reduce((n, c) => n + (c.recordsDiscovered || 0), 0),
      recordsRejected: own.reduce((n, c) => n + (c.recordsRejected || 0), 0),
    };
  });

  const runs = providers.map((p) => buildRunRecord(p, contracts.filter((c) => c.provider === p.id), nowMs));

  return {
    ok: contracts.some((c) => ['LIVE', 'PUBLIC_FALLBACK', 'CATALOG_ONLY', 'HEAVY_JOB_READY'].indexOf(c.state) !== -1),
    asOf: new Date(nowMs).toISOString(),
    adapterVersion: CATALOG_ADAPTER_VERSION,
    providers, contracts, runs,
    summary: summarizeCatalog(contracts),
  };
}

// Roll a provider's layer states up into a single provider state (worst-wins
// among hard failures, else best available).
function providerState(contracts) {
  if (!contracts.length) return 'DISABLED';
  const states = contracts.map((c) => c.state);
  if (states.some((s) => s === 'LIVE')) return 'LIVE';
  if (states.some((s) => s === 'PUBLIC_FALLBACK')) return 'PUBLIC_FALLBACK';
  if (states.some((s) => s === 'CATALOG_ONLY')) return 'CATALOG_ONLY';
  if (states.some((s) => s === 'HEAVY_JOB_READY')) return 'HEAVY_JOB_READY';
  if (states.every((s) => s === 'AUTH_REQUIRED')) return 'AUTH_REQUIRED';
  if (states.some((s) => s === 'RATE_LIMITED')) return 'RATE_LIMITED';
  if (states.some((s) => s === 'STALE')) return 'STALE';
  if (states.some((s) => s === 'NO_RECENT_GRANULE')) return 'NO_RECENT_GRANULE';
  return 'UPSTREAM_ERROR';
}

export function summarizeCatalog(contracts) {
  const byState = {};
  CATALOG_STATES.forEach((s) => { byState[s] = 0; });
  contracts.forEach((c) => { if (byState[c.state] != null) byState[c.state]++; });
  return {
    total: contracts.length,
    byState,
    live: contracts.filter((c) => c.state === 'LIVE').length,
    available: contracts.filter((c) => ['LIVE', 'PUBLIC_FALLBACK', 'CATALOG_ONLY', 'HEAVY_JOB_READY'].indexOf(c.state) !== -1).length,
  };
}

// ---------------------------------------------------------------------------
// Run-ledger record (pure builder). One row per provider per run. Contains NO
// secrets — only auth MODE, redacted error class, and counts.
// ---------------------------------------------------------------------------
export function buildRunRecord(provider, contracts, nowMs) {
  const errors = contracts.filter((c) => c.error).map((c) => c.error.class);
  const httpCat = errors.length ? errors[0] : 'ok';
  const newest = contracts
    .map((c) => c.freshness && c.freshness.asOf)
    .filter(Boolean)
    .sort()
    .pop() || null;
  return {
    runId: 'run-' + provider.id + '-' + nowMs,
    provider: provider.id,
    adapterVersion: CATALOG_ADAPTER_VERSION,
    startedAt: new Date(nowMs).toISOString(),
    completedAt: new Date(nowMs).toISOString(),
    state: provider.state,
    authMode: provider.authMode,
    layers: contracts.length,
    recordsDiscovered: provider.recordsDiscovered,
    recordsAccepted: contracts.reduce((n, c) => n + (c.recordsAccepted || 0), 0),
    recordsRejected: provider.recordsRejected,
    httpCategory: httpCat,
    freshestAsOf: newest,
    durationMs: contracts.reduce((n, c) => n + (c.durationMs || 0), 0),
    error: errors.length ? errors.join(',') : null,
  };
}

// ---------------------------------------------------------------------------
// In-memory run ledger + dead-letter (bounded). Persisted to Postgres by the
// endpoint when a DATABASE_URL is configured; resets on cold start otherwise
// (documented, no fabricated durability).
// ---------------------------------------------------------------------------
const RUN_LEDGER = globalThis.__AGRI_INGEST_RUNS__ || (globalThis.__AGRI_INGEST_RUNS__ = []);
const DEAD_LETTER = globalThis.__AGRI_INGEST_DLQ__ || (globalThis.__AGRI_INGEST_DLQ__ = []);
const LEDGER_MAX = 200;
const DLQ_MAX = 100;

export function recordRuns(runs) {
  (runs || []).forEach((r) => {
    RUN_LEDGER.push(r);
    while (RUN_LEDGER.length > LEDGER_MAX) RUN_LEDGER.shift();
  });
}
export function getRuns(limit = 50) { return RUN_LEDGER.slice(-Math.max(1, limit)).reverse(); }
export function clearRuns() { RUN_LEDGER.length = 0; }

// Quarantine a malformed record with a SAFE, bounded summary (never raw blobs
// or secrets).
export function quarantine(provider, reason, sample) {
  const entry = {
    at: new Date().toISOString(),
    provider: String(provider || 'unknown').slice(0, 40),
    reason: redactError(reason).slice(0, 120),
    sample: typeof sample === 'string' ? redactError(sample).slice(0, 120)
      : (sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 8).join(',') : null),
  };
  DEAD_LETTER.push(entry);
  while (DEAD_LETTER.length > DLQ_MAX) DEAD_LETTER.shift();
  return entry;
}
export function getDeadLetter(limit = 25) { return DEAD_LETTER.slice(-Math.max(1, limit)).reverse(); }
export function clearDeadLetter() { DEAD_LETTER.length = 0; }
