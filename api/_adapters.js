// Source adapters for the AGRI-NEXUS ingestion pipeline.
//
// Each adapter is an async function `(deps) => rawRecord[]` where deps is
// { fetchImpl, now, env, timeoutMs }. Adapters return *raw* records shaped for
// normalizeEvent (they do not import global state); the aggregator normalizes,
// validates, dedupes and caches. fetchImpl is always injected so every adapter
// is unit-testable against fixtures with no network.
//
// The eleven sources implemented here (chosen from the data-source architecture
// report for immediate operation; ten keyless P0 + one keyed USDA source):
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
//  11. USDA NASS      market      keyed (USDA_NASS_API_KEY; degrades when unset)

import { fetchJSON, fetchText, severityFromScale, isFillValue, mapLimit, withRetry } from './_sources.js';

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

// --------------------------------------------------------------- USDA NASS ---
// USDA National Agricultural Statistics Service — Quick Stats API.
//
// The API key is read ONLY from env.USDA_NASS_API_KEY, server-side. It is placed
// solely in the outbound request query string (the endpoint's documented `key`
// param) and never appears in any record we emit: provenance/sourceUrl point at
// the public Quick Stats site, and thrown errors carry only generic messages
// (fetchText throws `HTTP <status>`), so the key can never reach client
// provenance, logs, API responses, error messages, or the (id-only) cache key.
//
// Query strategy (deliberately tight + bounded — no broad downloads):
//   national, annual PRODUCTION totals for four major staples, pinned by exact
//   `short_desc` so we get exactly the grain/oilseed series and nothing else,
//   restricted to the most recent NASS_YEAR_WINDOW years. That returns a handful
//   of rows per commodity, well under the API's row cap, in a single request.
// If the latest year's value is unavailable/suppressed we backfill to the latest
// year in the window whose value is a real number.
const NASS_ENDPOINT = 'https://quickstats.nass.usda.gov/api/api_GET/';
const NASS_HOMEPAGE = 'https://quickstats.nass.usda.gov/';
const NASS_YEAR_WINDOW = 3; // current year plus the three prior years
const NASS_SERIES = [
  { short: 'CORN, GRAIN - PRODUCTION, MEASURED IN BU', commodity: 'Corn (grain)', unit: 'bushels' },
  { short: 'WHEAT - PRODUCTION, MEASURED IN BU', commodity: 'Wheat', unit: 'bushels' },
  { short: 'SOYBEANS - PRODUCTION, MEASURED IN BU', commodity: 'Soybeans', unit: 'bushels' },
  { short: 'RICE - PRODUCTION, MEASURED IN CWT', commodity: 'Rice', unit: 'cwt' },
];

// Parse a NASS `Value`: strip thousands separators; treat suppression/formatting
// codes — (D) withheld, (Z) < half rounding unit, (NA), (X) not applicable,
// (S)/(L) insufficient, blanks, and any other non-numeric text — as no-data
// (null). Never fabricates a number.
export function parseNassValue(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.charAt(0) === '(') return null;          // (D) (Z) (NA) (X) (S) (L) ...
  const cleaned = s.replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatBig(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

export async function nass({ fetchImpl, timeoutMs = 7000, env = process.env, now = new Date() } = {}) {
  // Resolve the key from the injected env, falling back to process.env so a
  // present process.env.USDA_NASS_API_KEY always enables the source regardless
  // of how env is threaded. Distinguish "absent" from "present but blank" in the
  // disabled reason (a common misconfig: a trailing newline or quoted empty
  // value) — the reason never contains the value itself, only its state.
  const src = (env && env.USDA_NASS_API_KEY != null)
    ? env.USDA_NASS_API_KEY
    : (typeof process !== 'undefined' && process.env ? process.env.USDA_NASS_API_KEY : undefined);
  const present = src != null;
  const key = String(src == null ? '' : src).trim();
  if (!key) {
    const e = new Error('disabled: USDA_NASS_API_KEY ' + (present ? 'is set but blank' : 'not set'));
    e.disabled = true;
    throw e;
  }

  const yr = new Date(now).getUTCFullYear();
  const qs = new URLSearchParams();
  qs.set('key', key);
  NASS_SERIES.forEach((s) => qs.append('short_desc', s.short));
  qs.set('agg_level_desc', 'NATIONAL');
  qs.set('year__GE', String(yr - NASS_YEAR_WINDOW));
  qs.set('format', 'JSON');
  const url = NASS_ENDPOINT + '?' + qs.toString();

  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const data = (j && Array.isArray(j.data)) ? j.data : [];

  const out = [];
  for (const spec of NASS_SERIES) {
    const rows = data
      .filter((r) => r && r.short_desc === spec.short)
      .sort((a, b) => Number(b.year) - Number(a.year)); // newest first
    let chosen = null, val = null;
    for (const r of rows) {                 // backfill to latest year with a real value
      const v = parseNassValue(r.Value != null ? r.Value : r.value);
      if (v != null) { chosen = r; val = v; break; }
    }
    if (!chosen) continue;                  // no valid year -> emit nothing (never fabricate)
    const year = String(chosen.year || '');
    const unit = (String(chosen.unit_desc || '').trim() || spec.unit).toLowerCase();
    out.push({
      rawId: 'nass-' + spec.commodity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-production-national-' + year,
      domain: 'market',
      category: 'US crop production',
      title: 'US ' + spec.commodity + ' production ' + year + ' — ' + formatBig(val) + ' ' + unit,
      severity: 'moderate',
      geography: 'United States',
      lat: null, lon: null,
      value: val, unit,
      published: year ? year + '-12-31T00:00:00Z' : null,
      sourceUrl: NASS_HOMEPAGE,
      confidence: 0.92,
      extra: { year, statistic: 'PRODUCTION', aggLevel: 'NATIONAL', shortDesc: spec.short },
    });
  }
  return out;
}

// --------------------------------------------------------------- helpers -----
// Minimal, dependency-free CSV parser. Handles the un-quoted numeric feeds we
// consume (FIRMS) plus defensive double-quote support. Returns an array of
// row objects keyed by the (trimmed) header names. Never throws on ragged rows.
export function parseCsv(text) {
  const rows = [];
  const lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);
  let header = null;
  for (const line of lines) {
    if (line === '') continue;
    const cells = splitCsvLine(line);
    if (!header) { header = cells.map((c) => c.trim()); continue; }
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = cells[i] != null ? cells[i] : '';
    rows.push(obj);
  }
  return rows;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// FIRMS acq_date (YYYY-MM-DD) + acq_time (Hmm/HHmm minutes-of-day) -> ISO Z.
function firmsIso(date, time) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = String(time == null ? '' : time).trim().replace(/[^0-9]/g, '');
  const padded = t.length ? t.padStart(4, '0').slice(-4) : '0000';
  const hh = padded.slice(0, 2), mm = padded.slice(2, 4);
  return d + 'T' + hh + ':' + mm + ':00Z';
}

// --------------------------------------------------------------- NASA FIRMS --
// Fire Information for Resource Management System — near-real-time active-fire
// detections (VIIRS S-NPP). Requires a free MAP_KEY.
//
// The key is read ONLY from env.FIRMS_MAP_KEY (server-side) and placed SOLELY in
// the documented outbound URL path segment. It never appears in any emitted
// record: provenance/sourceUrl point at the public FIRMS site, and thrown errors
// carry only generic messages. When the key is absent/blank the adapter throws a
// `disabled` error so the source is marked disabled rather than failing.
//
// Fan-out is bounded: a small set of breadbasket bounding boxes queried at
// concurrency 2, DAY_RANGE clamped to the API max of 5, results collapsed and
// capped to the top detections by Fire Radiative Power (FRP).
const FIRMS_ENDPOINT = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_HOMEPAGE = 'https://firms.modaps.eosdis.nasa.gov/';
const FIRMS_SOURCE = 'VIIRS_SNPP_NRT';
// [west, south, east, north] boxes around the major breadbaskets.
const FIRMS_AREAS = [
  { name: 'US Corn Belt', box: [-104, 36, -82, 49] },
  { name: 'Ukraine/Black Sea grain belt', box: [22, 44, 42, 53] },
  { name: 'South Asia (Indo-Gangetic)', box: [68, 22, 90, 33] },
  { name: 'Brazil Cerrado/Mato Grosso', box: [-62, -22, -44, -6] },
  { name: 'North China Plain', box: [108, 30, 122, 41] },
];

export async function firms({ fetchImpl, timeoutMs = 8000, env = process.env, dayRange = 1, areas = FIRMS_AREAS } = {}) {
  const src = (env && env.FIRMS_MAP_KEY != null)
    ? env.FIRMS_MAP_KEY
    : (typeof process !== 'undefined' && process.env ? process.env.FIRMS_MAP_KEY : undefined);
  const present = src != null;
  const key = String(src == null ? '' : src).trim();
  if (!key) {
    const e = new Error('disabled: FIRMS_MAP_KEY ' + (present ? 'is set but blank' : 'not set'));
    e.disabled = true;
    throw e;
  }
  const dr = Math.max(1, Math.min(5, Math.floor(Number(dayRange) || 1)));

  const perArea = await mapLimit(areas, 2, async (a) => {
    const areaStr = a.box.join(',');
    const url = FIRMS_ENDPOINT + '/' + encodeURIComponent(key) + '/' + FIRMS_SOURCE + '/' +
      encodeURIComponent(areaStr) + '/' + dr;
    let text;
    try { text = await fetchText(url, { fetchImpl, timeoutMs, maxBytes: 2_000_000 }); }
    catch (_) { return []; }               // one box failing must not sink the source
    const rows = parseCsv(text);
    return rows.map((r) => {
      const lat = Number(r.latitude), lon = Number(r.longitude);
      const frp = Number(r.frp);
      const conf = String(r.confidence || '').trim();
      const iso = firmsIso(r.acq_date, r.acq_time);
      return {
        _frp: Number.isFinite(frp) ? frp : 0,
        rawId: 'firms-' + (Number.isFinite(lat) ? lat.toFixed(4) : 'x') + '_' +
          (Number.isFinite(lon) ? lon.toFixed(4) : 'x') + '-' + (r.acq_date || '') + (r.acq_time || ''),
        domain: 'hazard',
        category: 'Active fire',
        title: a.name + ' — active fire' + (Number.isFinite(frp) ? ' (FRP ' + frp.toFixed(0) + ' MW)' : ''),
        severity: severityFromScale(Number.isFinite(frp) ? frp : 0, [10, 50, 150]),
        geography: a.name,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null,
        value: Number.isFinite(frp) ? frp : null, unit: 'MW FRP',
        published: iso,
        sourceUrl: FIRMS_HOMEPAGE,
        confidence: /^h/i.test(conf) ? 0.9 : /^n/i.test(conf) ? 0.7 : 0.6,
        evidence: 'observed',
      };
    });
  });

  const all = [];
  for (const list of perArea) for (const rec of list) all.push(rec);
  all.sort((x, y) => y._frp - x._frp);
  return all.slice(0, 60).map((r) => { const { _frp, ...rest } = r; return rest; });
}

// ----------------------------------------------------------- USDA FAS PSD ----
// Foreign Agricultural Service — Production, Supply & Distribution (PSD Online).
// World-level supply metrics for high-value commodities. Requires USDA_FAS_API_KEY.
//
// The key is read ONLY from env.USDA_FAS_API_KEY and passed SOLELY in the
// documented `X-Api-Key` request header — never in a URL, an emitted record, an
// error message, or the cache key. Absent/blank => `disabled` (source disabled,
// not failed). Backfills the requested marketing year to the prior year when the
// latest is not yet published.
const FAS_BASE = 'https://api.fas.usda.gov/api/psd';
const FAS_HOMEPAGE = 'https://apps.fas.usda.gov/psdonline/';
// commodityCode + the Production attributeId (28 = "Production" in PSD).
const FAS_COMMODITIES = [
  { code: '0410000', name: 'Wheat', unit: '1000 MT' },
  { code: '0440000', name: 'Corn', unit: '1000 MT' },
  { code: '0422110', name: 'Rice, milled', unit: '1000 MT' },
  { code: '2222000', name: 'Soybeans', unit: '1000 MT' },
];
const FAS_PRODUCTION_ATTR = 28;

export async function faspsd({ fetchImpl, timeoutMs = 8000, env = process.env, now = new Date(), commodities = FAS_COMMODITIES } = {}) {
  const src = (env && env.USDA_FAS_API_KEY != null)
    ? env.USDA_FAS_API_KEY
    : (typeof process !== 'undefined' && process.env ? process.env.USDA_FAS_API_KEY : undefined);
  const present = src != null;
  const key = String(src == null ? '' : src).trim();
  if (!key) {
    const e = new Error('disabled: USDA_FAS_API_KEY ' + (present ? 'is set but blank' : 'not set'));
    e.disabled = true;
    throw e;
  }
  const headers = { 'X-Api-Key': key, accept: 'application/json' };
  const marketYear = new Date(now).getUTCFullYear();

  const results = await mapLimit(commodities, 2, async (c) => {
    // Try the current marketing year, then backfill one year if unpublished.
    for (const yr of [marketYear, marketYear - 1]) {
      const url = FAS_BASE + '/commodity/' + encodeURIComponent(c.code) + '/country/all/year/' + yr;
      let j;
      try { j = await fetchJSON(url, { fetchImpl, timeoutMs, headers }); }
      catch (_) { continue; }
      const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
      // World roll-up: sum Production across countries for this commodity/year.
      let total = 0, hit = false;
      for (const row of arr) {
        const attr = Number(row.attributeId != null ? row.attributeId : row.AttributeId);
        if (attr !== FAS_PRODUCTION_ATTR) continue;
        const v = Number(row.value != null ? row.value : row.Value);
        if (!Number.isFinite(v)) continue;
        total += v; hit = true;
      }
      if (hit) return { commodity: c, year: yr, total };
    }
    return null;
  });

  return results.filter(Boolean).map((r) => ({
    rawId: 'faspsd-' + r.commodity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-production-' + r.year,
    domain: 'market',
    category: 'Global production (PSD)',
    title: 'World ' + r.commodity.name + ' production ' + r.year + '/' + String((r.year + 1) % 100).padStart(2, '0') + ' — ' + formatBig(r.total) + ' ' + r.commodity.unit,
    severity: 'moderate',
    geography: 'World',
    lat: null, lon: null,
    value: r.total, unit: r.commodity.unit,
    published: r.year + '-12-31T00:00:00Z',
    sourceUrl: FAS_HOMEPAGE,
    confidence: 0.9,
    extra: { marketingYear: r.year, statistic: 'PRODUCTION', commodityCode: r.commodity.code },
  }));
}

// ------------------------------------------------------ WFP HungerMap LIVE ----
// World Food Programme HungerMap — country-level food-insecurity nowcasts
// (people with insufficient food consumption). Keyless public JSON, ~6h refresh.
//
// Robustness (defect fix): the bulk `/v2/adm0data.json` endpoint intermittently
// hangs/aborts from serverless egress. We therefore (1) call it with a bounded
// retry + a larger byte cap, and (2) fall back to a bounded set of high-risk
// country nowcasts via `/v1/foodsecurity/country/{iso3}` when the bulk call
// fails or returns nothing. If BOTH paths fail we throw so the pipeline reports
// the source as down/stale — we never fabricate food-insecurity data.
const HUNGERMAP_BULK = 'https://api.hungermapdata.org/v2/adm0data.json';
const HUNGERMAP_COUNTRY = 'https://api.hungermapdata.org/v1/foodsecurity/country/';
// Bounded fallback roster — major food-crisis countries. Kept short on purpose:
// the fallback runs as a single concurrent batch, so bulk-abort + fallback stay
// comfortably under the adapter deadline enforced in _aggregate.js.
const HUNGERMAP_FALLBACK_ISO3 = ['SOM', 'AFG', 'YEM', 'SDN', 'SSD', 'ETH'];

// Build a normalized raw record from loosely-shaped country properties.
function hmRecord(props) {
  const name = props.Country || props.country || props.name || (props.iso3 || 'Country');
  const fcs = props.fcs || (props.metrics && props.metrics.fcs) || null;
  const people = fcs && (fcs.people != null ? fcs.people : (fcs.people_total != null ? fcs.people_total : null));
  const prevalence = fcs && (fcs.prevalence != null ? fcs.prevalence
    : (fcs.ratio && fcs.ratio.ratio != null ? fcs.ratio.ratio : null));
  const p = (prevalence == null) ? NaN : Number(prevalence);
  const ppl = (people == null) ? NaN : Number(people);
  if (!Number.isFinite(p) && !Number.isFinite(ppl)) return null;
  const pct = Number.isFinite(p) ? (p <= 1 ? p * 100 : p) : null;
  return {
    rawId: 'hm-' + String(props.iso3 || props.iso || name).toLowerCase().replace(/[^a-z0-9]+/g, ''),
    domain: 'humanitarian',
    category: 'Food insecurity (FCS)',
    title: name + ' — insufficient food consumption' +
      (Number.isFinite(ppl) ? ' ' + formatBig(ppl) + ' people' : '') +
      (pct != null ? ' (' + pct.toFixed(0) + '%)' : ''),
    severity: severityFromScale(pct != null ? pct : 0, [20, 40, 60]),
    geography: name,
    lat: Number(props.centroid_lat != null ? props.centroid_lat : (props.lat != null ? props.lat : NaN)) || null,
    lon: Number(props.centroid_lon != null ? props.centroid_lon : (props.lon != null ? props.lon : NaN)) || null,
    value: pct != null ? pct : (Number.isFinite(ppl) ? ppl : null),
    unit: pct != null ? '% insufficient food' : 'people',
    published: props.date || props.updated || null,
    sourceUrl: 'https://hungermap.wfp.org/',
    confidence: 0.75,
  };
}

export async function hungermap({ fetchImpl, timeoutMs = 2500, countryIso3 = HUNGERMAP_FALLBACK_ISO3 } = {}) {
  // The bulk endpoint has been observed to hang in production, so we give it a
  // short single-attempt budget (no retry — retrying a hang just burns the
  // deadline) and abort fast, leaving room for the per-country fallback.
  const bulkTimeout = Math.min(timeoutMs, 1800);
  try {
    const j = await fetchJSON(HUNGERMAP_BULK, { fetchImpl, timeoutMs: bulkTimeout, maxBytes: 8_000_000 });
    const countries = (j && Array.isArray(j.countries)) ? j.countries
      : (j && j.body && Array.isArray(j.body.countries)) ? j.body.countries
      : (Array.isArray(j) ? j : []);
    const out = [];
    for (const c of countries) {
      const rec = hmRecord((c && c.properties) || c || {});
      if (rec) out.push(rec);
    }
    if (out.length) return out;
  } catch (e) { /* fall through to bounded per-country fallback */ }

  // Fallback: bounded per-country nowcasts in a single concurrent batch (limit =
  // roster size) with a tight per-request timeout, so the whole fallback is one
  // network round. Best-effort — each country failure is swallowed; we aggregate
  // whatever resolves.
  const countryTimeout = Math.min(timeoutMs, 1000);
  const results = await mapLimit(countryIso3, countryIso3.length || 1, async (iso3) => {
    try {
      const j = await fetchJSON(HUNGERMAP_COUNTRY + encodeURIComponent(iso3), { fetchImpl, timeoutMs: countryTimeout });
      const b = (j && j.body) || j || {};
      const country = b.country || {};
      return hmRecord({
        Country: country.name, iso3: country.iso3 || iso3,
        metrics: b.metrics, date: b.date,
      });
    } catch (e) { return null; }
  });
  const out = results.filter(Boolean);
  if (!out.length) throw new Error('HungerMap unavailable (bulk + per-country fallback failed)');
  return out;
}

// ------------------------------------------------ UNHCR Refugee Statistics ----
// Forced-displacement flows aggregated by country of asylum. Keyless JSON.
export async function unhcr({ fetchImpl, timeoutMs = 7000, now = new Date() } = {}) {
  const yr = new Date(now).getUTCFullYear() - 1; // latest fully-published year
  const url = 'https://api.unhcr.org/population/v1/population/?limit=1000&yearFrom=' + yr +
    '&yearTo=' + yr + '&coa_all=true';
  const j = await fetchJSON(url, { fetchImpl, timeoutMs });
  const items = (j && Array.isArray(j.items)) ? j.items : (Array.isArray(j) ? j : []);
  const byAsylum = new Map();
  for (const it of items) {
    const coa = it.coa_name || it.coa || 'Unknown';
    const refugees = Number(it.refugees) || 0;
    const asylum = Number(it.asylum_seekers) || 0;
    const idp = Number(it.idps) || 0;
    const prev = byAsylum.get(coa) || { coa, refugees: 0, asylum: 0, idp: 0 };
    prev.refugees += refugees; prev.asylum += asylum; prev.idp += idp;
    byAsylum.set(coa, prev);
  }
  const rows = Array.from(byAsylum.values())
    .map((r) => ({ ...r, total: r.refugees + r.asylum + r.idp }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);
  return rows.map((r) => ({
    rawId: 'unhcr-' + String(r.coa).toLowerCase().replace(/[^a-z0-9]+/g, '') + '-' + yr,
    domain: 'humanitarian',
    category: 'Forced displacement',
    title: r.coa + ' — ' + formatBig(r.total) + ' displaced (' + yr + ')',
    severity: severityFromScale(r.total, [100_000, 500_000, 1_500_000]),
    geography: r.coa,
    lat: null, lon: null,
    value: r.total, unit: 'people',
    published: yr + '-12-31T00:00:00Z',
    sourceUrl: 'https://www.unhcr.org/refugee-statistics/',
    confidence: 0.85,
    extra: { refugees: r.refugees, asylumSeekers: r.asylum, idps: r.idp, year: yr },
  }));
}

// --------------------------------------------------- OpenStreetMap Overpass ---
// Bounded infrastructure counts (grain storage / ports / rail freight) around
// the breadbaskets. Keyless, but rate-limited & shared — so this is strictly
// bounded: two small bboxes, a count-only query, a short timeout, and a
// descriptive User-Agent per Overpass etiquette.
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
// [south, west, north, east] — Overpass bbox order.
const OVERPASS_AREAS = [
  { name: 'US Corn Belt', box: [36, -104, 49, -82] },
  { name: 'Ukraine/Black Sea grain belt', box: [44, 22, 53, 42] },
];

export async function overpass({ fetchImpl, timeoutMs = 9000, areas = OVERPASS_AREAS } = {}) {
  const picked = areas.slice(0, 2);
  const results = await mapLimit(picked, 1, async (a) => {
    const [s, w, n, e] = a.box;
    const bbox = s + ',' + w + ',' + n + ',' + e;
    const query = '[out:json][timeout:20];(' +
      'nwr["man_made"="silo"](' + bbox + ');' +
      'nwr["landuse"="port"](' + bbox + ');' +
      'nwr["railway"="yard"](' + bbox + ');' +
      ');out count;';
    let j;
    try {
      j = await fetchJSON(OVERPASS_ENDPOINT, {
        fetchImpl, timeoutMs, method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AgriOS/PhaseVII (agri-crisis-nexus; contact via repo)' },
        body: 'data=' + encodeURIComponent(query),
      });
    } catch (_) { return null; }
    let count = 0;
    const els = (j && Array.isArray(j.elements)) ? j.elements : [];
    for (const el of els) {
      const tags = el && el.tags ? el.tags : {};
      const total = Number(tags.total != null ? tags.total : (tags.nodes || 0));
      if (Number.isFinite(total)) count += total;
    }
    return { area: a, count };
  });
  return results.filter(Boolean).map((r) => ({
    rawId: 'osm-' + r.area.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    domain: 'logistics',
    category: 'Agri-logistics infrastructure',
    title: r.area.name + ' — ' + formatBig(r.count) + ' logistics/storage features mapped',
    severity: 'stable',
    geography: r.area.name,
    lat: null, lon: null,
    value: r.count, unit: 'OSM features',
    published: null,
    sourceUrl: 'https://www.openstreetmap.org/',
    confidence: 0.6,
    evidence: 'observed',
  }));
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
  { id: 'nass', run: nass, ttlMs: 43_200_000 },
  { id: 'firms', run: firms, ttlMs: 900_000 },
  { id: 'faspsd', run: faspsd, ttlMs: 43_200_000 },
  { id: 'hungermap', run: hungermap, ttlMs: 21_600_000 },
  { id: 'unhcr', run: unhcr, ttlMs: 86_400_000 },
  { id: 'overpass', run: overpass, ttlMs: 86_400_000 },
];
