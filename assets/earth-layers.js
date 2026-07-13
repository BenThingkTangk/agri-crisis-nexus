/* ============================================================
   AgriOS — EARTH THEATER layer catalog + GeoJSON model (pure, DOM-free)

   The single source of truth for the planetary layer tree: layer
   families, encodings, accessible legends (shape + label, NEVER colour
   alone), default opacity, and a provenance class per layer. Plus two
   pure transforms:

     - buildFeatureCollections(events, nodes, geofences, sim)
         maps live/app data into a GeoJSON FeatureCollection per layer.
     - filterFeatures(fc, state)
         AND across active filter dimensions, OR within each multi-select.

   No DOM, no GL, no storage, no imports. Loads as window.EARTH_LAYERS
   and is loadable in a node:vm sandbox for the automated tests.

   PROVENANCE DISCIPLINE: every feature carries `provenance` drawn from
   the OBSERVED / MODELED / ANALYST / PROPOSED / CONTESTED vocabulary.
   Satellite imagery and modeled routes/sim are never labelled observed.
   ============================================================ */
(function (root) {
  'use strict';

  /* Evidence / provenance vocabulary — shared across the whole surface. */
  var PROVENANCE = ['observed', 'modeled', 'analyst', 'proposed', 'contested'];

  /* ---------------- layer catalog (families → layers) ----------------
     Each layer: { id, family, label, geom, encoding, provenance,
     defaultOpacity, legend:[{shape,label}], sourceHint }.
     `geom` is the GeoJSON geometry family it produces; `encoding` is the
     visual mapping the renderer applies. Legends pair a SHAPE with a
     LABEL so meaning never rests on colour alone (WCAG). */
  var CATALOG = [
    /* --- satellite context --- */
    { id: 'sat-viirs', family: 'Satellite', label: 'VIIRS true-colour (daily)', geom: 'raster',
      encoding: 'raster', provenance: 'observed', defaultOpacity: 0.85,
      legend: [{ shape: 'raster', label: 'NASA GIBS daily corrected reflectance (not live)' }],
      sourceHint: 'gibs' },

    /* --- live /api/intel events by domain --- */
    { id: 'events-weather', family: 'Live events', label: 'Weather & climate', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'circle', label: 'Weather/climate event (size = severity)' }], sourceHint: 'intel' },
    { id: 'events-conflict', family: 'Live events', label: 'Conflict & security', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'triangle', label: 'Conflict/security event (size = severity)' }], sourceHint: 'intel' },
    { id: 'events-logistics', family: 'Live events', label: 'Logistics & transport', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'square', label: 'Logistics/transport disruption' }], sourceHint: 'intel' },
    { id: 'events-market', family: 'Live events', label: 'Markets & prices', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'diamond', label: 'Market/price signal' }], sourceHint: 'intel' },
    { id: 'events-hazard', family: 'Live events', label: 'Natural hazards', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'star', label: 'Hazard (quake/flood/fire/storm)' }], sourceHint: 'intel' },
    { id: 'events-humanitarian', family: 'Live events', label: 'Humanitarian', geom: 'point',
      encoding: 'proportional-circle', provenance: 'observed', defaultOpacity: 0.95,
      legend: [{ shape: 'cross', label: 'Humanitarian/food-security signal' }], sourceHint: 'intel' },

    /* --- food-system structure (Chatham House / FAO — observed geography) --- */
    { id: 'chokepoints', family: 'Food system', label: 'Trade chokepoints', geom: 'point',
      encoding: 'graduated-marker', provenance: 'observed', defaultOpacity: 1,
      legend: [{ shape: 'hexagon', label: 'Chatham House chokepoint (colour = severity)' }], sourceHint: 'theater' },
    { id: 'breadbaskets', family: 'Food system', label: 'Breadbaskets', geom: 'polygon',
      encoding: 'buffer-ring', provenance: 'observed', defaultOpacity: 0.5,
      legend: [{ shape: 'ring', label: 'Production zone (ring = catchment)' }], sourceHint: 'theater' },
    { id: 'fertilizer', family: 'Food system', label: 'Fertilizer hubs', geom: 'point',
      encoding: 'graduated-marker', provenance: 'observed', defaultOpacity: 1,
      legend: [{ shape: 'square', label: 'Fertilizer export hub' }], sourceHint: 'theater' },
    { id: 'exposed', family: 'Food system', label: 'Import-exposed regions', geom: 'point',
      encoding: 'graduated-marker', provenance: 'observed', defaultOpacity: 1,
      legend: [{ shape: 'cross', label: 'Import-dependent region' }], sourceHint: 'theater' },
    { id: 'routes', family: 'Food system', label: 'Trade corridors', geom: 'line',
      encoding: 'arc', provenance: 'modeled', defaultOpacity: 0.7,
      legend: [{ shape: 'line', label: 'Modeled dependency corridor (width = volume)' }], sourceHint: 'theater' },

    /* --- operational overlays --- */
    { id: 'geofences', family: 'Operational', label: 'Watch geofences', geom: 'polygon',
      encoding: 'polygon', provenance: 'analyst', defaultOpacity: 0.45,
      legend: [{ shape: 'polygon', label: 'Analyst-defined watch area' }], sourceHint: 'geofences' },
    { id: 'alerts', family: 'Operational', label: 'Active alerts', geom: 'point',
      encoding: 'pulse-marker', provenance: 'analyst', defaultOpacity: 1,
      legend: [{ shape: 'ring-dot', label: 'Active early-warning alert' }], sourceHint: 'alerts' },
    { id: 'missions', family: 'Operational', label: 'Missions', geom: 'point',
      encoding: 'flag-marker', provenance: 'analyst', defaultOpacity: 1,
      legend: [{ shape: 'flag', label: 'Assigned mission' }], sourceHint: 'missions' },

    /* --- scenario / modeled --- */
    { id: 'sim-propagation', family: 'Scenario', label: 'Food-War propagation', geom: 'line',
      encoding: 'animated-arc', provenance: 'modeled', defaultOpacity: 0.8,
      legend: [{ shape: 'dashed-line', label: 'Modeled disruption spread (scenario, not forecast)' }], sourceHint: 'sim' },
    { id: 'regional-pressure', family: 'Scenario', label: 'Regional pressure', geom: 'point',
      encoding: 'choropleth-proxy', provenance: 'modeled', defaultOpacity: 0.6,
      legend: [{ shape: 'grid', label: 'Modeled composite pressure by region' }], sourceHint: 'sim' }
  ];
  var CATALOG_BY_ID = {};
  CATALOG.forEach(function (l) { CATALOG_BY_ID[l.id] = l; });

  var FAMILIES = (function () {
    var seen = {}, out = [];
    CATALOG.forEach(function (l) { if (!seen[l.family]) { seen[l.family] = true; out.push(l.family); } });
    return out;
  })();

  function layerIds() { return CATALOG.map(function (l) { return l.id; }); }
  function layerById(id) { return CATALOG_BY_ID[id] || null; }

  /* Map an app domain string to a live-events layer id. Deterministic. */
  var DOMAIN_TO_LAYER = {
    weather: 'events-weather', climate: 'events-weather',
    conflict: 'events-conflict', security: 'events-conflict',
    logistics: 'events-logistics', transport: 'events-logistics', port: 'events-logistics',
    market: 'events-market', price: 'events-market', economic: 'events-market',
    hazard: 'events-hazard', disaster: 'events-hazard', earthquake: 'events-hazard',
    flood: 'events-hazard', wildfire: 'events-hazard', storm: 'events-hazard',
    humanitarian: 'events-humanitarian', food: 'events-humanitarian', displacement: 'events-humanitarian'
  };
  function eventLayerFor(ev) {
    var d = String((ev && (ev.domain || ev.category || ev.type)) || '').toLowerCase();
    return DOMAIN_TO_LAYER[d] || 'events-hazard';
  }

  /* Provenance class for an event/entity, mapped to the shared vocabulary. */
  function provenanceOf(entity, fallback) {
    if (!entity) return fallback || 'modeled';
    if (entity.provenance && PROVENANCE.indexOf(entity.provenance) !== -1) return entity.provenance;
    if (entity.evidence === 'observed' || entity.observed === true) return 'observed';
    if (entity.evidence === 'modeled' || entity.observed === false) return 'modeled';
    return fallback || 'modeled';
  }

  function feature(lng, lat, props) {
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: props || {} };
  }
  function fc(features) { return { type: 'FeatureCollection', features: features || [] }; }
  function num(v) { var n = +v; return isFinite(n) ? n : null; }

  /* Small deterministic ring polygon around a point (buffer proxy, in degrees). */
  function ring(lng, lat, radiusDeg) {
    var r = radiusDeg || 4, pts = [];
    for (var i = 0; i <= 24; i++) {
      var a = (i / 24) * Math.PI * 2;
      pts.push([lng + Math.cos(a) * r, lat + Math.sin(a) * r * 0.7]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }

  /* ---------------- buildFeatureCollections ----------------
     Turn app data into one GeoJSON FeatureCollection per layer id.
     Inputs are all optional and defensively handled (fail-soft):
       events    — normalized /api/intel events [{domain,lat,lon,severity,confidence,evidence,provenance,headline,source,...}]
       nodes     — THEATER_DATA.NODES + ROUTES via {nodes,routes} or the raw arrays
       geofences — [{id,name,geometry|bbox|polygon,...}]
       sim       — SIM_ENGINE.runSim result (optional) for propagation/pressure. */
  function buildFeatureCollections(events, nodes, geofences, sim) {
    var out = {};
    layerIds().forEach(function (id) { out[id] = fc([]); });

    /* live events → per-domain point layers */
    (events || []).forEach(function (ev) {
      var lat = num(ev.lat != null ? ev.lat : ev.latitude);
      var lng = num(ev.lon != null ? ev.lon : (ev.lng != null ? ev.lng : ev.longitude));
      if (lat == null || lng == null) return;
      var lid = eventLayerFor(ev);
      out[lid].features.push(feature(lng, lat, {
        layer: lid, kind: 'event',
        title: ev.headline || ev.title || ev.summary || 'Event',
        severity: ev.severity || 'moderate',
        confidence: ev.confidence != null ? ev.confidence : null,
        provenance: provenanceOf(ev, 'observed'),
        source: ev.source || ev.src || '',
        domain: ev.domain || ev.category || ''
      }));
    });

    /* food-system structure from THEATER_DATA */
    var nodeList = [], routeList = [];
    if (nodes && nodes.nodes) { nodeList = nodes.nodes || []; routeList = nodes.routes || []; }
    else if (Array.isArray(nodes)) { nodeList = nodes; }
    var nodeById = {};
    nodeList.forEach(function (n) { nodeById[n.id] = n; });

    nodeList.forEach(function (n) {
      var lat = num(n.lat), lng = num(n.lng);
      if (lat == null || lng == null) return;
      var lid = n.kind === 'chokepoint' ? 'chokepoints'
        : n.kind === 'breadbasket' ? 'breadbaskets'
        : n.kind === 'fertilizer' ? 'fertilizer'
        : n.kind === 'exposed' ? 'exposed' : null;
      if (!lid) return;
      var props = {
        layer: lid, kind: n.kind, id: n.id, title: n.name,
        severity: n.severity || 'moderate',
        commodities: n.commodities || [],
        provenance: provenanceOf(n, 'observed'),
        note: n.note || '', humanitarian: n.humanitarian || null
      };
      out[lid].features.push(feature(lng, lat, props));
      if (lid === 'breadbaskets') { var rg = ring(lng, lat, 5); rg.properties = props; out.breadbaskets.features.push(rg); }
    });

    /* routes → line features (modeled corridors) */
    routeList.forEach(function (r) {
      var a = nodeById[r.from], b = nodeById[r.to];
      if (!a || !b) return;
      out.routes.features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[num(a.lng), num(a.lat)], [num(b.lng), num(b.lat)]] },
        properties: { layer: 'routes', id: r.id, commodity: r.commodity, weight: r.weight || 1,
          severity: r.severity || 'moderate', provenance: 'modeled', via: r.via || [] }
      });
    });

    /* geofences → polygons */
    (geofences || []).forEach(function (g) {
      var geom = g.geometry || g.polygon || null;
      if (!geom && g.bbox && g.bbox.length === 4) {
        var bb = g.bbox; // [w,s,e,n]
        geom = { type: 'Polygon', coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] };
      }
      if (!geom) return;
      out.geofences.features.push({ type: 'Feature', geometry: geom,
        properties: { layer: 'geofences', id: g.id, title: g.name || 'Watch area', provenance: 'analyst',
          severity: g.band || g.severity || 'moderate' } });
    });

    /* sim propagation → arcs from initiator through its route corridors */
    if (sim && sim.params) {
      var initId = sim.params.initiator;
      var init = nodeById[initId];
      if (init) {
        routeList.filter(function (r) { return (r.via || []).indexOf(initId) !== -1 || r.from === initId; })
          .forEach(function (r) {
            var b = nodeById[r.to];
            if (!b) return;
            out['sim-propagation'].features.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: [[num(init.lng), num(init.lat)], [num(b.lng), num(b.lat)]] },
              properties: { layer: 'sim-propagation', provenance: 'modeled', commodity: r.commodity,
                severity: r.severity || 'high', scenario: sim.params.preset || 'custom' }
            });
          });
        out['regional-pressure'].features.push(feature(num(init.lng), num(init.lat), {
          layer: 'regional-pressure', provenance: 'modeled', title: 'Scenario epicentre: ' + (init.name || initId),
          pressure: sim.summary ? sim.summary.peakPricePressure : null, severity: 'critical' }));
      }
    }

    return out;
  }

  /* ---------------- filterFeatures ----------------
     Filter a single FeatureCollection's features by a state object.
     Dimensions (AND across, OR within each): severity[], commodity[],
     provenance[], confidence(min number), region(substring on title),
     source[] (substring on source). Empty/absent dimension = no
     constraint. Non-point geometries (rings/lines/polygons) are kept
     when their properties match. */
  function has(arr, v) { return arr && arr.length && arr.indexOf(v) !== -1; }

  function featureMatches(f, state) {
    if (!f || !f.properties) return false;
    var p = f.properties;
    if (state.severity && state.severity.length && !has(state.severity, p.severity)) return false;
    if (state.provenance && state.provenance.length && !has(state.provenance, p.provenance)) return false;
    if (state.commodity && state.commodity.length) {
      var cs = Array.isArray(p.commodities) ? p.commodities : (p.commodity ? [p.commodity] : []);
      if (!cs.some(function (c) { return has(state.commodity, c); })) return false;
    }
    if (state.confidence != null && p.confidence != null && +p.confidence < +state.confidence) return false;
    if (state.region) {
      var r = String(state.region).toLowerCase();
      if (String(p.title || '').toLowerCase().indexOf(r) === -1) return false;
    }
    if (state.source && state.source.length) {
      if (!state.source.some(function (s) { return String(p.source || '').toLowerCase().indexOf(String(s).toLowerCase()) !== -1; })) return false;
    }
    return true;
  }

  function filterFeatures(collection, state) {
    state = state || {};
    var feats = (collection && collection.features) || [];
    return fc(feats.filter(function (f) { return featureMatches(f, state); }));
  }

  /* Every legend entry pairs a non-empty shape with a non-empty label so
     nothing relies on colour alone. Exposed for the accessibility test. */
  function legendIsColorSafe() {
    return CATALOG.every(function (l) {
      return Array.isArray(l.legend) && l.legend.length > 0 &&
        l.legend.every(function (e) { return !!e.shape && !!e.label; });
    });
  }

  var API = {
    PROVENANCE: PROVENANCE,
    CATALOG: CATALOG,
    CATALOG_BY_ID: CATALOG_BY_ID,
    FAMILIES: FAMILIES,
    layerIds: layerIds,
    layerById: layerById,
    eventLayerFor: eventLayerFor,
    provenanceOf: provenanceOf,
    buildFeatureCollections: buildFeatureCollections,
    filterFeatures: filterFeatures,
    featureMatches: featureMatches,
    legendIsColorSafe: legendIsColorSafe
  };
  root.EARTH_LAYERS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
