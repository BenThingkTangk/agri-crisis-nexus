/* ============================================================
   AgriOS — EARTH THEATER source/adapter registry (pure, DOM-free, TRUTHFUL)

   A single honest registry of every data source the planetary surface can
   speak to, and a mapping from the real /api/intel health payload to a
   connection state. The cardinal rule, enforced here and unit-tested:

     NEVER report a source as `live` unless the real server-side adapter
     is actually connected and returning fresh data.

   Connection states:
     connected  — server adapter is wired and returning OK (from /api/intel)
     stale      — adapter returned, but the data is past its freshness window
     down       — adapter errored / circuit-breaker open
     disabled   — adapter present but switched off (e.g. optional key absent)
     registry-ready     — we know the open endpoint; not yet wired server-side
     credential-required — needs an API key / account / registry step first

   `live` is a strict boolean: true ONLY for state === 'connected'. Fixtures,
   modeled routes, sim output, and any credential-gated source are live:false.

   NO secret values ever appear here — only the NAMES of env vars a source
   would need, so the UI can explain what is missing without leaking anything.

   Loads as window.EARTH_SOURCES; loadable in a node:vm sandbox for tests.
   ============================================================ */
(function (root) {
  'use strict';

  var STATES = ['connected', 'stale', 'down', 'disabled', 'registry-ready', 'credential-required'];

  /* ---------------- the registry ----------------
     `intelId` links an entry to a source id reported by /api/intel so its
     real health can be resolved. `envNames` lists the NAMES (never values)
     of credentials a not-yet-connected source needs. */
  var REGISTRY = [
    /* --- genuinely live, keyless, server-side via /api/intel --- */
    { id: 'gdacs', name: 'GDACS — Global Disaster Alert & Coordination', category: 'hazard',
      open: true, keyless: true, intelId: 'gdacs', cadence: 'continuous',
      url: 'https://www.gdacs.org/', description: 'Multi-hazard disaster alerts.' },
    { id: 'usgs', name: 'USGS — Earthquake Hazards', category: 'hazard',
      open: true, keyless: true, intelId: 'usgs', cadence: 'continuous',
      url: 'https://earthquake.usgs.gov/', description: 'Global seismicity feed.' },
    { id: 'eonet', name: 'NASA EONET — Natural Event Tracker', category: 'hazard',
      open: true, keyless: true, intelId: 'eonet', cadence: 'daily',
      url: 'https://eonet.gsfc.nasa.gov/', description: 'Wildfire/storm/volcano events.' },
    { id: 'openmeteo', name: 'Open-Meteo — Weather', category: 'weather',
      open: true, keyless: true, intelId: 'openmeteo', cadence: 'hourly',
      url: 'https://open-meteo.com/', description: 'Keyless weather forecast API.' },
    { id: 'power', name: 'NASA POWER — Agroclimatology', category: 'climate',
      open: true, keyless: true, intelId: 'power', cadence: 'daily',
      url: 'https://power.larc.nasa.gov/', description: 'Solar/agro-climate parameters.' },
    { id: 'worldbank', name: 'World Bank — Indicators', category: 'market',
      open: true, keyless: true, intelId: 'worldbank', cadence: 'periodic',
      url: 'https://data.worldbank.org/', description: 'Development/economic indicators.' },
    { id: 'faostat', name: 'FAOSTAT — Food & Agriculture', category: 'market',
      open: true, keyless: true, intelId: 'faostat', cadence: 'periodic',
      url: 'https://www.fao.org/faostat/', description: 'Production/trade statistics.' },
    { id: 'gdelt', name: 'GDELT — Global Event Database', category: 'conflict',
      open: true, keyless: true, intelId: 'gdelt', cadence: 'continuous',
      url: 'https://www.gdeltproject.org/', description: 'News-derived conflict/event signals.' },
    { id: 'portwatch', name: 'IMF PortWatch — Port & chokepoint activity', category: 'logistics',
      open: true, keyless: true, intelId: 'portwatch', cadence: 'daily',
      url: 'https://portwatch.imf.org/', description: 'Trade-disruption & port throughput.' },
    { id: 'gibs', name: 'NASA GIBS — VIIRS/MODIS imagery', category: 'satellite',
      open: true, keyless: true, intelId: null, cadence: 'daily',
      url: 'https://www.earthdata.nasa.gov/', description: 'Daily corrected-reflectance tiles (context, not live).',
      forceState: 'connected', forceLive: false, note: 'Daily satellite context with ~1-day latency — never a live feed.' },

    /* --- optional-key sources (server-side): disabled until the key is set --- */
    { id: 'reliefweb', name: 'ReliefWeb — Humanitarian reports', category: 'humanitarian',
      open: true, keyless: false, intelId: 'reliefweb', cadence: 'continuous',
      url: 'https://reliefweb.int/', envNames: ['RELIEFWEB_APPNAME'],
      description: 'Humanitarian situation reports (optional app-name identifier).' },
    { id: 'nass', name: 'USDA NASS — Quick Stats', category: 'market',
      open: true, keyless: false, intelId: 'nass', cadence: 'periodic',
      url: 'https://quickstats.nass.usda.gov/', envNames: ['NASS_KEY'],
      description: 'US crop statistics (requires a free API key).' },

    /* --- recommended ag sources: known endpoints, not yet wired server-side --- */
    { id: 'smap', name: 'NASA SMAP — Soil moisture', category: 'water',
      open: true, keyless: false, intelId: null, cadence: 'daily',
      url: 'https://smap.jpl.nasa.gov/', envNames: ['EARTHDATA_TOKEN'],
      registryReady: true, description: 'Surface soil moisture (Earthdata login/token).' },
    { id: 'gpm', name: 'NASA GPM/IMERG — Precipitation', category: 'weather',
      open: true, keyless: false, intelId: null, cadence: 'half-hourly',
      url: 'https://gpm.nasa.gov/', envNames: ['EARTHDATA_TOKEN'],
      registryReady: true, description: 'Global precipitation (Earthdata login/token).' },
    { id: 'grace', name: 'NASA GRACE-FO — Groundwater', category: 'water',
      open: true, keyless: false, intelId: null, cadence: 'monthly',
      url: 'https://grace.jpl.nasa.gov/', envNames: ['EARTHDATA_TOKEN'],
      registryReady: true, description: 'Aquifer/groundwater anomaly (Earthdata login/token).' },
    { id: 'copernicus', name: 'Copernicus — STAC / CDS', category: 'climate',
      open: true, keyless: false, intelId: null, cadence: 'varies',
      url: 'https://dataspace.copernicus.eu/', envNames: ['CDSAPI_KEY'],
      registryReady: true, description: 'Sentinel imagery + climate reanalysis (account/API key).' },
    { id: 'wri-aqueduct', name: 'WRI Aqueduct — Water risk', category: 'water',
      open: true, keyless: false, intelId: null, cadence: 'periodic',
      url: 'https://www.wri.org/aqueduct', envNames: ['WRI_API_KEY'],
      registryReady: true, description: 'Baseline water stress (API key/registration).' },
    { id: 'fao-aquastat', name: 'FAO AQUASTAT / WaPOR — Water productivity', category: 'water',
      open: true, keyless: false, intelId: null, cadence: 'periodic',
      url: 'https://data.apps.fao.org/wapor/', envNames: ['WAPOR_KEY'],
      registryReady: true, description: 'Water accounting & productivity (API key).' },
    { id: 'openfema', name: 'OpenFEMA — US disaster declarations', category: 'humanitarian',
      open: true, keyless: true, intelId: null, cadence: 'daily',
      url: 'https://www.fema.gov/about/openfema/api', registryReady: true,
      description: 'US disaster declarations (keyless; not yet wired server-side).' }
  ];
  var REGISTRY_BY_ID = {};
  REGISTRY.forEach(function (s) { REGISTRY_BY_ID[s.id] = s; });

  /* Names of secret env vars that must NEVER be exposed to the client. Used by
     the test that scans this file, and to defensively strip any that slip in. */
  var FORBIDDEN_SECRET_NAMES = ['DATABASE_URL', 'PPLX_KEY', 'AGRIOS_AUTH_SECRET', 'AGRIOS_SESSION_SECRET', 'MIGRATE_TOKEN'];

  /* Map a raw /api/intel per-source status to a registry connection state. */
  function mapIntelStatus(status) {
    switch (String(status || '').toLowerCase()) {
      case 'ok': case 'live': case 'fresh': return 'connected';
      case 'stale': return 'stale';
      case 'down': case 'error': case 'fail': return 'down';
      case 'disabled': case 'off': return 'disabled';
      default: return 'down';
    }
  }

  /* Default connection state for a registry entry that /api/intel didn't report. */
  function baselineState(entry) {
    if (entry.forceState) return entry.forceState;
    if (entry.registryReady) return 'registry-ready';
    if (!entry.keyless) return 'credential-required';
    return 'registry-ready';
  }

  /* Resolve the full source view from a real /api/intel payload.
     `intel` shape (all optional): { status, asOf, sources:[{id,status,asOf,latencyMs}] }.
     Returns one entry per registry source with a truthful state + live flag. */
  function resolve(intel) {
    intel = intel || {};
    var byId = {};
    (intel.sources || []).forEach(function (s) { if (s && s.id != null) byId[s.id] = s; });

    return REGISTRY.map(function (entry) {
      var health = entry.intelId ? byId[entry.intelId] : null;
      var state;
      if (health) state = mapIntelStatus(health.status);
      else state = baselineState(entry);

      // A forced-live-false source (GIBS) can be connected but is never "live".
      var live = state === 'connected' && entry.forceLive !== false;

      return {
        id: entry.id, name: entry.name, category: entry.category,
        state: state, live: live,
        asOf: (health && (health.asOf || health.observedAt)) || intel.asOf || null,
        latencyMs: (health && health.latencyMs) != null ? health.latencyMs : null,
        cadence: entry.cadence || null,
        url: entry.url || null,
        description: entry.description || '',
        note: entry.note || null,
        // NAMES only — never values.
        needs: (entry.envNames || []).slice(),
        credentialRequired: state === 'credential-required',
        registryReady: state === 'registry-ready'
      };
    });
  }

  /* Convenience: counts by state for the health header. */
  function summarize(resolved) {
    var counts = { connected: 0, live: 0, stale: 0, down: 0, disabled: 0, 'registry-ready': 0, 'credential-required': 0 };
    (resolved || []).forEach(function (r) { if (counts[r.state] != null) counts[r.state]++; if (r.live) counts.live++; });
    return counts;
  }

  var API = {
    STATES: STATES,
    REGISTRY: REGISTRY,
    REGISTRY_BY_ID: REGISTRY_BY_ID,
    FORBIDDEN_SECRET_NAMES: FORBIDDEN_SECRET_NAMES,
    mapIntelStatus: mapIntelStatus,
    baselineState: baselineState,
    resolve: resolve,
    summarize: summarize
  };
  root.EARTH_SOURCES = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
