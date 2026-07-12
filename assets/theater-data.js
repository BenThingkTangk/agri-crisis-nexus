/* ============================================================
   AGRI-NEXUS THEATER — geospatial intelligence dataset + registry
   Provenance-tagged, bundled baseline for the global agricultural
   theater and the Food War simulation engine.

   IMPORTANT PROVENANCE DISCIPLINE
   -------------------------------
   Every entity carries `observed` (true = sourced/measured from the
   cited authority) or `modeled` (illustrative proxy / assumption for
   scenario exploration). Values marked modeled must never be presented
   as live or measured. Source URLs live on each entity + the SOURCES
   registry so the detail/provenance UI can cite them.

   Loads as a browser global (window.THEATER_DATA) and is also loadable
   in a node:vm sandbox for the automated tests (no imports, no deps).
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------- source registry (authoritative provenance) ---------------- */
  var SOURCES = {
    chatham_report: {
      id: 'chatham_report',
      name: 'Chatham House — Chokepoints and Vulnerabilities in Global Food Trade (2017)',
      url: 'https://www.chathamhouse.org/2017/06/chokepoints-and-vulnerabilities-global-food-trade',
    },
    chatham_ch2: {
      id: 'chatham_ch2',
      name: 'Chatham House — Ch.2 Chokepoints in Global Food Trade',
      url: 'https://www.chathamhouse.org/2017/06/chokepoints-and-vulnerabilities-global-food-trade-0/2-chokepoints-global-food-trade',
    },
    fao_cropcal: {
      id: 'fao_cropcal',
      name: 'FAO — Crop Calendar by Harvesting Time',
      url: 'https://www.fao.org/fileadmin/user_upload/newsroom/docs/crop_calendar_by_harvesting_time_1.pdf',
    },
    gdacs: { id: 'gdacs', name: 'GDACS — Global Disaster Alert and Coordination System', url: 'https://www.gdacs.org/' },
    usgs: { id: 'usgs', name: 'USGS — Earthquake Hazards Program', url: 'https://earthquake.usgs.gov/' },
    eonet: { id: 'eonet', name: 'NASA EONET — Earth Observatory Natural Event Tracker', url: 'https://eonet.gsfc.nasa.gov/' },
    fao_ffpi: { id: 'fao_ffpi', name: 'FAO — Food Price Index', url: 'https://www.fao.org/worldfoodsituation/foodpricesindex/' },
    fews: { id: 'fews', name: 'FEWS NET — Famine Early Warning Systems Network', url: 'https://fews.net/' },
    grace: { id: 'grace', name: 'NASA GRACE — Groundwater & aquifer stress', url: 'https://grace.jpl.nasa.gov/' },
  };
  function src(id) { return SOURCES[id] ? [SOURCES[id]] : []; }

  /* ---------------- commodities ---------------- */
  var COMMODITIES = [
    { id: 'wheat', label: 'Wheat', color: '#d9a72e' },      // harvest gold
    { id: 'maize', label: 'Maize', color: '#c67f2e' },      // warm ochre
    { id: 'rice', label: 'Rice', color: '#4f97bd' },        // paddy / irrigation blue
    { id: 'soy', label: 'Soy', color: '#7fae43' },          // leaf green
    { id: 'fertilizer', label: 'Fertilizer', color: '#b5622f' }, // clay / industrial
  ];

  /* ---------------- 14 Chatham House chokepoints ----------------
     8 maritime + 3 coastal + 3 inland. Shares/notes are sourced from
     the Chatham House report; coordinates are geographic. `observed`
     marks report-sourced structural facts. */
  var CHOKEPOINTS = [
    // --- 8 maritime ---
    { id: 'cp-panama', name: 'Panama Canal', category: 'maritime', lat: 9.08, lng: -79.68,
      commodities: ['maize', 'soy', 'wheat'], severity: 'high', observed: true,
      share: 'US grain to Asia; low Gatún Lake draft limits',
      note: 'Draft restrictions during drought cut transit slots for US grain bound for Asia.',
      alternatives: ['Cape Horn (long detour)'], sources: src('chatham_ch2').concat(src('chatham_report')) },
    { id: 'cp-malacca', name: 'Strait of Malacca', category: 'maritime', lat: 2.5, lng: 101.4,
      commodities: ['rice', 'wheat', 'soy'], severity: 'moderate', observed: true,
      share: 'Principal Asia–Indian Ocean grain artery',
      note: 'Highest-volume maritime corridor for grain moving between the Indian and Pacific oceans.',
      alternatives: ['Sunda Strait', 'Lombok Strait'], sources: src('chatham_ch2') },
    { id: 'cp-hormuz', name: 'Strait of Hormuz', category: 'maritime', lat: 26.57, lng: 56.25,
      commodities: ['fertilizer', 'wheat'], severity: 'high', observed: true,
      share: 'Gulf fertilizer + MENA food inflows',
      note: 'One of three systemically important Middle East chokepoints; disruption reshapes MENA planting timelines.',
      alternatives: ['None viable (no maritime bypass)'], sources: src('chatham_ch2') },
    { id: 'cp-babel', name: 'Bab al-Mandab', category: 'maritime', lat: 12.58, lng: 43.33,
      commodities: ['wheat', 'maize', 'rice'], severity: 'critical', observed: true,
      share: 'Red Sea aid + grain gateway to Suez',
      note: 'Systemically important Middle East chokepoint; vessel attacks spill over from the Yemen conflict.',
      alternatives: ['Cape of Good Hope (adds ~10–14 days)'], sources: src('chatham_ch2') },
    { id: 'cp-suez', name: 'Suez Canal', category: 'maritime', lat: 30.58, lng: 32.35,
      commodities: ['wheat', 'maize', 'fertilizer'], severity: 'high', observed: true,
      share: 'Black Sea/EU grain to Asia; ~1/3 of South Korea wheat+maize',
      note: 'Third systemically important Middle East chokepoint; closure forces the Cape of Good Hope detour.',
      alternatives: ['Cape of Good Hope (adds ~10–14 days)'], sources: src('chatham_ch2') },
    { id: 'cp-turkish', name: 'Turkish Straits (Bosphorus & Dardanelles)', category: 'maritime', lat: 41.1, lng: 29.06,
      commodities: ['wheat', 'maize'], severity: 'critical', observed: true,
      share: '~1/5 of global wheat exports (Black Sea breadbasket)',
      note: 'Sole maritime outlet for Black Sea grain; no alternative maritime routing exists if closed.',
      alternatives: ['None (no maritime alternative)'], sources: src('chatham_ch2') },
    { id: 'cp-gibraltar', name: 'Strait of Gibraltar', category: 'maritime', lat: 35.95, lng: -5.6,
      commodities: ['fertilizer', 'wheat'], severity: 'moderate', observed: true,
      share: '~25% of potassium chloride (potash) fertilizer trade',
      note: 'Atlantic–Mediterranean gateway; key for potash fertilizer flows.',
      alternatives: ['None (Mediterranean entry)'], sources: src('chatham_ch2') },
    { id: 'cp-dover', name: 'Strait of Dover', category: 'maritime', lat: 51.0, lng: 1.5,
      commodities: ['wheat'], severity: 'moderate', observed: true,
      share: 'NW European grain + fertilizer coastal traffic',
      note: 'Narrow, high-density corridor for northern European agricultural trade.',
      alternatives: ['North-around Scotland (long detour)'], sources: src('chatham_ch2') },
    // --- 3 coastal ---
    { id: 'cp-usgulf', name: 'US Gulf Coast ports', category: 'coastal', lat: 29.3, lng: -90.4,
      commodities: ['maize', 'soy', 'wheat'], severity: 'high', observed: true,
      share: 'Primary seaboard for US crop exports',
      note: 'Terminus of US inland waterways; hurricane exposure concentrates export risk.',
      alternatives: ['Pacific Northwest ports (partial)'], sources: src('chatham_ch2') },
    { id: 'cp-brazilports', name: 'Brazilian ports (Santos & southeastern coast)', category: 'coastal', lat: -23.98, lng: -46.3,
      commodities: ['soy', 'maize'], severity: 'high', observed: true,
      share: 'Four SE ports ≈ nearly 1/4 of global soybean exports',
      note: 'Depend on interior roads from Cerrado farms; congestion cascades to global soy supply.',
      alternatives: ['Northern arc ports (developing)'], sources: src('chatham_ch2') },
    { id: 'cp-blackseaports', name: 'Black Sea ports (Odesa & Novorossiysk)', category: 'coastal', lat: 46.2, lng: 33.6,
      commodities: ['wheat', 'maize'], severity: 'critical', observed: true,
      share: 'Loading points for Black Sea breadbasket exports',
      note: 'Conflict-exposed; feed the Turkish Straits corridor to MENA and beyond.',
      alternatives: ['Danube river ports + EU rail (limited)'], sources: src('chatham_ch2') },
    // --- 3 inland ---
    { id: 'cp-usinland', name: 'US inland waterways & rail (Mississippi system)', category: 'inland', lat: 38.63, lng: -90.2,
      commodities: ['maize', 'soy'], severity: 'moderate', observed: true,
      share: '~60% of US exports of the four crops reach the sea via inland waterways',
      note: 'Low-water and lock failures on the Mississippi bottleneck grain to the Gulf.',
      alternatives: ['Rail diversion (higher cost)'], sources: src('chatham_ch2') },
    { id: 'cp-brazilroads', name: "Brazil's inland road network", category: 'inland', lat: -13.0, lng: -55.9,
      commodities: ['soy', 'maize'], severity: 'moderate', observed: true,
      share: 'Roads linking Cerrado farms to southeastern ports',
      note: 'Unpaved/seasonal roads throttle soy from the interior during rains.',
      alternatives: ['Rail (Ferrogrão, partial)'], sources: src('chatham_ch2') },
    { id: 'cp-blacksearail', name: 'Black Sea rail network', category: 'inland', lat: 49.0, lng: 36.0,
      commodities: ['wheat', 'maize'], severity: 'high', observed: true,
      share: 'Russian & Ukrainian rail feeding Black Sea ports',
      note: 'Moves breadbasket grain to ports; damage or blockade reduces export throughput.',
      alternatives: ['EU solidarity lanes (limited capacity)'], sources: src('chatham_ch2') },
  ];

  /* ---------------- breadbaskets (production zones) ---------------- */
  var BREADBASKETS = [
    { id: 'bb-usmidwest', name: 'US Midwest', lat: 41.5, lng: -93.5, commodities: ['maize', 'soy', 'wheat'], severity: 'moderate', observed: true, note: 'Corn Belt; heat-dome and Ogallala stress erode yields.', sources: src('fao_cropcal') },
    { id: 'bb-blacksea', name: 'Black Sea (Russia & Ukraine)', lat: 49.5, lng: 36.5, commodities: ['wheat', 'maize'], severity: 'critical', observed: true, note: '~1/5 of global wheat exports; conflict-exposed.', sources: src('fao_cropcal') },
    { id: 'bb-cerrado', name: 'Brazil Cerrado', lat: -13.5, lng: -52.0, commodities: ['soy', 'maize'], severity: 'moderate', observed: true, note: 'Largest soy export engine; rainfall-deficit sensitive.', sources: src('fao_cropcal') },
    { id: 'bb-pampas', name: 'Argentine Pampas', lat: -34.0, lng: -62.0, commodities: ['soy', 'wheat', 'maize'], severity: 'moderate', observed: true, note: 'Drought-prone soy/wheat belt.', sources: src('fao_cropcal') },
    { id: 'bb-indogangetic', name: 'Indo-Gangetic Plain', lat: 27.5, lng: 80.5, commodities: ['rice', 'wheat'], severity: 'high', observed: true, note: 'Feeds South Asia; monsoon + groundwater dependent.', sources: src('fao_cropcal').concat(src('grace')) },
    { id: 'bb-mekong', name: 'Mekong Delta', lat: 10.2, lng: 105.8, commodities: ['rice'], severity: 'high', observed: true, note: 'Major rice exporter; salinity intrusion risk.', sources: src('fao_cropcal') },
    { id: 'bb-france', name: 'France / EU cereal belt', lat: 48.8, lng: 2.4, commodities: ['wheat'], severity: 'stable', observed: true, note: 'Leading EU wheat exporter to MENA.', sources: src('fao_cropcal') },
    { id: 'bb-auswheat', name: 'Australian wheat belt', lat: -31.5, lng: 117.5, commodities: ['wheat'], severity: 'moderate', observed: true, note: 'Swing supplier to Asia; ENSO sensitive.', sources: src('fao_cropcal') },
    { id: 'bb-prairies', name: 'Canadian Prairies', lat: 51.5, lng: -106.0, commodities: ['wheat'], severity: 'stable', observed: true, note: 'Spring wheat + canola exporter.', sources: src('fao_cropcal') },
    { id: 'bb-nchina', name: 'North China Plain', lat: 36.2, lng: 115.5, commodities: ['wheat', 'maize', 'rice'], severity: 'high', observed: true, note: 'Domestic staple core under aquifer stress.', sources: src('fao_cropcal').concat(src('grace')) },
  ];

  /* ---------------- fertilizer source hubs ---------------- */
  var FERTILIZER_HUBS = [
    { id: 'fh-russia', name: 'Russia/Belarus potash & nitrogen', lat: 55.0, lng: 45.0, commodities: ['fertilizer'], severity: 'high', observed: true, note: 'Dominant potash + nitrogen exporter; sanction-exposed.', sources: src('fao_ffpi') },
    { id: 'fh-morocco', name: 'Morocco phosphate (OCP)', lat: 32.3, lng: -8.5, commodities: ['fertilizer'], severity: 'moderate', observed: true, note: 'Holds majority of global phosphate rock reserves.', sources: src('fao_ffpi') },
    { id: 'fh-gulf', name: 'Arabian Gulf urea/ammonia', lat: 25.3, lng: 51.2, commodities: ['fertilizer'], severity: 'high', observed: true, note: 'Gas-based nitrogen exports transit Hormuz.', sources: src('fao_ffpi') },
  ];

  /* ---------------- import-exposed regions + humanitarian pressure ---------------- */
  var EXPOSED_REGIONS = [
    { id: 'ex-egypt', name: 'Egypt', lat: 26.8, lng: 30.8, commodities: ['wheat'], severity: 'high', observed: true, humanitarian: 'high', note: 'Largest wheat importer; ~3-month reserve cover.', sources: src('fews') },
    { id: 'ex-horn', name: 'Horn of Africa', lat: 6.0, lng: 45.0, commodities: ['wheat', 'maize'], severity: 'critical', observed: true, humanitarian: 'critical', note: 'Import-dependent + drought; famine pressure.', sources: src('fews') },
    { id: 'ex-yemen', name: 'Yemen', lat: 15.5, lng: 47.5, commodities: ['wheat', 'rice'], severity: 'critical', observed: true, humanitarian: 'critical', note: '~90% food imported; Red Sea route exposed.', sources: src('fews') },
    { id: 'ex-sahel', name: 'Sahel', lat: 14.0, lng: 0.0, commodities: ['wheat', 'rice'], severity: 'high', observed: true, humanitarian: 'high', note: 'Conflict + import reliance; thin buffers.', sources: src('fews') },
    { id: 'ex-mena', name: 'MENA (Levant)', lat: 33.5, lng: 36.3, commodities: ['wheat'], severity: 'high', observed: true, humanitarian: 'high', note: 'Deeply reliant on Black Sea wheat via Turkish Straits.', sources: src('fews') },
    { id: 'ex-seasia', name: 'Import-reliant SE Asia', lat: 12.9, lng: 121.8, commodities: ['rice', 'wheat'], severity: 'moderate', observed: true, humanitarian: 'moderate', note: 'Rice-importing archipelagos exposed to export bans.', sources: src('fews') },
  ];

  /* ---------------- maritime grain/fertilizer route arcs ----------------
     Directional dependency edges. `via` lists chokepoint ids the arc
     traverses (used by the sim to propagate closures). Volumes are
     modeled proxies for arc weighting/emphasis — not measured tonnage. */
  var ROUTES = [
    { id: 'rt-blacksea-mena', from: 'bb-blacksea', to: 'ex-mena', commodity: 'wheat', via: ['cp-blacksearail', 'cp-blackseaports', 'cp-turkish'], weight: 20, severity: 'critical', observed: false },
    { id: 'rt-blacksea-egypt', from: 'bb-blacksea', to: 'ex-egypt', commodity: 'wheat', via: ['cp-blackseaports', 'cp-turkish'], weight: 14, severity: 'high', observed: false },
    { id: 'rt-blacksea-horn', from: 'bb-blacksea', to: 'ex-horn', commodity: 'wheat', via: ['cp-turkish', 'cp-suez', 'cp-babel'], weight: 9, severity: 'critical', observed: false },
    { id: 'rt-france-mena', from: 'bb-france', to: 'ex-mena', commodity: 'wheat', via: ['cp-gibraltar'], weight: 12, severity: 'high', observed: false },
    { id: 'rt-us-asia', from: 'bb-usmidwest', to: 'ex-seasia', commodity: 'maize', via: ['cp-usinland', 'cp-usgulf', 'cp-panama'], weight: 15, severity: 'moderate', observed: false },
    { id: 'rt-brazil-china', from: 'bb-cerrado', to: 'bb-nchina', commodity: 'soy', via: ['cp-brazilroads', 'cp-brazilports'], weight: 22, severity: 'high', observed: false },
    { id: 'rt-india-seasia', from: 'bb-indogangetic', to: 'ex-seasia', commodity: 'rice', via: ['cp-malacca'], weight: 8, severity: 'moderate', observed: false },
    { id: 'rt-mekong-horn', from: 'bb-mekong', to: 'ex-horn', commodity: 'rice', via: ['cp-malacca', 'cp-babel'], weight: 7, severity: 'high', observed: false },
    { id: 'rt-gulf-india', from: 'fh-gulf', to: 'bb-indogangetic', commodity: 'fertilizer', via: ['cp-hormuz'], weight: 10, severity: 'high', observed: false },
    { id: 'rt-russia-brazil', from: 'fh-russia', to: 'bb-cerrado', commodity: 'fertilizer', via: ['cp-gibraltar'], weight: 11, severity: 'high', observed: false },
    { id: 'rt-morocco-eu', from: 'fh-morocco', to: 'bb-france', commodity: 'fertilizer', via: ['cp-gibraltar'], weight: 6, severity: 'moderate', observed: false },
    { id: 'rt-aus-seasia', from: 'bb-auswheat', to: 'ex-seasia', commodity: 'wheat', via: ['cp-malacca'], weight: 6, severity: 'stable', observed: false },
    { id: 'rt-yemen-aid', from: 'bb-blacksea', to: 'ex-yemen', commodity: 'wheat', via: ['cp-turkish', 'cp-suez', 'cp-babel'], weight: 5, severity: 'critical', observed: false },
    { id: 'rt-sahel-supply', from: 'bb-france', to: 'ex-sahel', commodity: 'wheat', via: ['cp-gibraltar'], weight: 5, severity: 'high', observed: false },
  ];

  /* ---------------- node index (all point entities) ---------------- */
  function tag(list, kind) { return list.map(function (e) { var c = {}; for (var k in e) c[k] = e[k]; c.kind = kind; return c; }); }
  var NODES = []
    .concat(tag(CHOKEPOINTS, 'chokepoint'))
    .concat(tag(BREADBASKETS, 'breadbasket'))
    .concat(tag(FERTILIZER_HUBS, 'fertilizer'))
    .concat(tag(EXPOSED_REGIONS, 'exposed'));
  var NODE_BY_ID = {};
  NODES.forEach(function (n) { NODE_BY_ID[n.id] = n; });

  /* ---------------- layer registry (domains/layers) ---------------- */
  var LAYERS = [
    { id: 'chokepoint', label: 'Chokepoints', kind: 'node', color: '#c2452b' },
    { id: 'breadbasket', label: 'Breadbaskets', kind: 'node', color: '#6fae3f' },
    { id: 'fertilizer', label: 'Fertilizer hubs', kind: 'node', color: '#b5622f' },
    { id: 'exposed', label: 'Import-exposed regions', kind: 'node', color: '#e0a52e' },
    { id: 'routes', label: 'Trade routes', kind: 'edge', color: '#4f97bd' },
    { id: 'humanitarian', label: 'Humanitarian pressure', kind: 'overlay', color: '#9a6dc4' },
  ];

  var SEVERITY_ORDER = { critical: 4, high: 3, moderate: 2, stable: 1, neutral: 0 };
  var SEVERITY_COLOR = { critical: '#d43e28', high: '#e07a2c', moderate: '#e0a52e', stable: '#5fae5a', neutral: '#8a7f6e' };

  var API = {
    SOURCES: SOURCES,
    COMMODITIES: COMMODITIES,
    CHOKEPOINTS: CHOKEPOINTS,
    BREADBASKETS: BREADBASKETS,
    FERTILIZER_HUBS: FERTILIZER_HUBS,
    EXPOSED_REGIONS: EXPOSED_REGIONS,
    ROUTES: ROUTES,
    NODES: NODES,
    NODE_BY_ID: NODE_BY_ID,
    LAYERS: LAYERS,
    SEVERITY_ORDER: SEVERITY_ORDER,
    SEVERITY_COLOR: SEVERITY_COLOR,
    nodeById: function (id) { return NODE_BY_ID[id] || null; },
    routesThrough: function (chokepointId) { return ROUTES.filter(function (r) { return r.via.indexOf(chokepointId) !== -1; }); },
  };

  root.THEATER_DATA = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
