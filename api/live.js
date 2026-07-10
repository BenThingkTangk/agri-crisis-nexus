// Serverless live-data aggregation for AGRI-NEXUS.
// Aggregates public, no-key feeds relevant to food/climate/conflict crises.
// Never throws to the client: always returns 200 with whatever succeeded and a
// per-source health block. If everything fails the client shows DEGRADED / BUNDLED INTEL.
//
//   GET /api/live            -> normalized events + source health
//
// Sources (allowlisted, no API key required):
//   ReliefWeb (UN OCHA)  — humanitarian disasters/reports
//   USGS                 — significant earthquakes (M4.5+, past 7 days)
//   NASA EONET           — open natural-event tracker (drought, wildfire, floods, storms)

const SOURCE_ALLOWLIST = {
  reliefweb: 'https://api.reliefweb.int',
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

async function getReliefWeb() {
  // Current disasters, latest first. Public appname param, no key.
  const url = `${SOURCE_ALLOWLIST.reliefweb}/v1/disasters?appname=agri-nexus&profile=list&preset=latest&limit=18`;
  const j = await fetchJSON(url, 4500);
  const now = new Date().toISOString();
  const items = (j.data || []).map((d) => {
    const f = d.fields || {};
    const country = (f.country && f.country[0] && f.country[0].name) || 'Global';
    const type = (f.type && f.type[0] && f.type[0].name) || 'Humanitarian';
    const geo = f.country && f.country[0] && f.country[0].location;
    return {
      id: 'rw-' + d.id,
      source: 'ReliefWeb',
      title: f.name || 'Humanitarian situation update',
      category: type,
      severity: /famine|food|hunger|drought/i.test(f.name || '') ? 'critical' : sev(f.status),
      geography: country,
      lat: geo ? geo.lat : null,
      lng: geo ? geo.lon : null,
      published: f.date && f.date.created ? f.date.created : now,
      url: (f.url_alias || f.url || 'https://reliefweb.int/disasters'),
    };
  });
  return items.filter((i) => AGRI_KEYWORDS.test(i.title + ' ' + i.category));
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
    { name: 'ReliefWeb', run: getReliefWeb },
    { name: 'USGS', run: getUSGS },
    { name: 'NASA EONET', run: getEONET },
  ];

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const sources = [];
  let events = [];
  settled.forEach((r, i) => {
    const name = jobs[i].name;
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      sources.push({ name, status: 'ok', count: r.value.length, fetchedAt });
      events = events.concat(r.value);
    } else {
      sources.push({ name, status: 'down', count: 0, fetchedAt, error: r.reason ? String(r.reason.message || r.reason) : 'unavailable' });
    }
  });

  // Sort newest first, cap payload.
  events.sort((a, b) => new Date(b.published) - new Date(a.published));
  events = events.slice(0, 40);

  const okCount = sources.filter((s) => s.status === 'ok').length;
  const status = okCount === 0 ? 'degraded' : okCount < sources.length ? 'partial' : 'live';

  return res.status(200).json({ ok: okCount > 0, status, asOf: fetchedAt, sources, events });
}
