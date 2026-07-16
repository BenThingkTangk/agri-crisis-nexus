/* ============================================================
   AgriOS — EARTH THEATER catalog descriptors (pure, DOM-free, TRUTHFUL)

   Phase VI companion to earth-sources.js. Where earth-sources.js maps the
   keyless live-event feeds (/api/intel), this module describes the heavy
   agricultural CATALOG/COVERAGE providers surfaced by /api/ingest — NASA
   Earthdata (CMR), Copernicus, FAO WaPOR, WRI Aqueduct — and maps a real
   /api/ingest payload into truthful display rows for the Ingestion Operations
   drawer and the map layer tree.

   CARDINAL RULE (unit-tested): a layer is only ever `available:true` when its
   server-resolved state is one of LIVE / PUBLIC_FALLBACK / CATALOG_ONLY /
   HEAVY_JOB_READY. AUTH_REQUIRED / NO_RECENT_GRANULE / RATE_LIMITED /
   UPSTREAM_ERROR / STALE / DISABLED are NEVER presented as connected data.

   NO secret values ever appear here — only the NAMES of env vars a provider
   would use, so the UI can explain what is missing without leaking anything.

   Loads as window.EARTH_CATALOG; loadable in a node:vm sandbox for tests.
   ============================================================ */
(function (root) {
  'use strict';

  // The server-side layer-contract state machine (mirror of api/_catalog.js).
  var STATES = [
    'LIVE', 'PUBLIC_FALLBACK', 'CATALOG_ONLY', 'HEAVY_JOB_READY',
    'NO_RECENT_GRANULE', 'AUTH_REQUIRED', 'RATE_LIMITED', 'UPSTREAM_ERROR',
    'STALE', 'DISABLED',
  ];

  // States under which a layer genuinely has data/coverage to offer.
  var AVAILABLE = ['LIVE', 'PUBLIC_FALLBACK', 'CATALOG_ONLY', 'HEAVY_JOB_READY'];

  // Human-facing label + short explanation for each state. Never claims a
  // provider is "connected"/"live" unless it truthfully is.
  var STATE_INFO = {
    LIVE:              { label: 'LIVE',            tone: 'ok',    hint: 'Catalog reachable; a dataset within its freshness window is available.' },
    PUBLIC_FALLBACK:   { label: 'PUBLIC',          tone: 'ok',    hint: 'No token configured — running on public keyless discovery (degraded, honest).' },
    CATALOG_ONLY:      { label: 'CATALOG ONLY',    tone: 'info',  hint: 'Metadata & coverage are live; payload is heavy raster/tiles, not a live feature stream.' },
    HEAVY_JOB_READY:   { label: 'HEAVY JOB READY', tone: 'info',  hint: 'Authenticated async extraction job available; not queued on page load.' },
    NO_RECENT_GRANULE: { label: 'NO RECENT DATA',  tone: 'warn',  hint: 'Catalog reachable but the newest granule is older than the freshness threshold.' },
    AUTH_REQUIRED:     { label: 'AUTH REQUIRED',   tone: 'warn',  hint: 'Needs a server-side credential that is not configured. No public fallback suffices.' },
    RATE_LIMITED:      { label: 'RATE LIMITED',    tone: 'warn',  hint: 'Upstream returned HTTP 429; will retry after cooldown.' },
    UPSTREAM_ERROR:    { label: 'UPSTREAM ERROR',  tone: 'down',  hint: 'Upstream failed (5xx / timeout / network / parse).' },
    STALE:             { label: 'STALE',           tone: 'down',  hint: 'Serving last-known-good after a failure.' },
    DISABLED:          { label: 'DISABLED',        tone: 'off',   hint: 'Switched off.' },
  };

  // Provider descriptors — NAMES only, no secrets. `tokenEnv` documents which
  // credential unlocks authenticated mode (null = keyless by design).
  var PROVIDERS = [
    { id: 'nasa-cmr', name: 'NASA Earthdata (CMR)', tokenEnv: 'EARTHDATA_TOKEN',
      url: 'https://cmr.earthdata.nasa.gov/', publicFallback: true,
      note: 'CMR search is public; the token raises rate limits and unlocks restricted collections.' },
    { id: 'copernicus', name: 'Copernicus Data Space / CDS', tokenEnv: 'COPERNICUS_TOKEN',
      url: 'https://dataspace.copernicus.eu/', publicFallback: true,
      note: 'STAC catalogue is public; ERA5-Land extraction is a token-gated CDS async job.' },
    { id: 'fao-wapor', name: 'FAO WaPOR / AQUASTAT', tokenEnv: null,
      url: 'https://data.apps.fao.org/wapor/', publicFallback: true,
      note: 'Public FAO gismgr catalog — keyless water-productivity mapsets.' },
    { id: 'wri-aqueduct', name: 'WRI Aqueduct', tokenEnv: null,
      url: 'https://www.wri.org/aqueduct', publicFallback: true,
      note: 'Public WRI ArcGIS / Resource Watch water-risk services — keyless.' },
    { id: 'ecmwf', name: 'ECMWF Open Data', tokenEnv: null,
      url: 'https://www.ecmwf.int/en/forecasts/datasets/open-data', publicFallback: true,
      note: 'Public forecast-cycle catalog (00/06/12/18Z). Metadata only — no GRIB parsing, no rendered values.' },
    { id: 'noaa-nomads', name: 'NOAA NOMADS (GFS/GEFS)', tokenEnv: null,
      url: 'https://nomads.ncep.noaa.gov/', publicFallback: true,
      note: 'Public GFS/GEFS cycle catalog. Metadata only — no GRIB download/parse on serverless.' },
    { id: 'worldpop', name: 'WorldPop', tokenEnv: null,
      url: 'https://www.worldpop.org/', publicFallback: true,
      note: 'Keyless REST catalog discovery for gridded population — rasters not downloaded.' },
  ];

  // Layer descriptors (mirror api/_catalog.js LAYER_CONTRACTS). Drives the map
  // layer tree entries and the drawer. `map` marks layers eligible for a globe
  // overlay contract when their server state is available.
  var LAYERS = [
    { layerId: 'smap-soil-moisture',      provider: 'nasa-cmr',     domain: 'water',     product: 'SMAP L3 soil moisture',            cadence: 'daily',    kind: 'raster-coverage', map: true },
    { layerId: 'gpm-precipitation',       provider: 'nasa-cmr',     domain: 'weather',   product: 'GPM IMERG daily precipitation',    cadence: 'daily',    kind: 'raster-coverage', map: true },
    { layerId: 'grace-groundwater',       provider: 'nasa-cmr',     domain: 'water',     product: 'GRACE-FO groundwater proxy',       cadence: 'monthly',  kind: 'raster-coverage', map: true },
    { layerId: 'era5land-drought',        provider: 'copernicus',   domain: 'climate',   product: 'ERA5-Land reanalysis',             cadence: 'monthly',  kind: 'heavy-job',       map: false },
    { layerId: 'sentinel-catalog',        provider: 'copernicus',   domain: 'satellite', product: 'Copernicus CLMS burnt-area',       cadence: 'daily',    kind: 'catalog',         map: false },
    { layerId: 'wapor-precipitation',     provider: 'fao-wapor',    domain: 'weather',   product: 'WaPOR precipitation (dekadal)',    cadence: 'dekadal',  kind: 'raster-tiles',    map: true },
    { layerId: 'wapor-evapotranspiration', provider: 'fao-wapor',   domain: 'water',     product: 'WaPOR evapotranspiration',         cadence: 'dekadal',  kind: 'raster-tiles',    map: true },
    { layerId: 'aqueduct-water-risk',     provider: 'wri-aqueduct', domain: 'water',     product: 'Aqueduct baseline water risk',     cadence: 'periodic', kind: 'feature-service', map: true },
    { layerId: 'sentinel2-l2a',           provider: 'copernicus',   domain: 'satellite', product: 'Sentinel-2 L2A surface reflectance', cadence: 'daily',    kind: 'catalog',         map: false },
    { layerId: 'ecmwf-open-forecast',     provider: 'ecmwf',        domain: 'weather',   product: 'ECMWF Open Data forecast cycle',    cadence: 'half-hourly', kind: 'catalog',      map: false },
    { layerId: 'nomads-gfs',              provider: 'noaa-nomads',  domain: 'weather',   product: 'NOAA GFS forecast cycle',           cadence: 'half-hourly', kind: 'catalog',      map: false },
    { layerId: 'worldpop-population',     provider: 'worldpop',     domain: 'population', product: 'WorldPop gridded population',       cadence: 'periodic', kind: 'catalog',         map: false },
  ];

  function stateInfo(state) {
    return STATE_INFO[state] || { label: String(state || 'UNKNOWN'), tone: 'off', hint: '' };
  }
  function isAvailable(state) { return AVAILABLE.indexOf(state) !== -1; }

  // Merge the static layer catalog with a live /api/ingest payload (or nothing)
  // into truthful display rows. Layers with no server contract yet are shown as
  // UNKNOWN/unavailable — never fabricated as connected.
  function resolve(ingest) {
    ingest = ingest || {};
    var byLayer = {};
    (ingest.contracts || []).forEach(function (c) { if (c && c.layerId) byLayer[c.layerId] = c; });
    return LAYERS.map(function (l) {
      var c = byLayer[l.layerId] || null;
      var state = c ? c.state : 'DISABLED';
      var info = stateInfo(state);
      return {
        layerId: l.layerId, provider: l.provider, domain: l.domain,
        product: (c && c.product) || l.product, productId: (c && c.productId) || null,
        cadence: l.cadence, kind: l.kind, map: !!l.map,
        state: state, stateLabel: info.label, tone: info.tone, hint: info.hint,
        available: isAvailable(state),
        authMode: (c && c.authMode) || null,
        units: (c && c.units) || null,
        coverage: (c && c.coverage) || null,
        granule: (c && c.granule) || null,
        freshness: (c && c.freshness) || null,
        sourceUrl: (c && c.sourceUrl) || null,
        error: (c && c.error) || null,
        heavyJob: (c && c.heavyJob) || null,
      };
    });
  }

  // Provider roll-up rows from an /api/ingest payload.
  function resolveProviders(ingest) {
    ingest = ingest || {};
    var byId = {};
    (ingest.providers || []).forEach(function (p) { if (p && p.id) byId[p.id] = p; });
    return PROVIDERS.map(function (d) {
      var p = byId[d.id] || null;
      var state = p ? p.state : 'DISABLED';
      var info = stateInfo(state);
      return {
        id: d.id, name: d.name, url: d.url, tokenEnv: d.tokenEnv, note: d.note,
        state: state, stateLabel: info.label, tone: info.tone, hint: info.hint,
        available: isAvailable(state),
        authMode: (p && p.authMode) || null,
        layers: (p && p.layers) || 0,
        recordsDiscovered: (p && p.recordsDiscovered) || 0,
      };
    });
  }

  function summarize(rows) {
    var counts = { total: rows.length, available: 0, live: 0 };
    STATES.forEach(function (s) { counts[s] = 0; });
    rows.forEach(function (r) {
      if (counts[r.state] != null) counts[r.state]++;
      if (r.available) counts.available++;
      if (r.state === 'LIVE') counts.live++;
    });
    return counts;
  }

  var API = {
    STATES: STATES,
    AVAILABLE: AVAILABLE,
    STATE_INFO: STATE_INFO,
    PROVIDERS: PROVIDERS,
    LAYERS: LAYERS,
    stateInfo: stateInfo,
    isAvailable: isAvailable,
    resolve: resolve,
    resolveProviders: resolveProviders,
    summarize: summarize,
  };
  root.EARTH_CATALOG = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
