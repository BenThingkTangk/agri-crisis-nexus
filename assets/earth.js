/* ============================================================
   AgriOS · A Nirmata Holdings Company — EARTH THEATER (flagship surface)

   A GIS-grade planetary intelligence surface: the world food system as a
   living network. A dominant real-Earth globe (MapLibre GL globe projection
   over NASA GIBS satellite imagery) sits in the centre of a command shell —
   a collapsible layer tree on the left, an Intelligence Inspector on the
   right, and a timeline + Food-War simulation drawer along the bottom.

   Enhancement-layer discipline (mirrors assets/watch.js / collab.js): this
   reads window.AGRI_APP and returns silently if the base app is absent, so
   the bundle keeps working without it. It never touches any client-side
   persistence (no web storage, no cookies), never references or logs any
   secret, and never presents fixtures or modeled output as live data.

   WebGL2 is required for the globe; when it is unavailable we fall back to a
   Leaflet flat map sharing the exact same feature/layer/filter model. If
   neither is available we render an honest data-table shell.

   Depends on browser globals: AGRI_APP, EARTH_LAYERS, EARTH_SOURCES,
   EARTH_SCENES, THEATER_DATA, SIM_ENGINE. MapLibre GL is vendored same-origin
   (assets/vendor/) and lazy-loaded on first activation so the flagship globe
   never depends on a third-party CDN at runtime; Leaflet is already present
   for the fallback.
   ============================================================ */
(function () {
  'use strict';
  var A = window.AGRI_APP;
  if (!A) return; // base app must be present — fail soft otherwise

  var LY = window.EARTH_LAYERS, SRC = window.EARTH_SOURCES, SC = window.EARTH_SCENES,
      TD = window.THEATER_DATA, SIM = window.SIM_ENGINE;

  var esc = A.esc || function (s) { return String(s == null ? '' : s); };
  var icon = A.icon || function () { return ''; };
  var REDUCED = !!A.reduced || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // Vendored same-origin (assets/vendor/) so the flagship globe never depends
  // on a third-party CDN at runtime. MapLibre v4 bundles its worker inline
  // (blob:), so no separate worker asset is fetched.
  var MAPLIBRE_JS = 'assets/vendor/maplibre-gl-4.7.1.js';
  var MAPLIBRE_CSS = 'assets/vendor/maplibre-gl-4.7.1.css';
  var MAPLIBRE_TIMEOUT_MS = 8000; // fall back to Leaflet if the globe engine can't load

  var SEV_COLOR = { critical: '#d43e28', high: '#e07a2c', moderate: '#e0a52e', stable: '#5fae5a', neutral: '#8a7f6e' };
  var PROV_LABEL = { observed: 'OBSERVED', modeled: 'MODELED', analyst: 'ANALYST', proposed: 'PROPOSED', contested: 'CONTESTED' };

  /* ---------------- module state (in-memory only, never persisted) ---------------- */
  var st = {
    mounted: false,
    renderer: null,       // 'maplibre' | 'leaflet' | 'table'
    layerOn: {},          // layerId -> bool
    layerOpacity: {},     // layerId -> 0..1
    filter: { severity: [], commodity: [], provenance: [], confidence: null, region: '', source: [] },
    collections: {},      // layerId -> GeoJSON FeatureCollection (filtered view feeds the map)
    selected: null,       // selected feature properties
    scene: null,
    sim: null, day: 0, playing: false, speed: 1,
    sources: []           // resolved EARTH_SOURCES view
  };
  var globe = null, simTimer = null, listeners = [], booted = false;

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); }
  function offAll() { listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} }); listeners = []; }

  /* ================= data assembly ================= */
  // Live events come from the app's fused-intel snapshot; food-system geography
  // from THEATER_DATA; geofences/alerts/missions best-effort via same-origin
  // fetch (fail-soft). Nothing here fabricates live data.
  function currentEvents() {
    try { var s = A.getIntel ? A.getIntel() : null; return (s && s.events) ? s.events : []; }
    catch (e) { return []; }
  }
  function currentIntelHealth() {
    try { return A.getIntel ? A.getIntel() : {}; } catch (e) { return {}; }
  }

  function rebuildCollections() {
    var nodes = TD ? { nodes: TD.NODES, routes: TD.ROUTES } : { nodes: [], routes: [] };
    st.collections = LY.buildFeatureCollections(currentEvents(), nodes, st.geofences || [], st.sim);
  }

  function viewFor(layerId) {
    var fc = st.collections[layerId] || { type: 'FeatureCollection', features: [] };
    return LY.filterFeatures(fc, st.filter);
  }

  /* ================= renderer selection ================= */
  function hasWebGL2() {
    if (REDUCED_FORCE_FLAT) return false;
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext && c.getContext('webgl2'));
    } catch (e) { return false; }
  }
  // A test/QA switch: forces the Leaflet flat-map path even when WebGL2 exists,
  // so the fallback can be exercised deterministically (?earthflat=1).
  var REDUCED_FORCE_FLAT = (function () {
    try { return /[?&]earthflat=1/.test(location.search); } catch (e) { return false; }
  })();

  function loadMapLibre(cb) {
    if (window.maplibregl) { cb(true); return; }
    var done = false;
    // Single-fire settle: whichever of onload / onerror / timeout wins, we
    // resolve exactly once. Without the timeout, a slow or blocked CDN would
    // leave the globe pane hanging empty with no fallback ever triggered.
    function settle(ok) { if (done) return; done = true; cb(ok && !!window.maplibregl); }
    if (!document.querySelector('link[data-earth-mlcss]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = MAPLIBRE_CSS; link.setAttribute('data-earth-mlcss', '1');
      document.head.appendChild(link);
    }
    var s = document.createElement('script');
    s.src = MAPLIBRE_JS; s.async = true;
    s.onload = function () { settle(true); };
    s.onerror = function () { settle(false); };
    document.head.appendChild(s);
    setTimeout(function () { settle(!!window.maplibregl); }, MAPLIBRE_TIMEOUT_MS);
  }

  /* ================= GIBS raster (satellite context) ================= */
  function gibsTemplate() {
    if (window.GIBS && window.GIBS.tileUrlTemplate) {
      // MapLibre uses {z}/{x}/{y}; GIBS REST is {z}/{y}/{x} — swap.
      var t = window.GIBS.tileUrlTemplate(window.GIBS.defaultVisualLayerId(), window.GIBS.defaultDate(null, window.GIBS.defaultVisualLayerId()));
      return t.replace('{z}/{y}/{x}', '{z}/{y}/{x}'); // template already in {z}/{y}/{x}; handled per-renderer
    }
    return null;
  }

  /* ================= MapLibre globe renderer ================= */
  function buildMapLibre(container) {
    var gl = window.maplibregl;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (gl.setRTLTextPlugin) { /* not needed */ }
    var rasterTiles = null;
    if (window.GIBS) {
      var id = window.GIBS.defaultVisualLayerId();
      var date = window.GIBS.defaultDate(null, id);
      rasterTiles = window.GIBS.tileUrlTemplate(id, date); // {z}/{y}/{x}
    }
    var style = {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0805' } }]
    };
    if (rasterTiles) {
      style.sources['gibs'] = { type: 'raster', tiles: [rasterTiles.replace('/{z}/{y}/{x}', '/{z}/{y}/{x}')], tileSize: 256, attribution: (window.GIBS.ATTRIBUTION || 'NASA GIBS') };
      // MapLibre raster tile scheme: GIBS WMTS REST is standard XYZ with {y} — use scheme 'xyz'.
      style.sources['gibs'].scheme = 'xyz';
      style.layers.push({ id: 'gibs', type: 'raster', source: 'gibs', paint: { 'raster-opacity': st.layerOpacity['sat-viirs'] != null ? st.layerOpacity['sat-viirs'] : 0.85 } });
    }
    var map;
    try {
      map = new gl.Map({
        container: container, style: style, center: [10, 20], zoom: 1.1, pitch: 0,
        attributionControl: true, maxPixelRatio: dpr, renderWorldCopies: true, dragRotate: false
      });
    } catch (e) { return null; }
    try { map.setProjection && map.setProjection({ type: 'globe' }); } catch (e) {}
    map.addControl(new gl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');

    var api = {
      kind: 'maplibre', map: map, ready: false,
      onReady: function (fn) { map.on('load', fn); },
      addGeoJSONLayers: function () { addMlGeoJSON(map); },
      setLayerVisible: function (id, on) { setMlVisible(map, id, on); },
      setLayerOpacity: function (id, op) { setMlOpacity(map, id, op); },
      applyFeatures: function () { updateMlSources(map); },
      flyTo: function (c) { try { map.flyTo({ center: [c.lng, c.lat], zoom: c.zoom, duration: REDUCED ? 0 : 1400 }); } catch (e) {} },
      home: function () { api.flyTo({ lng: 10, lat: 20, zoom: 1.1 }); },
      onClick: function (fn) { api._click = fn; },
      resize: function () { try { map.resize(); } catch (e) {} },
      destroy: function () { try { map.remove(); } catch (e) {} }
    };
    map.on('load', function () {
      api.ready = true;
      try { if (map.setFog) map.setFog({}); if (map.setSky) map.setSky({}); } catch (e) {}
      addMlGeoJSON(map);
      updateMlSources(map);
      // idle auto-rotate (paused on interaction + reduced motion)
      startAutoRotate(map);
    });
    return api;
  }

  // Circle/line/fill layers per catalog layer, driven by GeoJSON sources.
  function addMlGeoJSON(map) {
    LY.CATALOG.forEach(function (l) {
      if (l.id === 'sat-viirs') return; // raster handled separately
      var srcId = 'src-' + l.id;
      if (!map.getSource(srcId)) map.addSource(srcId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      var vis = st.layerOn[l.id] ? 'visible' : 'none';
      var op = st.layerOpacity[l.id] != null ? st.layerOpacity[l.id] : l.defaultOpacity;
      if (l.geom === 'line') {
        if (!map.getLayer(l.id)) map.addLayer({ id: l.id, type: 'line', source: srcId,
          layout: { visibility: vis, 'line-cap': 'round' },
          paint: { 'line-color': colorExpr(), 'line-width': ['interpolate', ['linear'], ['coalesce', ['get', 'weight'], 4], 1, 1, 22, 5], 'line-opacity': op,
            'line-dasharray': l.id === 'sim-propagation' ? [2, 1.5] : [1, 0] } });
      } else if (l.geom === 'polygon') {
        if (!map.getLayer(l.id + '-fill')) map.addLayer({ id: l.id + '-fill', type: 'fill', source: srcId,
          layout: { visibility: vis }, paint: { 'fill-color': colorExpr(), 'fill-opacity': op * 0.35 } });
        if (!map.getLayer(l.id + '-line')) map.addLayer({ id: l.id + '-line', type: 'line', source: srcId,
          layout: { visibility: vis }, paint: { 'line-color': colorExpr(), 'line-width': 1.4, 'line-opacity': op } });
      } else { // point
        if (!map.getLayer(l.id)) map.addLayer({ id: l.id, type: 'circle', source: srcId,
          layout: { visibility: vis },
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, sevRadiusExpr(3), 6, sevRadiusExpr(8)],
            'circle-color': colorExpr(),
            'circle-opacity': op,
            'circle-stroke-color': '#0a0805', 'circle-stroke-width': 1
          } });
      }
    });
    // click → inspector (delegated across interactive point/line layers)
    var clickable = LY.CATALOG.filter(function (l) { return l.id !== 'sat-viirs'; })
      .map(function (l) { return l.geom === 'polygon' ? l.id + '-fill' : l.id; });
    clickable.forEach(function (lid) {
      if (!map.getLayer(lid)) return;
      map.on('click', lid, function (e) {
        var f = e.features && e.features[0]; if (f && globe && globe._click) globe._click(f.properties || {});
      });
      map.on('mouseenter', lid, function () { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', lid, function () { map.getCanvas().style.cursor = ''; });
    });
  }
  function colorExpr() {
    return ['match', ['coalesce', ['get', 'severity'], 'moderate'],
      'critical', SEV_COLOR.critical, 'high', SEV_COLOR.high, 'moderate', SEV_COLOR.moderate,
      'stable', SEV_COLOR.stable, SEV_COLOR.neutral];
  }
  function sevRadiusExpr(base) {
    return ['match', ['coalesce', ['get', 'severity'], 'moderate'],
      'critical', base + 4, 'high', base + 2, 'moderate', base, 'stable', base - 1, base];
  }
  function setMlVisible(map, id, on) {
    var vis = on ? 'visible' : 'none';
    ['', '-fill', '-line'].forEach(function (suf) { if (map.getLayer(id + suf)) map.setLayoutProperty(id + suf, 'visibility', vis); });
    if (id === 'sat-viirs' && map.getLayer('gibs')) map.setLayoutProperty('gibs', 'visibility', vis);
  }
  function setMlOpacity(map, id, op) {
    if (id === 'sat-viirs') { if (map.getLayer('gibs')) map.setPaintProperty('gibs', 'raster-opacity', op); return; }
    if (map.getLayer(id) && map.getLayer(id) && (map.getLayer(id).type === 'circle')) map.setPaintProperty(id, 'circle-opacity', op);
    if (map.getLayer(id) && map.getLayer(id).type === 'line') map.setPaintProperty(id, 'line-opacity', op);
    if (map.getLayer(id + '-fill')) map.setPaintProperty(id + '-fill', 'fill-opacity', op * 0.35);
    if (map.getLayer(id + '-line')) map.setPaintProperty(id + '-line', 'line-opacity', op);
  }
  function updateMlSources(map) {
    LY.CATALOG.forEach(function (l) {
      if (l.id === 'sat-viirs') return;
      var s = map.getSource('src-' + l.id);
      if (s) try { s.setData(viewFor(l.id)); } catch (e) {}
    });
  }
  var rotRaf = null;
  function startAutoRotate(map) {
    if (REDUCED) return;
    var last = 0, paused = false, resumeAt = 0;
    ['mousedown', 'touchstart', 'wheel'].forEach(function (ev) {
      map.on(ev, function () { paused = true; resumeAt = Date.now() + 3500; });
    });
    function frame(ts) {
      rotRaf = requestAnimationFrame(frame);
      if (paused && Date.now() < resumeAt) return; else paused = false;
      if (!last) last = ts;
      var dt = ts - last; last = ts;
      try { var c = map.getCenter(); map.setCenter([c.lng + dt * 0.004, c.lat]); } catch (e) {}
    }
    rotRaf = requestAnimationFrame(frame);
  }

  /* ================= Leaflet flat-map fallback ================= */
  function buildLeaflet(container) {
    if (!window.L) return null;
    var L = window.L;
    var map = L.map(container, { worldCopyJump: true, minZoom: 1, attributionControl: true, zoomControl: true }).setView([20, 10], 2);
    if (window.GIBS) {
      var id = window.GIBS.defaultVisualLayerId(), date = window.GIBS.defaultDate(null, id);
      L.tileLayer(window.GIBS.tileUrlTemplate(id, date), { attribution: window.GIBS.ATTRIBUTION, opacity: st.layerOpacity['sat-viirs'] != null ? st.layerOpacity['sat-viirs'] : 0.85, noWrap: false, tileSize: 256 }).addTo(map);
    }
    var groups = {};
    LY.CATALOG.forEach(function (l) { if (l.id === 'sat-viirs') return; groups[l.id] = L.layerGroup(); if (st.layerOn[l.id]) groups[l.id].addTo(map); });

    function draw() {
      LY.CATALOG.forEach(function (l) {
        if (l.id === 'sat-viirs' || !groups[l.id]) return;
        groups[l.id].clearLayers();
        var op = st.layerOpacity[l.id] != null ? st.layerOpacity[l.id] : l.defaultOpacity;
        viewFor(l.id).features.forEach(function (f) {
          var g = f.geometry, p = f.properties || {}, col = SEV_COLOR[p.severity] || SEV_COLOR.neutral;
          var lyr = null;
          if (g.type === 'Point') {
            lyr = L.circleMarker([g.coordinates[1], g.coordinates[0]], { radius: 5, color: '#0a0805', weight: 1, fillColor: col, fillOpacity: op });
          } else if (g.type === 'LineString') {
            lyr = L.polyline(g.coordinates.map(function (c) { return [c[1], c[0]]; }), { color: col, weight: 2, opacity: op, dashArray: l.id === 'sim-propagation' ? '5,5' : null });
          } else if (g.type === 'Polygon') {
            lyr = L.polygon(g.coordinates[0].map(function (c) { return [c[1], c[0]]; }), { color: col, weight: 1.2, fillColor: col, fillOpacity: op * 0.35 });
          }
          if (lyr) { lyr.on('click', function () { if (globe && globe._click) globe._click(p); }); groups[l.id].addLayer(lyr); }
        });
      });
    }
    var api = {
      kind: 'leaflet', map: map, ready: true,
      onReady: function (fn) { setTimeout(fn, 0); },
      addGeoJSONLayers: function () {},
      setLayerVisible: function (id, on) { if (!groups[id]) return; if (on) groups[id].addTo(map); else map.removeLayer(groups[id]); },
      setLayerOpacity: function () { draw(); },
      applyFeatures: function () { draw(); },
      flyTo: function (c) { try { map.flyTo([c.lat, c.lng], Math.max(2, Math.round(c.zoom + 2)), { duration: REDUCED ? 0 : 1.2 }); } catch (e) {} },
      home: function () { api.flyTo({ lng: 10, lat: 20, zoom: 1 }); },
      onClick: function (fn) { api._click = fn; },
      resize: function () { try { map.invalidateSize(); } catch (e) {} },
      destroy: function () { try { map.remove(); } catch (e) {} }
    };
    setTimeout(draw, 0);
    return api;
  }

  /* ================= shell markup ================= */
  function defaultLayersOn() {
    var scene = SC && SC.byId('global-food-pressure');
    var onSet = {};
    (scene ? scene.layers : ['sat-viirs', 'chokepoints', 'breadbaskets', 'routes']).forEach(function (id) { onSet[id] = true; });
    LY.CATALOG.forEach(function (l) { st.layerOn[l.id] = !!onSet[l.id]; st.layerOpacity[l.id] = l.defaultOpacity; });
  }

  function treeHtml() {
    var byFam = {};
    LY.CATALOG.forEach(function (l) { (byFam[l.family] = byFam[l.family] || []).push(l); });
    var html = '<div class="earth-tree-search"><input type="search" id="earthLayerSearch" data-testid="earth-tree-search" placeholder="Search layers…" aria-label="Search layers" /></div>';
    LY.FAMILIES.forEach(function (fam) {
      html += '<div class="earth-tree-group" data-fam="' + esc(fam) + '">' +
        '<button class="earth-tree-gh" aria-expanded="true" data-testid="earth-tree-group">' + icon('chevron-down') + '<span>' + esc(fam) + '</span></button>' +
        '<div class="earth-tree-items">';
      byFam[fam].forEach(function (l) {
        var leg = l.legend[0] || { shape: 'dot', label: '' };
        html += '<div class="earth-layer" data-layer="' + l.id + '" data-testid="earth-layer">' +
          '<label class="earth-layer-row"><input type="checkbox" data-testid="earth-layer-toggle" data-layer="' + l.id + '"' + (st.layerOn[l.id] ? ' checked' : '') + ' /> ' +
          '<span class="earth-layer-name">' + esc(l.label) + '</span>' +
          '<span class="earth-prov earth-prov-' + l.provenance + '">' + PROV_LABEL[l.provenance] + '</span></label>' +
          '<div class="earth-layer-legend"><span class="earth-legshape shape-' + esc(leg.shape) + '"></span><span>' + esc(leg.label) + '</span></div>' +
          '<input type="range" class="earth-opacity" data-testid="earth-layer-opacity" data-layer="' + l.id + '" min="0" max="100" value="' + Math.round((st.layerOpacity[l.id] || 0) * 100) + '" aria-label="' + esc(l.label) + ' opacity" />' +
          '</div>';
      });
      html += '</div></div>';
    });
    return html;
  }

  function presetsHtml() {
    if (!SC) return '';
    return SC.SCENES.map(function (s) {
      return '<button class="earth-preset" data-scene="' + s.id + '" data-testid="earth-preset">' +
        icon(s.icon || 'map') + '<span>' + esc(s.label) + '</span></button>';
    }).join('');
  }

  function hudHtml() {
    return '<div class="earth-hud" data-testid="earth-hud" role="group" aria-label="Instrument readouts">' +
      hudCell('SEASON', '<span id="hudSeason">—</span>') +
      hudCell('SUPPLY PULSE', '<span id="hudPulse">—</span>') +
      hudCell('HARVEST WINDOW', '<span id="hudHarvest">—</span>') +
      hudCell('NETWORK PRESSURE', '<span id="hudPressure">—</span>') +
      '</div>';
  }
  function hudCell(label, val) {
    return '<div class="earth-hud-cell"><div class="earth-hud-l">' + esc(label) + '</div><div class="earth-hud-v">' + val + '</div></div>';
  }

  function shellHtml() {
    return '' +
      '<div class="earth-shell" data-testid="earth-shell">' +
        '<aside class="earth-left" data-testid="earth-tree" aria-label="Layer tree">' +
          '<div class="earth-panel-h"><span>Layers</span><button class="earth-collapse" id="earthTreeCollapse" data-testid="earth-tree-collapse" aria-label="Collapse layer tree">' + icon('panel-left-close') + '</button></div>' +
          '<div class="earth-tree" id="earthTree">' + treeHtml() + '</div>' +
          '<div class="earth-sources" data-testid="earth-sources"><div class="earth-panel-h"><span>Sources</span></div><div id="earthSources" class="earth-sources-list"></div></div>' +
        '</aside>' +
        '<div class="earth-center">' +
          hudHtml() +
          '<div class="earth-globe-wrap"><div id="earthGlobe" class="earth-globe" data-testid="earth-globe" role="application" aria-label="Interactive planetary food-system map"></div>' +
            '<div class="earth-globe-controls">' +
              '<button id="earthHome" class="earth-gbtn" data-testid="earth-home" aria-label="Reset view">' + icon('home') + '</button>' +
              '<button id="earthPaletteBtn" class="earth-gbtn" data-testid="earth-palette-btn" aria-label="Command palette (Ctrl or Cmd + K)">' + icon('command') + '</button>' +
            '</div>' +
            '<div class="earth-render-status" id="earthRenderStatus" data-testid="earth-render-status"></div>' +
          '</div>' +
          '<div class="earth-presets" data-testid="earth-presets" role="group" aria-label="Scene presets">' + presetsHtml() + '</div>' +
        '</div>' +
        '<aside class="earth-right" data-testid="earth-inspector" aria-label="Intelligence inspector"><div id="earthInspector" class="earth-inspector">' + inspectorEmpty() + '</div></aside>' +
      '</div>' +
      '<div class="earth-timeline" data-testid="earth-timeline">' +
        '<div class="earth-tl-head"><span class="earth-tl-title">Timeline &amp; Food-War simulation</span>' +
          '<span class="earth-tl-note">Observed signals are live where connected; simulation is a deterministic scenario, not a forecast.</span></div>' +
        '<div class="earth-tl-controls">' +
          '<select id="earthScenarioSel" data-testid="earth-scenario-select" aria-label="Scenario preset"></select>' +
          '<button id="earthSimPlay" class="earth-tl-btn" data-testid="earth-sim-play" aria-label="Play or pause simulation">' + icon('play') + '</button>' +
          '<button id="earthSimReset" class="earth-tl-btn" data-testid="earth-sim-reset" aria-label="Reset simulation">' + icon('rotate-ccw') + '</button>' +
          '<input type="range" id="earthScrubber" data-testid="earth-scrubber" min="0" max="180" value="0" aria-label="Timeline day" />' +
          '<span class="earth-tl-day" id="earthDay" data-testid="earth-day">Day 0</span>' +
        '</div>' +
        '<div class="earth-tl-ledger" id="earthLedger" data-testid="earth-ledger" role="status" aria-live="polite"></div>' +
      '</div>' +
      '<div class="earth-palette" id="earthPalette" data-testid="earth-palette" hidden role="dialog" aria-label="Command palette">' +
        '<input type="text" id="earthPaletteInput" data-testid="earth-palette-input" placeholder="Type a command or scene…" aria-label="Command palette input" />' +
        '<div class="earth-palette-list" id="earthPaletteList"></div>' +
      '</div>' +
      '<div id="earthSr" class="sr-only" role="status" aria-live="polite"></div>';
  }

  function bootHtml() {
    return '<div class="earth-boot" id="earthBoot" data-testid="earth-boot" role="dialog" aria-label="Earth Theater intro">' +
      '<div class="earth-boot-inner">' +
        '<div class="earth-boot-grid" aria-hidden="true"></div>' +
        '<div class="earth-boot-title">EARTH THEATER</div>' +
        '<div class="earth-boot-sub">The world food system as a living planetary network</div>' +
        '<button class="earth-boot-skip" id="earthBootSkip" data-testid="earth-boot-skip">Skip intro' + icon('chevron-right') + '</button>' +
      '</div></div>';
  }

  function inspectorEmpty() {
    return '<div class="earth-insp-empty"><div class="earth-insp-eyebrow">Intelligence Inspector</div>' +
      '<p>Select any feature on the globe — a chokepoint, live event, watch area or corridor — to see what we observe, why it matters, its confidence and provenance, and the actions you can take.</p>' +
      '<div class="earth-legend-key">' + LY.PROVENANCE.map(function (p) { return '<span class="earth-prov earth-prov-' + p + '">' + PROV_LABEL[p] + '</span>'; }).join('') + '</div></div>';
  }

  /* ================= inspector (WHAT / WHY / CONFIDENCE·PROVENANCE / ACTIONS) ================= */
  function openFeature(props) {
    st.selected = props || null;
    var host = $('#earthInspector'); if (!host) return;
    if (!props) { host.innerHTML = inspectorEmpty(); A.refreshIcons(); return; }
    var prov = props.provenance || 'modeled';
    var sev = props.severity || 'moderate';
    var why = whyItMatters(props);
    host.innerHTML =
      '<div class="earth-insp-head"><span class="earth-prov earth-prov-' + prov + '">' + (PROV_LABEL[prov] || prov) + '</span>' +
        '<span class="earth-sev-chip sev-' + sev + '">' + esc(sev.toUpperCase()) + '</span></div>' +
      '<h3 class="earth-insp-title">' + esc(props.title || props.id || 'Feature') + '</h3>' +
      section('WHAT WE SEE', esc(props.note || props.domain || describeLayer(props.layer))) +
      section('WHY IT MATTERS', esc(why)) +
      section('CONFIDENCE · PROVENANCE', confidenceLine(props)) +
      (props.source ? section('SOURCE', esc(props.source)) : '') +
      '<div class="earth-actions" data-testid="earth-actions">' +
        actBtn('earth-act-watch', 'shield-alert', 'Watch Area') +
        actBtn('earth-act-mission', 'crosshair', 'Convert to Mission') +
        actBtn('earth-act-scenario', 'swords', 'Run Scenario') +
        actBtn('earth-act-atom', 'sparkles', 'Ask ATOM') +
      '</div>';
    bindActions(props);
    A.refreshIcons();
  }
  function section(label, body) { return '<div class="earth-insp-sec"><div class="earth-insp-l">' + label + '</div><div class="earth-insp-b">' + body + '</div></div>'; }
  function actBtn(tid, ic, label) { return '<button class="earth-act" data-testid="' + tid + '">' + icon(ic) + '<span>' + label + '</span></button>'; }
  function confidenceLine(p) {
    var c = p.confidence != null ? (p.confidence + '% confidence') : 'confidence not quantified';
    var note = p.provenance === 'observed' ? 'Measured/observed from the cited source.'
      : p.provenance === 'modeled' ? 'Modeled proxy — scenario exploration, not a measurement or forecast.'
      : p.provenance === 'analyst' ? 'Analyst-defined operational object.' : 'Provisional.';
    return esc(c) + ' · ' + esc(note);
  }
  function describeLayer(id) { var l = LY.layerById(id); return l ? l.label : 'Feature'; }
  function whyItMatters(p) {
    if (p.layer === 'chokepoints') return 'A disruption here reroutes or severs grain/fertilizer corridors, adding cost and delay for downstream importers.';
    if (p.layer === 'breadbaskets') return 'Yield or export loss in this production zone propagates through the corridors it feeds.';
    if (p.layer === 'exposed') return 'This region depends on imports and carries thin buffers, so upstream shocks land here first.';
    if (p.layer === 'routes' || p.layer === 'sim-propagation') return 'This corridor carries dependency between producer and consumer; its integrity gates supply.';
    if (String(p.layer || '').indexOf('events-') === 0) return 'A live signal that can raise pressure on nearby food-system structure.';
    if (p.layer === 'geofences') return 'An analyst-defined watch area — events inside it drive early-warning scoring.';
    return 'Relevant to food-system stability in this area.';
  }
  function bindActions(props) {
    on($('[data-testid="earth-act-watch"]'), 'click', function () {
      say('Opening Watch to define an early-warning area.');
      if (A.activateMode) A.activateMode('watch');
    });
    on($('[data-testid="earth-act-mission"]'), 'click', function () {
      var title = 'Mitigate risk — ' + (props.title || 'selected feature');
      if (window.AGRI_COLLAB && window.AGRI_COLLAB.openMissionComposer) window.AGRI_COLLAB.openMissionComposer({ title: title, objective: whyItMatters(props) });
      else { say('Sign in to save a team mission.'); if (A.activateMode) A.activateMode('command'); }
    });
    on($('[data-testid="earth-act-scenario"]'), 'click', function () {
      var preset = presetForFeature(props);
      runScenario(preset); say('Running the ' + preset + ' scenario.');
    });
    on($('[data-testid="earth-act-atom"]'), 'click', function () {
      if (A.openAtom) A.openAtom('Give me a WHAT/WHY/CONFIDENCE·PROVENANCE/ACTIONS brief for ' + (props.title || 'this feature') + '. Ground it in the observed food-system structure and any live signals; do not fabricate citations.');
    });
  }
  function presetForFeature(p) {
    if (!SIM) return 'blacksea-blockade';
    if (p.id === 'cp-suez' || p.id === 'cp-babel') return 'suez-closure';
    if (String(p.layer || '').indexOf('fertilizer') !== -1 || (p.commodities || []).indexOf('fertilizer') !== -1) return 'fertilizer-embargo';
    return 'blacksea-blockade';
  }

  /* ================= scenes ================= */
  function applyScene(id) {
    var scene = SC && SC.byId(id); if (!scene) return;
    st.scene = id;
    // layers
    LY.CATALOG.forEach(function (l) { st.layerOn[l.id] = scene.layers.indexOf(l.id) !== -1; });
    // filters (only dimensions our filter model supports)
    st.filter = { severity: [], commodity: [], provenance: [], confidence: null, region: '', source: [] };
    if (scene.filters.severity) st.filter.severity = scene.filters.severity.slice();
    if (scene.filters.commodity) st.filter.commodity = scene.filters.commodity.slice();
    syncTreeChecks();
    if (globe) { LY.CATALOG.forEach(function (l) { globe.setLayerVisible(l.id, st.layerOn[l.id]); }); globe.applyFeatures && globe.applyFeatures(); globe.flyTo(scene.camera); }
    if (scene.simPreset) runScenario(scene.simPreset);
    say(scene.label + ' — ' + scene.narrative);
    $$('.earth-preset').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-scene') === id); });
  }

  /* ================= simulation ================= */
  function runScenario(preset) {
    if (!SIM) return;
    st.sim = SIM.runSim({ preset: preset });
    st.ledger = SIM.phaseLedger(st.sim);
    st.day = 0;
    rebuildCollections();
    if (globe) { globe.setLayerVisible('sim-propagation', st.layerOn['sim-propagation'] = true); syncTreeChecks(); globe.applyFeatures && globe.applyFeatures(); }
    var sel = $('#earthScenarioSel'); if (sel) sel.value = preset;
    setDay(0); updateHud();
    if (A.setSimSnapshot) A.setSimSnapshot({ title: 'Food War: ' + preset, params: Object.assign({ type: 'foodwar' }, st.sim.params), result: { summary: st.sim.summary, deltas: st.sim.deltas } });
  }
  function setDay(d) {
    st.day = Math.max(0, Math.min(SIM ? SIM.HORIZON : 180, d));
    var scr = $('#earthScrubber'); if (scr) scr.value = st.day;
    var dl = $('#earthDay'); if (dl) dl.textContent = 'Day ' + st.day;
    var led = $('#earthLedger');
    if (led && st.sim) {
      var ph = SIM.phaseForDay(st.day, SIM.computePhases(st.sim));
      var entry = (st.ledger || []).filter(function (e) { return e.startDay <= st.day; }).pop();
      if (entry) {
        led.innerHTML = '<div class="earth-ledger-phase">' + esc(entry.label) + ' · <span class="earth-prov earth-prov-modeled">MODELED</span></div>' +
          '<div class="earth-ledger-body"><b>' + esc(entry.changed) + '</b> ' + esc(entry.why) + '</div>' +
          '<div class="earth-ledger-meta">Evidence: ' + esc(entry.evidence) + ' · Confidence ' + (entry.confidence != null ? entry.confidence + '%' : 'n/a') + ' · Next: ' + esc(entry.nextDecision) + '</div>';
      }
    }
    updateHud();
  }
  function togglePlay() {
    if (!st.sim) runScenario('blacksea-blockade');
    st.playing = !st.playing;
    var btn = $('#earthSimPlay'); if (btn) btn.innerHTML = icon(st.playing ? 'pause' : 'play');
    A.refreshIcons();
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (st.playing) {
      if (REDUCED) { // reduced motion → discrete phase steps, no continuous animation
        var phases = SIM.computePhases(st.sim); var idx = 0;
        simTimer = setInterval(function () {
          if (idx >= phases.length) { stopPlay(); return; }
          setDay(phases[idx].startDay); idx++;
        }, 900);
      } else {
        simTimer = setInterval(function () {
          if (st.day >= (SIM ? SIM.HORIZON : 180)) { stopPlay(); return; }
          setDay(st.day + Math.max(1, 2 * st.speed));
        }, 90);
      }
    }
  }
  function stopPlay() { st.playing = false; if (simTimer) { clearInterval(simTimer); simTimer = null; } var b = $('#earthSimPlay'); if (b) { b.innerHTML = icon('play'); A.refreshIcons(); } }

  /* ================= instrument HUD ================= */
  function updateHud() {
    var season = ['Northern winter', 'Pre-planting', 'Planting', 'Growing', 'Harvest', 'Post-harvest'][(new Date().getUTCMonth() / 2) | 0] || 'Growing';
    setText('#hudSeason', season);
    var events = currentEvents();
    var crit = events.filter(function (e) { return e.severity === 'critical' || e.severity === 'high'; }).length;
    setText('#hudPulse', events.length ? (events.length + ' signals · ' + crit + ' elevated') : 'Awaiting live feed');
    var chokes = TD ? TD.CHOKEPOINTS.filter(function (c) { return c.severity === 'critical'; }).length : 0;
    setText('#hudHarvest', chokes + ' critical chokepoints');
    var pressure = st.sim && st.sim.summary ? Math.round(st.sim.summary.peakPricePressure) + ' idx (modeled)' : (crit >= 3 ? 'Elevated' : 'Nominal');
    setText('#hudPressure', pressure);
  }
  function setText(sel, t) { var e = $(sel); if (e) e.textContent = t; }
  function say(msg) { var sr = $('#earthSr'); if (sr) sr.textContent = msg; }

  /* ================= sources health ================= */
  function renderSources() {
    var host = $('#earthSources'); if (!host || !SRC) return;
    st.sources = SRC.resolve(currentIntelHealth());
    host.innerHTML = st.sources.map(function (s) {
      var cls = 'earth-src-state src-' + s.state;
      var lbl = s.live ? 'LIVE' : s.state.replace('-', ' ').toUpperCase();
      var extra = s.needs && s.needs.length ? ' · needs ' + esc(s.needs.join(', ')) : '';
      return '<div class="earth-src" data-testid="earth-source" title="' + esc(s.description) + '">' +
        '<span class="' + cls + '"></span>' +
        '<span class="earth-src-name">' + esc(s.name) + '</span>' +
        '<span class="earth-src-lbl">' + lbl + extra + '</span></div>';
    }).join('');
  }

  /* ================= command palette ================= */
  function paletteItems() {
    var items = [];
    (SC ? SC.SCENES : []).forEach(function (s) { items.push({ label: 'Scene: ' + s.label, run: function () { applyScene(s.id); } }); });
    LY.CATALOG.forEach(function (l) { items.push({ label: (st.layerOn[l.id] ? 'Hide' : 'Show') + ' layer: ' + l.label, run: function () { toggleLayer(l.id, !st.layerOn[l.id]); } }); });
    (SIM ? SIM.PRESETS : []).forEach(function (p) { items.push({ label: 'Run scenario: ' + p.label, run: function () { runScenario(p.id); } }); });
    items.push({ label: 'Reset view', run: function () { if (globe) globe.home(); } });
    return items;
  }
  function openPalette() {
    var pal = $('#earthPalette'); if (!pal) return;
    pal.hidden = false; var inp = $('#earthPaletteInput'); if (inp) { inp.value = ''; inp.focus(); }
    drawPalette('');
  }
  function closePalette() { var pal = $('#earthPalette'); if (pal) pal.hidden = true; }
  function drawPalette(q) {
    var list = $('#earthPaletteList'); if (!list) return;
    q = String(q || '').toLowerCase();
    var items = paletteItems().filter(function (i) { return i.label.toLowerCase().indexOf(q) !== -1; }).slice(0, 12);
    list.innerHTML = items.map(function (i, idx) { return '<button class="earth-palette-item" data-idx="' + idx + '">' + esc(i.label) + '</button>'; }).join('');
    $$('.earth-palette-item', list).forEach(function (b) {
      on(b, 'click', function () { var i = items[+b.getAttribute('data-idx')]; if (i) { closePalette(); i.run(); } });
    });
  }

  /* ================= layer tree ops ================= */
  function toggleLayer(id, on) {
    st.layerOn[id] = on;
    if (globe) globe.setLayerVisible(id, on);
    syncTreeChecks();
  }
  function syncTreeChecks() {
    $$('#earthTree input[type="checkbox"][data-layer]').forEach(function (cb) { cb.checked = !!st.layerOn[cb.getAttribute('data-layer')]; });
    $$('.earth-preset').forEach(function (b) { if (b.getAttribute('data-scene') !== st.scene) b.classList.remove('active'); });
  }

  /* ================= filters ================= */
  function applyFilterAndRedraw() {
    rebuildCollections();
    if (globe && globe.applyFeatures) globe.applyFeatures();
  }

  /* ================= mount ================= */
  function mountGlobe() {
    var container = $('#earthGlobe'); if (!container) return;
    var status = $('#earthRenderStatus');
    function useLeaflet(reason) {
      globe = buildLeaflet(container);
      if (globe) { st.renderer = 'leaflet'; if (status) status.textContent = 'Flat-map fallback (Leaflet) — ' + reason; }
      else tableFallback();
      finishMount();
    }
    function tableFallback() {
      st.renderer = 'table';
      container.innerHTML = '<div class="earth-table-fallback" data-testid="earth-table-fallback"><p>Interactive map unavailable. Showing the food-system network as a table.</p>' + tableHtml() + '</div>';
      if (status) status.textContent = 'Map unavailable — data table shown.';
    }
    if (hasWebGL2()) {
      loadMapLibre(function (ok) {
        if (!ok || !window.maplibregl) { useLeaflet('MapLibre unavailable'); return; }
        globe = buildMapLibre(container);
        if (!globe) { useLeaflet('WebGL init failed'); return; }
        st.renderer = 'maplibre';
        if (status) status.textContent = 'Globe active · NASA GIBS satellite context (daily, not live)';
        globe.onClick(openFeature);
        globe.onReady(function () { finishMount(); });
      });
    } else {
      useLeaflet(REDUCED_FORCE_FLAT ? 'flat-map requested' : 'WebGL2 not available');
      if (globe && globe.onClick) globe.onClick(openFeature);
    }
  }
  function finishMount() {
    if (globe && globe.onClick && st.renderer === 'leaflet') globe.onClick(openFeature);
    applyFilterAndRedraw();
    LY.CATALOG.forEach(function (l) { if (globe) globe.setLayerVisible(l.id, st.layerOn[l.id]); });
    // land on the flagship scene
    if (SC && SC.byId('global-food-pressure')) setTimeout(function () { applyScene('global-food-pressure'); }, 60);
  }

  function tableHtml() {
    if (!TD) return '';
    var rows = TD.NODES.slice(0, 40).map(function (n) {
      return '<tr><td>' + esc(n.name) + '</td><td>' + esc(n.kind) + '</td><td>' + esc(n.severity) + '</td><td><span class="earth-prov earth-prov-observed">OBSERVED</span></td></tr>';
    }).join('');
    return '<table class="earth-table"><thead><tr><th>Node</th><th>Type</th><th>Severity</th><th>Provenance</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ================= cinematic boot (once per session, skippable) ================= */
  function maybeBoot(host) {
    if (REDUCED || booted || window.__EARTH_BOOTED__) { booted = true; return; }
    var wrap = document.createElement('div'); wrap.innerHTML = bootHtml();
    var boot = wrap.firstChild; host.appendChild(boot);
    booted = true; window.__EARTH_BOOTED__ = true;
    function dismiss() { if (!boot) return; boot.classList.add('earth-boot-out'); setTimeout(function () { if (boot && boot.parentNode) boot.parentNode.removeChild(boot); }, 500); }
    on($('#earthBootSkip'), 'click', dismiss);
    setTimeout(dismiss, 2600);
  }

  /* ================= wiring ================= */
  function bindShell() {
    // scenario select options
    var sel = $('#earthScenarioSel');
    if (sel && SIM) sel.innerHTML = SIM.PRESETS.map(function (p) { return '<option value="' + p.id + '">' + esc(p.label) + '</option>'; }).join('');

    on($('#earthTree'), 'change', function (e) {
      var t = e.target;
      if (t && t.matches('input[type="checkbox"][data-layer]')) toggleLayer(t.getAttribute('data-layer'), t.checked);
    });
    on($('#earthTree'), 'input', function (e) {
      var t = e.target;
      if (t && t.matches('.earth-opacity')) { var id = t.getAttribute('data-layer'); st.layerOpacity[id] = (+t.value) / 100; if (globe) globe.setLayerOpacity(id, st.layerOpacity[id]); }
      if (t && t.id === 'earthLayerSearch') filterTree(t.value);
    });
    $$('#earthTree .earth-tree-gh').forEach(function (gh) {
      on(gh, 'click', function () { var grp = gh.parentNode; var open = gh.getAttribute('aria-expanded') === 'true'; gh.setAttribute('aria-expanded', open ? 'false' : 'true'); grp.classList.toggle('collapsed', open); });
    });
    on($('#earthTreeCollapse'), 'click', function () { var sh = $('.earth-shell'); if (sh) sh.classList.toggle('tree-collapsed'); if (globe) setTimeout(function () { globe.resize(); }, 260); });

    $$('.earth-preset').forEach(function (b) { on(b, 'click', function () { applyScene(b.getAttribute('data-scene')); }); });
    on($('#earthHome'), 'click', function () { if (globe) globe.home(); });
    on($('#earthPaletteBtn'), 'click', openPalette);
    on($('#earthScenarioSel'), 'change', function (e) { runScenario(e.target.value); });
    on($('#earthSimPlay'), 'click', togglePlay);
    on($('#earthSimReset'), 'click', function () { stopPlay(); setDay(0); });
    on($('#earthScrubber'), 'input', function (e) { stopPlay(); setDay(+e.target.value); });

    on($('#earthPaletteInput'), 'input', function (e) { drawPalette(e.target.value); });
    on(document, 'keydown', function (e) {
      if (!st.mounted) return;
      var active = $('#panel-earth') && $('#panel-earth').classList.contains('active');
      if (!active) return;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
      else if (e.key === '/' && document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); openPalette(); }
      else if (e.key === 'Escape') closePalette();
    });
    on(window, 'resize', function () { if (globe) globe.resize(); });
  }
  function filterTree(q) {
    q = String(q || '').toLowerCase();
    $$('#earthTree .earth-layer').forEach(function (row) {
      var name = (row.querySelector('.earth-layer-name') || {}).textContent || '';
      row.style.display = !q || name.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
    });
  }

  /* ================= public lifecycle ================= */
  function init() { /* nothing eager — mount happens on first render */ }

  function render(panel) {
    if (!panel) return;
    st.mounted = true;
    defaultLayersOn();
    panel.innerHTML = shellHtml();
    maybeBoot(panel);
    bindShell();
    renderSources();
    updateHud();
    rebuildCollections();
    mountGlobe();
    A.refreshIcons();
    // Keep the source panel honest as live intel arrives. renderSources() above
    // runs before the first /api/intel poll resolves, so keyless-live sources
    // would otherwise be stuck at their registry-ready baseline while only the
    // force-connected GIBS row shows CONNECTED. Re-render once the poll settles
    // (the promise resolves even on failure) so real per-source health lands.
    if (A.refreshIntel) {
      try {
        var poll = A.refreshIntel();
        if (poll && typeof poll.then === 'function') {
          poll.then(function () { renderSources(); updateHud(); }, function () {});
        }
      } catch (e) {}
    }
    if (window.AGRIOS_AUTH && window.AGRIOS_AUTH.onChange) window.AGRIOS_AUTH.onChange(function () { renderSources(); updateHud(); });
  }

  function onActivate() {
    if (!st.mounted) return;
    renderSources(); updateHud();
    if (globe) setTimeout(function () { globe.resize(); }, 80);
  }

  window.AGRI_EARTH = { init: init, render: render, onActivate: onActivate };
})();
