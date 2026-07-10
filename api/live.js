// Serverless live-data aggregation for AGRI-NEXUS.
// Aggregates public, no-key feeds relevant to food/climate/conflict crises.
// Never throws to the client: always returns 200 with whatever succeeded and a
// per-source health block. If everything fails the client shows DEGRADED / BUNDLED INTEL.
//
//   GET /api/live            -> normalized events + source health
//
// Sources (allowlisted, no API key required):
//   Humanitarian         — ReliefWeb v2 (if RELIEFWEB_APPNAME set) else GDACS
//   USGS                 — significant earthquakes (M4.5+, past 7 days)
//   NASA EONET           — open natural-event tracker (drought, wildfire, floods, storms)
//
// ReliefWeb note: since 2025-11-01 the ReliefWeb API mandates a pre-approved
// `appname` (obtained via their registration form). Its v1 endpoints are
// decommissioned (HTTP 410) and v2 rejects unapproved appnames (HTTP 403). We
// use the correct v2 POST contract when an approved appname is provided via the
// RELIEFWEB_APPNAME env var, and otherwise fall back to GDACS — a keyless
// UN/EC disaster feed — so humanitarian data stays live without registration.

const SOURCE_ALLOWLIST = {
  reliefweb: 'https://api.reliefweb.int',
  gdacs: 'https://www.gdacs.org',
  usgs: 'https://earthquake.usgs.gov',
  eonet: 'https://eonet.gsfc.nasa.gov',
};

const AGRI_KEYWORDS = /food|famine|hunger|drought|crop|harvest|agricultur|locust|flood|cyclone|storm|wildfire|conflict|displace/i;

async function fetchJSON(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'accept': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function sev(word) {
  const w = String(word || '').toLowerCase();
  if (/famine|catastroph|critical|severe|major|red/.test(w)) return 'critical';
  if (/emergency|high|significant|orange/.test(w)) return 'high';
  if (/warning|moderate|watch|yellow/.test(w)) return 'moderate';
  return 'moderate';
}

// Humanitarian source: prefer ReliefWeb v2 when an approved appname is
// configured, otherwise use the keyless GDACS feed. Returns { name, events }
// so the source-health block reflects which provider actually served the data.
async function getReliefWeb() {
  const appname = (process.env.RELIEFWEB_APPNAME || '').trim();
  if (appname) {
    try {
      const events = await getReliefWebV2(appname);
      if (events.length) return { name: 'ReliefWeb', events };
    } catch (_) {
      // ReliefWeb unavailable (e.g. appname not yet approved) — fall through.
    }
  }
  return { name: 'GDACS', events: await getGDACS() };
}

// Correct current ReliefWeb v2 contract: POST /v2/reports with an approved
// appname, JSON fields/filter/sort/limit. No scraping. Coarse geo only
// (ReliefWeb reports do not expose reliable point coordinates).
async function getReliefWebV2(appname) {
  const url = `${SOURCE_ALLOWLIST.reliefweb}/v2/reports?appname=${encodeURIComponent(appname)}`;
  const payload = {
    fields: {
      include: ['title', 'date.created', 'url_alias', 'primary_country.name', 'primary_country.iso3', 'source.shortname', 'disaster_type.name'],
    },
    filter: {
      operator: 'OR',
      conditions: [{ field: 'disaster_type.name', value: ['Drought', 'Flood', 'Food Insecurity', 'Tropical Cyclone', 'Wild Fire', 'Epidemic'] }],
    },
    sort: ['date.created:desc'],
    limit: 18,
  };
  const j = await fetchJSON(url, 4500, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const now = new Date().toISOString();
  const items = (j.data || []).map((d) => {
    const f = d.fields || {};
    const country = (f.primary_country && f.primary_country.name) || 'Global';
    const type = (f.disaster_type && f.disaster_type[0] && f.disaster_type[0].name) || 'Humanitarian';
    return {
      id: 'rw-' + d.id,
      source: 'ReliefWeb',
      title: f.title || 'Humanitarian situation update',
      category: type,
      severity: /famine|food|hunger|drought/i.test((f.title || '') + ' ' + type) ? 'critical' : sev(type),
      geography: country,
      lat: null,
      lng: null,
      published: (f.date && f.date.created) || now,
      url: f.url_alias || 'https://reliefweb.int',
    };
  });
  return items.filter((i) => AGRI_KEYWORDS.test(i.title + ' ' + i.category));
}

const GDACS_CATEGORY = { EQ: 'Seismic', TC: 'Tropical Cyclone', FL: 'Flood', DR: 'Drought', VO: 'Volcano', WF: 'Wildfire', TS: 'Tsunami' };
// Agriculture/climate-relevant disaster types; EQ/VO/TS excluded (USGS covers seismic).
const GDACS_AGRI_TYPES = new Set(['DR', 'FL', 'TC', 'WF']);

function gdacsSeverity(level) {
  const l = String(level || '').toLowerCase();
  if (l === 'red') return 'critical';
  if (l === 'orange') return 'high';
  return 'moderate';
}

// GDACS — Global Disaster Alert and Coordination System (UN OCHA / EC JRC).
// Public, keyless GeoJSON feed of current disasters.
async function getGDACS() {
  const url = `${SOURCE_ALLOWLIST.gdacs}/gdacsapi/api/events/geteventlist/EVENTS4APP`;
  const j = await fetchJSON(url, 4500);
  const now = new Date().toISOString();
  return (j.features || [])
    .filter((f) => f && f.properties && GDACS_AGRI_TYPES.has(f.properties.eventtype))
    .map((f) => {
      const p = f.properties;
      const coords = (f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [null, null];
      const report = (p.url && p.url.report) || 'https://www.gdacs.org';
      return {
        id: 'gdacs-' + (p.eventtype || 'E') + (p.eventid != null ? p.eventid : ''),
        source: 'GDACS',
        title: p.name || p.eventname || (GDACS_CATEGORY[p.eventtype] || 'Disaster alert'),
        category: GDACS_CATEGORY[p.eventtype] || 'Disaster',
        severity: gdacsSeverity(p.alertlevel),
        geography: p.country || 'Global',
        lat: typeof coords[1] === 'number' ? coords[1] : null,
        lng: typeof coords[0] === 'number' ? coords[0] : null,
        published: p.fromdate ? new Date(p.fromdate).toISOString() : now,
        url: report,
      };
    });
}

async function getUSGS() {
  const url = `${SOURCE_ALLOWLIST.usgs}/earthquakes/feed/v1.0/summary/4.5_week.geojson`;
  const j = await fetchJSON(url, 4500);
  return (j.features || []).slice(0, 12).map((f) => {
    const p = f.properties || {};
    const c = (f.geometry && f.geometry.coordinates) || [null, null];
    const mag = p.mag || 0;
    return {
      id: 'eq-' + f.id,
      source: 'USGS',
      title: `M${mag.toFixed(1)} earthquake — ${p.place || 'unknown'}`,
      category: 'Seismic',
      severity: mag >= 6.5 ? 'critical' : mag >= 5.5 ? 'high' : 'moderate',
      geography: p.place || 'Global',
      lat: c[1],
      lng: c[0],
      published: p.time ? new Date(p.time).toISOString() : new Date().toISOString(),
      url: p.url || 'https://earthquake.usgs.gov',
    };
  });
}

async function getEONET() {
  const url = `${SOURCE_ALLOWLIST.eonet}/api/v3/events?status=open&limit=25`;
  const j = await fetchJSON(url, 4500);
  return (j.events || [])
    .map((e) => {
      const cat = (e.categories && e.categories[0] && e.categories[0].title) || 'Natural event';
      const geo = e.geometry && e.geometry[e.geometry.length - 1];
      const coords = geo && geo.coordinates;
      const isPoint = Array.isArray(coords) && typeof coords[0] === 'number';
      return {
        id: 'eonet-' + e.id,
        source: 'NASA EONET',
        title: e.title,
        category: cat,
        severity: /drought|wildfire|flood/i.test(cat) ? 'high' : 'moderate',
        geography: cat,
        lat: isPoint ? coords[1] : null,
        lng: isPoint ? coords[0] : null,
        published: (geo && geo.date) || new Date().toISOString(),
        url: (e.sources && e.sources[0] && e.sources[0].url) || e.link || 'https://eonet.gsfc.nasa.gov',
      };
    })
    .filter((i) => /drought|wildfire|flood|storm|severe|temperature/i.test(i.category + ' ' + i.title));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Cache at the edge for 5 min, serve stale while revalidating.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');

  const fetchedAt = new Date().toISOString();
  const jobs = [
    { name: 'GDACS', run: getReliefWeb },
    { name: 'USGS', run: getUSGS },
    { name: 'NASA EONET', run: getEONET },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const sources = [];
  let events = [];
  settled.forEach((r, i) => {
    const fallbackName = jobs[i].name;
    const v = r.value;
    // Jobs return either an array of events or { name, events }.
    const arr = Array.isArray(v) ? v : (v && Array.isArray(v.events) ? v.events : null);
    if (r.status === 'fulfilled' && arr) {
      const name = (v && !Array.isArray(v) && v.name) || fallbackName;
      sources.push({ name, status: 'ok', count: arr.length, fetchedAt });
      events = events.concat(arr);
    } else {
      sources.push({ name: fallbackName, status: 'down', count: 0, fetchedAt, error: r.reason ? String(r.reason.message || r.reason) : 'unavailable' });
    }
  });

  // Sort newest first, cap payload.
  events.sort((a, b) => new Date(b.published) - new Date(a.published));
  events = events.slice(0, 40);

  const okCount = sources.filter((s) => s.status === 'ok').length;
  const status = okCount === 0 ? 'degraded' : okCount < sources.length ? 'partial' : 'live';

  return res.status(200).json({ ok: okCount > 0, status, asOf: fetchedAt, sources, events });
}
