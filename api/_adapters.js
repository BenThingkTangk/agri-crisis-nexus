// Source adapters for the AGRI-NEXUS ingestion pipeline.
//
// Each adapter is an async function `(deps) => rawRecord[]` where deps is
// { fetchImpl, now, env, timeoutMs }. Adapters return *raw* records shaped for
// normalizeEvent (they do not import global state); the aggregator normalizes,
// validates, dedupes and caches. fetchImpl is always injected so every adapter
// is unit-testable against fixtures with no network.
//
// The ten P0 sources implemented here (chosen from the data-source architecture
// report for immediate, mostly-keyless operation):
//   1. GDACS          hazard      keyless
//   2. USGS           hazard      keyless
//   3. NASA EONET     hazard      keyless
//   4. Open-Meteo     weather     keyless (non-commercial)
//   5. NASA POWER     weather     keyless
//   6. World Bank     market      keyless
//   7. FAOSTAT        market      keyless
//   8. ReliefWeb      humanitarian keyless-ish (appname requested; degrades)
//   9. GDELT          conflict    keyless
//  10. IMF PortWatch  logistics   keyless

import { fetchJSON, fetchText, severityFromScale, isFillValue } from './_sources.js';

// A small set of global breadbasket / import-hub reference points used by the
// point-query weather adapters (Open-Meteo, POWER). Keeping this list short
// bounds request fan-out and keeps the adapters Vercel-friendly.
export const REFERENCE_POINTS = [
  { name: 'US Corn Belt (Iowa)', lat: 41.9, lon: -93.6, domain: 'weather' },
  { name: 'Ukraine grain belt', lat: 49.0, lon: 32.0, domain: 'weather' },
  { name: 'Punjab (India/Pakistan)', lat: 30.5, lon: 74.5, domain: 'weather' },
  { name: 'Mato Grosso (Brazil)', lat: -13.0, lon: -56.0, domain: 'weather' },
  { name: 'North China Plain', lat: 35.0, lon: 115.0, domain: 'weather' },
];

// Countries tracked for World Bank food/economic indicators.
const WB_COUNTRIES = ['ET', 'SO', 'SD', 'YE', 'AF', 'NG'];

const GDACS_CATEGORY = { EQ: 'Seismic', TC: 'Tropical Cyclone', FL: 'Flood', DR: 'Drought', VO: 'Volcano', WF: 'Wildfire', TS: 'Tsunami' };
const GDACS_AGRI_TYPES = new Set(['DR', 'FL', 'TC', 'WF']);
const AGRI_KEYWORDS = /food|famine|hunger|drought|crop|harvest|agricultur|locust|flood|cyclone|storm|wildfire|conflict|displace|grain|wheat|maize|rice/i;

// ------------------------------------------------------------------ GDACS ----
export async function gdacs({ fetchImpl, timeoutMs = 5000 } = {}) {
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  return (j.features || [])
    .filter((f) => f && f.properties && GDACS_AGRI_TYPES.has(f.properties.eventtype))
    .map((f) => {
      const p = f.properties;
      const c = (f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [null, null];
      return {
        rawId: (p.eventtype || 'E') + (p.eventid != null ? p.eventid : ''),
        domain: 'hazard',
        category: GDACS_CATEGORY[p.eventtype] || 'Disaster',
        title: p.name || p.eventname || (GDACS_CATEGORY[p.eventtype] || 'Disaster alert'),
        severity: p.alertlevel,
        geography: p.country || 'Global',
        lat: typeof c[1] === 'number' ? c[1] : null,
        lon: typeof c[0] === 'number' ? c[0] : null,
        published: p.fromdate ? new Date(p.fromdate).toISOString() : null,
        sourceUrl: (p.url && p.url.report) || 'https://www.gdacs.org',
        confidence: 0.85,
      };
    });
}

// ------------------------------------------------------------------- USGS ----
export async function usgs({ fetchImpl, timeoutMs = 5000 } = {}) {
  const url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  return (j.features || []).slice(0, 15).map((f) => {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [null, null];
    const mag = p.mag || 0;
    return {
      rawId: f.id,
      domain: 'hazard',
      category: 'Seismic',
      title: 'M' + mag.toFixed(1) + ' earthquake — ' + (p.place || 'unknown'),
      severity: severityFromScale(mag, [4.5, 5.5, 6.5]),
      geography: p.place || 'Global',
      lat: c[1], lon: c[0],
      value: mag, unit: 'Mw',
      published: p.time ? new Date(p.time).toISOString() : null,
      sourceUrl: p.url || 'https://earthquake.usgs.gov',
      confidence: 0.95,
    };
  });
}

// ------------------------------------------------------------------ EONET ----
export async function eonet({ fetchImpl, timeoutMs = 5000 } = {}) {
  const url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=30';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  return (j.events || [])
    .map((e) => {
      const cat = (e.categories && e.categories[0] && e.categories[0].title) || 'Natural event';
      const geo = e.geometry && e.geometry[e.geometry.length - 1];
      const coords = geo && geo.coordinates;
      const isPoint = Array.isArray(coords) && typeof coords[0] === 'number';
      return {
        rawId: e.id,
        domain: 'hazard',
        category: cat,
        title: e.title,
        severity: /drought|wildfire|flood/i.test(cat) ? 'high' : 'moderate',
        geography: cat,
        lat: isPoint ? coords[1] : null,
        lon: isPoint ? coords[0] : null,
        published: (geo && geo.date) || null,
        sourceUrl: (e.sources && e.sources[0] && e.sources[0].url) || e.link || 'https://eonet.gsfc.nasa.gov',
        confidence: 0.8,
      };
    })
    .filter((i) => /drought|wildfire|flood|storm|severe|temperature/i.test(i.category + ' ' + i.title));
}

// ------------------------------------------------------------- Open-Meteo ----
// Current conditions at reference agricultural points; emits an indicator with
// a deterministic severity from wind/precip. Observed measurement, not forecast.
export async function openmeteo({ fetchImpl, timeoutMs = 5000, points = REFERENCE_POINTS } = {}) {
  const lats = points.map((p) => p.lat).join(',');
  const lons = points.map((p) => p.lon).join(',');
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lats) +
    '&longitude=' + encodeURIComponent(lons) +
    '&current=temperature_2m,precipitation,wind_speed_10m';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  // Open-Meteo returns an array of location objects when multiple coords given,
  // or a single object for one coord.
  const arr = Array.isArray(j) ? j : [j];
  const out = [];
  arr.forEach((loc, i) => {
    const cur = loc && loc.current;
    if (!cur) return;
    const pt = points[i] || points[0];
    const wind = Number(cur.wind_speed_10m) || 0;
    const precip = Number(cur.precipitation) || 0;
    const sev = severityFromScale(Math.max(wind, precip * 6), [15, 30, 55]);
    out.push({
      rawId: 'om-' + pt.lat + '_' + pt.lon,
      domain: 'weather',
      category: 'Field weather',
      title: pt.name + ' — ' + (cur.temperature_2m != null ? cur.temperature_2m + '°C, ' : '') + 'wind ' + wind + ' km/h',
      severity: sev,
      geography: pt.name,
      lat: pt.lat, lon: pt.lon,
      value: wind, unit: 'km/h wind',
      published: (cur.time ? new Date(cur.time).toISOString() : null),
      sourceUrl: 'https://open-meteo.com/',
      confidence: 0.7,
    });
  });
  return out;
}

// ------------------------------------------------------------- NASA POWER ----
// Daily agro-climate (T2M, precip) at one anchor point. Keyless. Emits a single
// agro-climate indicator; kept to one point to bound latency on serverless.
//
// POWER encodes missing observations as the documented fill value -999. We must
// never surface that as telemetry ("mean temp -999°C"), so we scan the returned
// range newest-first and backfill to the latest day whose T2M is a real, finite,
// physically-plausible measurement. If no valid day remains, we emit no event
// and surface an explicit no-data error so the source is marked degraded rather
// than reported LIVE with fabricated numbers.
const POWER_TEMP_MIN = -90; // coldest plausible daily mean surface air temp (°C)
const POWER_TEMP_MAX = 60;  // hottest plausible daily mean surface air temp (°C)

function powerNoData(reason) { const e = new Error('no-data: ' + reason); e.noData = true; return e; }

export async function power({ fetchImpl, timeoutMs = 6000, point = REFERENCE_POINTS[0], now = new Date() } = {}) {
  const end = new Date(now.getTime() - 2 * 86400000); // POWER NRT lags ~1-2 days
  const start = new Date(end.getTime() - 6 * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = 'https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M,PRECTOTCORR' +
    '&community=AG&longitude=' + point.lon + '&latitude=' + point.lat +
    '&start=' + fmt(start) + '&end=' + fmt(end) + '&format=JSON';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const params = (j.properties && j.properties.parameter) || {};
  const t2m = params.T2M || {};
  const precipAll = params.PRECTOTCORR || {};
  const keys = Object.keys(t2m).sort(); // ascending YYYYMMDD
  if (!keys.length) throw powerNoData('empty T2M series');

  // Backfill: walk newest -> oldest, take the first valid (non-fill, in-range) day.
  let dayKey = null, temp = null;
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    const t = Number(t2m[k]);
    if (isFillValue(t)) continue;                       // -999 sentinel / NaN / Infinity
    if (t < POWER_TEMP_MIN || t > POWER_TEMP_MAX) continue; // implausible extreme
    dayKey = k; temp = t; break;
  }
  if (dayKey == null) throw powerNoData('all days missing/sentinel over requested range');

  const rawPrecip = Number(precipAll[dayKey]);
  const precip = isFillValue(rawPrecip) ? null : rawPrecip; // precip may still be fill
  const iso = dayKey.slice(0, 4) + '-' + dayKey.slice(4, 6) + '-' + dayKey.slice(6, 8) + 'T00:00:00Z';
  return [{
    rawId: 'power-' + point.lat + '_' + point.lon + '-' + dayKey,
    domain: 'weather',
    category: 'Agro-climate',
    title: point.name + ' — mean temp ' + temp + '°C',
    severity: severityFromScale(temp, [30, 35, 40]),
    geography: point.name,
    lat: point.lat, lon: point.lon,
    value: temp, unit: '°C mean',
    published: iso,
    sourceUrl: 'https://power.larc.nasa.gov/',
    confidence: 0.75,
    extra: { precipMm: precip },
  }];
}

// ------------------------------------------------------------- World Bank ----
// Latest value of a food-security-relevant indicator (inflation, consumer
// prices) for a set of exposed countries. Keyless JSON API.
export async function worldbank({ fetchImpl, timeoutMs = 6000, countries = WB_COUNTRIES, indicator = 'FP.CPI.TOTL.ZG' } = {}) {
  // mrv=6 = most-recent 6 years per country; we then keep the latest non-null
  // value for each. (The mrnev=1 "most-recent-non-empty" param currently 400s.)
  const url = 'https://api.worldbank.org/v2/country/' + countries.join(';') +
    '/indicator/' + indicator + '?format=json&per_page=400&mrv=6';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const all = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
  // Rows arrive newest-first per country; keep the first non-null per country.
  const latestByCountry = new Map();
  for (const r of all) {
    if (!r || r.value == null) continue;
    const key = r.countryiso3code || (r.country && r.country.id) || '';
    if (!latestByCountry.has(key)) latestByCountry.set(key, r);
  }
  const rows = Array.from(latestByCountry.values());
  return rows
    .filter((r) => r && r.value != null)
    .map((r) => {
      const val = Number(r.value);
      return {
        rawId: 'wb-' + (r.countryiso3code || (r.country && r.country.id) || '') + '-' + (r.date || ''),
        domain: 'market',
        category: 'Inflation (CPI, annual %)',
        title: ((r.country && r.country.value) || 'Country') + ' — CPI ' + val.toFixed(1) + '% (' + r.date + ')',
        severity: severityFromScale(val, [8, 20, 40]),
        geography: (r.country && r.country.value) || 'Global',
        lat: null, lon: null,
        value: val, unit: '% annual',
        published: (r.date ? r.date + '-12-31T00:00:00Z' : null),
        sourceUrl: 'https://data.worldbank.org/indicator/' + indicator,
        confidence: 0.9,
      };
    });
}

// ---------------------------------------------------------------- FAOSTAT ----
// Latest world cereal production total (FAOSTAT QCL). Keyless JSON. Emits one
// production indicator; FAOSTAT is annual/global so this is a slow-moving stat.
export async function faostat({ fetchImpl, timeoutMs = 7000 } = {}) {
  // area 5000 = World; item 1717 = Cereals (primary); element 5510 = Production (t).
  const url = 'https://fenixservices.fao.org/faostat/api/v1/en/data/QCL?area=5000&item=1717&element=5510&show_flags=false&limit=6&sort=year:desc';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const data = (j && j.data) || [];
  if (!data.length) return [];
  const latest = data[0];
  const val = Number(latest.Value || latest.value);
  return [{
    rawId: 'fao-cereals-' + (latest.Year || latest.year),
    domain: 'market',
    category: 'World cereal production',
    title: 'World cereal production ' + (latest.Year || latest.year) + ' — ' + (Number.isFinite(val) ? (val / 1e6).toFixed(0) + ' Mt' : 'n.a.'),
    severity: 'moderate',
    geography: 'World',
    lat: null, lon: null,
    value: Number.isFinite(val) ? val : null, unit: 'tonnes',
    published: ((latest.Year || latest.year) ? (latest.Year || latest.year) + '-12-31T00:00:00Z' : null),
    sourceUrl: 'https://www.fao.org/faostat/en/#data/QCL',
    confidence: 0.85,
  }];
}

// -------------------------------------------------------------- ReliefWeb ----
// Situation reports. Uses the v2 POST contract with an approved appname when
// RELIEFWEB_APPNAME is set; without it, the adapter is disabled (returns []),
// and the aggregate marks the source 'disabled' rather than failing.
export async function reliefweb({ fetchImpl, timeoutMs = 5000, env = process.env } = {}) {
  const appname = (env.RELIEFWEB_APPNAME || '').trim();
  if (!appname) { const e = new Error('disabled: RELIEFWEB_APPNAME not set'); e.disabled = true; throw e; }
  const url = 'https://api.reliefweb.int/v2/reports?appname=' + encodeURIComponent(appname);
  const payload = {
    fields: { include: ['title', 'date.created', 'url_alias', 'primary_country.name', 'disaster_type.name'] },
    filter: { operator: 'OR', conditions: [{ field: 'disaster_type.name', value: ['Drought', 'Flood', 'Food Insecurity', 'Tropical Cyclone', 'Wild Fire', 'Epidemic'] }] },
    sort: ['date.created:desc'],
    limit: 18,
  };
  const j = await fetchJSON(url, { fetchImpl, timeoutMs, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return (j.data || []).map((d) => {
    const f = d.fields || {};
    const country = (f.primary_country && f.primary_country.name) || 'Global';
    const type = (f.disaster_type && f.disaster_type[0] && f.disaster_type[0].name) || 'Humanitarian';
    return {
      rawId: 'rw-' + d.id,
      domain: 'humanitarian',
      category: type,
      title: f.title || 'Humanitarian situation update',
      severity: /famine|food|hunger|drought/i.test((f.title || '') + ' ' + type) ? 'critical' : 'moderate',
      geography: country,
      lat: null, lon: null,
      published: (f.date && f.date.created) || null,
      sourceUrl: f.url_alias || 'https://reliefweb.int',
      confidence: 0.7,
    };
  }).filter((i) => AGRI_KEYWORDS.test(i.title + ' ' + i.category));
}

// ------------------------------------------------------------------ GDELT ----
// Global news events touching food-crisis themes. Keyless DOC 2.0 API.
export async function gdelt({ fetchImpl, timeoutMs = 6000 } = {}) {
  const q = '(food crisis OR famine OR grain export OR wheat shortage OR fertilizer)';
  const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=' + encodeURIComponent(q) +
    '&mode=artlist&maxrecords=25&format=json&sort=datedesc&timespan=3d';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  return (j.articles || []).slice(0, 20).map((a) => ({
    rawId: 'gdelt-' + (a.url ? a.url.replace(/[^a-z0-9]/gi, '').slice(-24) : Math.random().toString(36).slice(2)),
    domain: 'conflict',
    category: 'News signal',
    title: a.title || 'News signal',
    severity: /famine|shortage|export ban|blockade|war/i.test(a.title || '') ? 'high' : 'moderate',
    geography: a.sourcecountry || 'Global',
    lat: null, lon: null,
    published: a.seendate ? isoFromGdelt(a.seendate) : null,
    sourceUrl: a.url || 'https://www.gdeltproject.org',
    confidence: 0.55,
  }));
}

function isoFromGdelt(s) {
  // GDELT seendate format: YYYYMMDDThhmmssZ
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s));
  if (!m) { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString(); }
  return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z';
}

// ------------------------------------------------------------- IMF PortWatch --
// Chokepoint disruption features from the public ArcGIS FeatureServer. Keyless
// GeoJSON. Emits chokepoint-status indicators with observed coordinates.
export async function portwatch({ fetchImpl, timeoutMs = 7000 } = {}) {
  const url = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/PortWatch_chokepoints_database/FeatureServer/0/query' +
    '?where=1%3D1&outFields=*&f=geojson&resultRecordCount=25';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  return (j.features || []).slice(0, 25).map((f) => {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [null, null];
    const name = p.portname || p.chokepoint || p.name || 'Chokepoint';
    const vol = Number(p.vessel_count || p.total_volume || p.trade_volume);
    return {
      rawId: 'pw-' + (p.objectid != null ? p.objectid : (p.portid != null ? p.portid : name)),
      domain: 'logistics',
      category: 'Maritime chokepoint',
      title: name + ' — maritime transit point',
      severity: 'moderate',
      geography: name,
      lat: typeof c[1] === 'number' ? c[1] : null,
      lon: typeof c[0] === 'number' ? c[0] : null,
      value: Number.isFinite(vol) ? vol : null, unit: 'vessels/period',
      published: null,
      sourceUrl: 'https://portwatch.imf.org/',
      confidence: 0.8,
    };
  });
}

// Registry the aggregator iterates. `id` maps to SOURCES; `run` is the adapter.
export const ADAPTERS = [
  { id: 'gdacs', run: gdacs, ttlMs: 300_000 },
  { id: 'usgs', run: usgs, ttlMs: 300_000 },
  { id: 'eonet', run: eonet, ttlMs: 600_000 },
  { id: 'openmeteo', run: openmeteo, ttlMs: 900_000 },
  { id: 'power', run: power, ttlMs: 3_600_000 },
  { id: 'worldbank', run: worldbank, ttlMs: 21_600_000 },
  { id: 'faostat', run: faostat, ttlMs: 43_200_000 },
  { id: 'reliefweb', run: reliefweb, ttlMs: 900_000 },
  { id: 'gdelt', run: gdelt, ttlMs: 900_000 },
  { id: 'portwatch', run: portwatch, ttlMs: 3_600_000 },
];
