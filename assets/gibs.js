/* ============================================================
   AgriOS — NASA GIBS satellite-context helper (pure, DOM-free)

   Builds standards-based WMTS (EPSG:3857 / GoogleMapsCompatible) tile
   URL templates for NASA's Global Imagery Browse Services so the Map/2D
   theater can overlay daily corrected-reflectance true-colour imagery.

   No API key, no secret, no CDN dependency of our own — GIBS is an open,
   standards-based service. This module carries NO DOM/Leaflet/window
   dependency so it is unit-testable in node:vm exactly like the other
   theater core modules; assets/app.js consumes it to build the layer.

   PROVENANCE DISCIPLINE: GIBS corrected-reflectance is a DAILY product
   with ~1 day processing latency. It is satellite *context*, never
   "live". Every label carries the observation date + the source, and
   `LIVE` is hard-false so the UI can never mislabel it.

   Docs:
   - https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api
   - https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml
   ============================================================ */
(function (root) {
  'use strict';

  var ENDPOINT = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
  // Public GIBS WMS (EPSG:4326 / plate carrée) — a single GetMap returns one
  // equirectangular world image, which composites directly onto the flat 2D
  // theater surface without a client-side tiler. Same open service, no key.
  var WMS_ENDPOINT = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
  var ATTRIBUTION = 'Satellite context: NASA EOSDIS GIBS / Earthdata';
  var SOURCE_URL = 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api';
  var LIVE = false; // daily product w/ latency — never "live"

  // Corrected-reflectance true-colour layers verified for EPSG:3857
  // (GoogleMapsCompatible). All are daily with ~1 day latency and need no key.
  //
  // `swathGaps` flags layers whose single-day WHOLE-GLOBE mosaic shows black
  // triangular gores between orbit passes near the equator: the ~2330 km MODIS
  // swath does not fully overlap day-to-day, so a global GetMap has real black
  // wedges in the data (a data artifact, not a render bug). VIIRS's wider
  // ~3060 km swath is gap-free daily, so it is the preferred whole-globe underlay.
  // NOAA-20 is used over SNPP because SNPP near-real-time is frequently
  // unpopulated (an all-black frame), while NOAA-20 is the current operational,
  // fully-populated corrected-reflectance feed.
  var LAYERS = [
    { id: 'modis-terra', wmtsId: 'MODIS_Terra_CorrectedReflectance_TrueColor',
      label: 'MODIS Terra · true colour', tileMatrixSet: 'GoogleMapsCompatible_Level9',
      format: 'jpg', maxNativeZoom: 9, cadence: 'daily', latencyDays: 1, swathGaps: true,
      description: 'MODIS/Terra corrected-reflectance true colour (morning overpass; daily orbit gaps near the equator).' },
    { id: 'modis-aqua', wmtsId: 'MODIS_Aqua_CorrectedReflectance_TrueColor',
      label: 'MODIS Aqua · true colour', tileMatrixSet: 'GoogleMapsCompatible_Level9',
      format: 'jpg', maxNativeZoom: 9, cadence: 'daily', latencyDays: 1, swathGaps: true,
      description: 'MODIS/Aqua corrected-reflectance true colour (afternoon overpass; daily orbit gaps near the equator).' },
    { id: 'viirs-noaa20', wmtsId: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor',
      label: 'VIIRS NOAA-20 · true colour', tileMatrixSet: 'GoogleMapsCompatible_Level9',
      format: 'jpg', maxNativeZoom: 9, cadence: 'daily', latencyDays: 1, swathGaps: false,
      description: 'VIIRS/NOAA-20 corrected-reflectance true colour — gap-free daily global coverage (preferred whole-globe view).' }
  ];
  var LAYER_BY_ID = {};
  LAYERS.forEach(function (l) { LAYER_BY_ID[l.id] = l; });

  // Preferred whole-globe visual underlay: the first layer with no daily orbit
  // gores (VIIRS), so the flat 2D map defaults to one clean continuous image
  // rather than a MODIS mosaic streaked with black triangular seams.
  function defaultVisualLayerId() {
    for (var i = 0; i < LAYERS.length; i++) if (!LAYERS[i].swathGaps) return LAYERS[i].id;
    return LAYERS[0].id;
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  // UTC ISO date (YYYY-MM-DD) — GIBS TIME dimension is UTC calendar day.
  function isoDate(d) {
    d = (d instanceof Date) ? d : new Date(d);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function dayMs() { return 86400000; }

  // Most-recent safely-available observation date for a layer (now - latency).
  function defaultDate(now, layerId) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    var base = (now == null) ? Date.now() : (now instanceof Date ? now.getTime() : now);
    return isoDate(new Date(base - l.latencyDays * dayMs()));
  }

  // Selectable dates: `count` calendar days, newest first, ending at the newest
  // safely-available date. Deterministic given `now`.
  function availableDates(now, count, layerId) {
    count = Math.max(1, count || 8);
    var newest = defaultDate(now, layerId);
    var t = Date.parse(newest + 'T00:00:00Z');
    var out = [];
    for (var i = 0; i < count; i++) out.push(isoDate(new Date(t - i * dayMs())));
    return out;
  }

  // Leaflet-ready WMTS REST template. {z}/{y}/{x} left as placeholders for
  // Leaflet's tile engine; date is baked in (TIME dimension).
  function tileUrlTemplate(layerId, date) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    var d = date || defaultDate(null, l.id);
    return ENDPOINT + '/' + l.wmtsId + '/default/' + d + '/' + l.tileMatrixSet +
      '/{z}/{y}/{x}.' + l.format;
  }

  // Single whole-world WMS GetMap URL (EPSG:4326, plate carrée) for the flat 2D
  // canvas surface. BBOX is the full globe so the returned image maps linearly
  // onto an equirectangular projection. No key/secret; TIME bakes in the date.
  function snapshotUrl(layerId, date, width, height) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    var d = date || defaultDate(null, l.id);
    var w = Math.max(2, Math.round(width || 1024));
    var h = Math.max(1, Math.round(height || 512));
    return WMS_ENDPOINT +
      '?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0' +
      '&LAYERS=' + l.wmtsId +
      '&CRS=EPSG:4326&BBOX=-90,-180,90,180' +
      '&WIDTH=' + w + '&HEIGHT=' + h +
      '&FORMAT=image/jpeg&TIME=' + d;
  }

  // Human-facing context label — always names the source + observation date and
  // is explicit that this is daily context, not a live feed.
  function contextLabel(layerId, date) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    var d = date || defaultDate(null, l.id);
    return 'Satellite context · ' + l.label + ' · ' + d + ' (daily, not live)';
  }
  // Short data-freshness label for the control chip.
  function freshnessLabel(layerId, date) {
    var d = date || defaultDate(null, layerId);
    return 'Daily · observed ' + d + ' · near-real-time (not live)';
  }

  var API = {
    ENDPOINT: ENDPOINT,
    WMS_ENDPOINT: WMS_ENDPOINT,
    ATTRIBUTION: ATTRIBUTION,
    SOURCE_URL: SOURCE_URL,
    LIVE: LIVE,
    LAYERS: LAYERS,
    LAYER_BY_ID: LAYER_BY_ID,
    defaultVisualLayerId: defaultVisualLayerId,
    isoDate: isoDate,
    defaultDate: defaultDate,
    availableDates: availableDates,
    tileUrlTemplate: tileUrlTemplate,
    snapshotUrl: snapshotUrl,
    contextLabel: contextLabel,
    freshnessLabel: freshnessLabel
  };
  root.GIBS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
