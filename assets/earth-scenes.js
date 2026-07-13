/* ============================================================
   AgriOS — EARTH THEATER scene presets (pure, DOM-free)

   Cinematic, operator-focused scene presets. Each is a complete,
   deterministic description of a planetary view: where to fly the camera,
   which layers to enable, which filters to apply, a short analyst
   narrative, and the honest source posture for that scene. The
   orchestrator (assets/earth.js) consumes these to drive fly-to + layer
   selection; the pure shape here is unit-tested for validity and for
   referential integrity against the EARTH_LAYERS catalog.

   No DOM, no GL, no storage, no imports. Loads as window.EARTH_SCENES and
   is loadable in a node:vm sandbox for the automated tests.

   Layer ids referenced below MUST exist in EARTH_LAYERS.CATALOG. The
   `simPreset` (when present) MUST be a SIM_ENGINE preset id.
   ============================================================ */
(function (root) {
  'use strict';

  var SCENES = [
    {
      id: 'global-food-pressure',
      label: 'Global Food Pressure',
      icon: 'globe',
      camera: { lng: 10, lat: 20, zoom: 1.1 },
      layers: ['sat-viirs', 'chokepoints', 'breadbaskets', 'routes', 'events-weather', 'events-conflict', 'events-market', 'alerts'],
      filters: {},
      narrative: 'The whole board: breadbaskets, chokepoints and modeled corridors under live weather, conflict and market signals. Start here, then drill into a pressure point.',
      sourceState: 'Live events from /api/intel where connected; food-system geography is observed structure; corridors are modeled.'
    },
    {
      id: 'black-sea-grain',
      label: 'Black Sea Grain',
      icon: 'wheat',
      camera: { lng: 34, lat: 45, zoom: 3.6 },
      layers: ['sat-viirs', 'chokepoints', 'breadbaskets', 'routes', 'events-conflict', 'sim-propagation', 'regional-pressure'],
      filters: { commodity: ['wheat', 'maize'] },
      narrative: 'The Turkish Straits are the sole maritime outlet for roughly a fifth of world wheat. This scene runs the Black Sea blockade scenario to trace disruption from ports through the straits to MENA importers.',
      sourceState: 'Chokepoint/breadbasket geography observed (Chatham House / FAO); propagation is a modeled scenario, not a forecast.',
      simPreset: 'blacksea-blockade'
    },
    {
      id: 'horn-of-africa-drought',
      label: 'Horn of Africa Drought',
      icon: 'sun',
      camera: { lng: 44, lat: 6, zoom: 3.8 },
      layers: ['sat-viirs', 'exposed', 'events-weather', 'events-humanitarian', 'events-hazard', 'alerts', 'regional-pressure'],
      filters: { severity: ['critical', 'high'] },
      narrative: 'Import-dependence meets recurrent drought across the Horn. Watch climate and humanitarian signals against the import-exposed regions carrying the least buffer.',
      sourceState: 'Weather/climate + humanitarian signals live from /api/intel where connected; exposure geography is observed structure.'
    },
    {
      id: 'panama-suez-chokepoints',
      label: 'Panama & Suez Chokepoints',
      icon: 'anchor',
      camera: { lng: -20, lat: 20, zoom: 1.6 },
      layers: ['sat-viirs', 'chokepoints', 'routes', 'events-logistics', 'sim-propagation'],
      filters: { category: ['maritime'] },
      narrative: 'Two canals carry a large share of intercontinental grain. Drought-driven draft limits at Panama and Red Sea disruption at Suez reshape routing and add weeks to voyages.',
      sourceState: 'Chokepoint geography observed; logistics signals live where connected; routing impact is modeled.',
      simPreset: 'suez-closure'
    },
    {
      id: 'fertilizer-shock',
      label: 'Fertilizer Input Shock',
      icon: 'flask-conical',
      camera: { lng: 45, lat: 40, zoom: 2.2 },
      layers: ['sat-viirs', 'fertilizer', 'breadbaskets', 'routes', 'sim-propagation', 'regional-pressure'],
      filters: { commodity: ['fertilizer'] },
      narrative: 'Potash and nitrogen concentrate in a few exporters. An input embargo degrades next-season yields far from the shock, showing why fertilizer is a food-security lever.',
      sourceState: 'Fertilizer hub geography observed; embargo propagation is a modeled scenario, not a forecast.',
      simPreset: 'fertilizer-embargo'
    }
  ];
  var SCENE_BY_ID = {};
  SCENES.forEach(function (s) { SCENE_BY_ID[s.id] = s; });

  function byId(id) { return SCENE_BY_ID[id] || null; }
  function ids() { return SCENES.map(function (s) { return s.id; }); }

  /* Validate a camera object (lng/lat/zoom in range). */
  function validCamera(c) {
    return !!c && isFinite(c.lng) && isFinite(c.lat) && isFinite(c.zoom) &&
      c.lng >= -180 && c.lng <= 180 && c.lat >= -90 && c.lat <= 90 && c.zoom >= 0 && c.zoom <= 22;
  }

  var API = {
    SCENES: SCENES,
    SCENE_BY_ID: SCENE_BY_ID,
    byId: byId,
    ids: ids,
    validCamera: validCamera
  };
  root.EARTH_SCENES = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
