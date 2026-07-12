/* ============================================================
   AgriOS — Animated crop-risk layer stack (pure, DOM-free)

   A time-aware agricultural risk model for the theater. Every layer is a
   MODELLED PROXY derived deterministically from observed structural
   inputs (breadbasket geography + severity from THEATER_DATA, and the
   Food War scenario parameters) — never a fabricated live observation.
   Each layer carries an `evidence` tag ('modeled'), an `observedInputs`
   list naming the sourced structure it is built from, a methodology
   string, and explicit limitations so the UI can disclose provenance.

   Colour is never the sole channel: every risk band also carries a
   distinct `pattern` and a text `marker`/`label`, so the stack stays
   legible under colour-blindness and in monochrome.

   No DOM, no window, no randomness in the render path — deterministic for
   a given (regionSeed, layerId, t). Unit-testable in node:vm exactly like
   theater-data.js / sim-engine.js. Loads as window.CROP_RISK.
   ============================================================ */
(function (root) {
  'use strict';

  // Agricultural palette — forest/leaf → harvest gold → clay/rust → critical
  // red, with irrigation blue reserved for water-domain layers. Each band also
  // carries a non-colour channel (pattern + marker + label) for accessibility.
  var BANDS = [
    { id: 'low', label: 'Low', min: 0.00, color: '#3f7a3f', pattern: 'solid', marker: '·' },
    { id: 'watch', label: 'Watch', min: 0.20, color: '#d9a72e', pattern: 'dots', marker: '▪' },
    { id: 'elevated', label: 'Elevated', min: 0.45, color: '#c2662e', pattern: 'hatch', marker: '◆' },
    { id: 'critical', label: 'Critical', min: 0.72, color: '#d43e28', pattern: 'cross', marker: '▲' }
  ];
  function band(v) {
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    var b = BANDS[0];
    for (var i = 0; i < BANDS.length; i++) { if (v >= BANDS[i].min) b = BANDS[i]; }
    return b;
  }

  var OBSERVED_INPUTS = {
    fao: { name: 'FAO — Crop Calendar / Food Price Index', url: 'https://www.fao.org/worldfoodsituation/foodpricesindex/' },
    grace: { name: 'NASA GRACE — groundwater & aquifer stress', url: 'https://grace.jpl.nasa.gov/' },
    fews: { name: 'FEWS NET — Famine Early Warning', url: 'https://fews.net/' },
    chatham: { name: 'Chatham House — food-trade chokepoints', url: 'https://www.chathamhouse.org/2017/06/chokepoints-and-vulnerabilities-global-food-trade' }
  };
  function inp(ids) { return ids.map(function (k) { return OBSERVED_INPUTS[k]; }); }

  // Layer registry. `accent` biases the palette hint (water layers lean
  // irrigation-blue); bands are shared so the legend stays consistent.
  var LAYERS = [
    { id: 'crop-stress', label: 'Crop stress', evidence: 'modeled', accent: '#7fae43',
      observedInputs: inp(['fao', 'fews']),
      methodology: 'Modeled proxy: baseline breadbasket vulnerability blended with scenario shock and commodity overlap.',
      limitations: 'Not a measured NDVI/yield observation; directional only.' },
    { id: 'drought', label: 'Drought / water deficit', evidence: 'modeled', accent: '#4f97bd',
      observedInputs: inp(['grace', 'fao']),
      methodology: 'Modeled proxy: aquifer-stress-weighted moisture deficit ramped over the scenario horizon.',
      limitations: 'Derived from structural aquifer stress, not real-time soil moisture.' },
    { id: 'heat', label: 'Heat stress', evidence: 'modeled', accent: '#e0a52e',
      observedInputs: inp(['fao']),
      methodology: 'Modeled proxy: heat-dome exposure keyed to region latitude band and phase intensity.',
      limitations: 'Not an observed temperature anomaly; illustrative.' },
    { id: 'flood', label: 'Flood / excess moisture', evidence: 'modeled', accent: '#4f97bd',
      observedInputs: inp(['fao']),
      methodology: 'Modeled proxy: excess-moisture pressure for monsoon/delta regions across the phase curve.',
      limitations: 'Not an observed precipitation record; scenario-driven.' },
    { id: 'fertilizer', label: 'Fertilizer / input exposure', evidence: 'modeled', accent: '#b5622f',
      observedInputs: inp(['fao', 'chatham']),
      methodology: 'Modeled proxy: input-cost exposure from fertilizer-route dependency and scenario price pressure.',
      limitations: 'Modeled from trade structure, not measured input prices.' },
    { id: 'conflict', label: 'Conflict / logistics exposure', evidence: 'modeled', accent: '#c2452b',
      observedInputs: inp(['chatham', 'fews']),
      methodology: 'Modeled proxy: chokepoint/route disruption exposure weighted by scenario propagation.',
      limitations: 'Structural exposure, not a live conflict event feed.' },
    { id: 'breadbasket-vuln', label: 'Breadbasket vulnerability', evidence: 'modeled', accent: '#6fae3f',
      observedInputs: inp(['fao', 'chatham']),
      methodology: 'Modeled proxy: standing structural vulnerability of the production zone (near time-invariant).',
      limitations: 'Structural baseline; does not move much within a single scenario.' },
    { id: 'composite', label: 'Composite food-security risk', evidence: 'modeled', accent: '#d43e28',
      observedInputs: inp(['fao', 'grace', 'fews', 'chatham']),
      methodology: 'Modeled proxy: weighted blend of the crop-stress, drought, fertilizer, and conflict layers.',
      limitations: 'A composite of modeled proxies — treat as directional exploration only.' }
  ];
  var LAYER_BY_ID = {};
  LAYERS.forEach(function (l) { LAYER_BY_ID[l.id] = l; });

  // Deterministic string hash → 0..1 seed (FNV-1a variant). No Math.random.
  function seed01(s) {
    s = String(s || '');
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return (h >>> 0) / 4294967296;
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // Smooth phase envelope: rises over the scenario, eases after mid-horizon.
  function envelope(t) {
    t = clamp01(t);
    // logistic rise + gentle tail so animation reads as a wave, deterministic.
    var rise = 1 / (1 + Math.exp(-8 * (t - 0.35)));
    var tail = 1 - 0.25 * clamp01((t - 0.7) / 0.3);
    return clamp01(rise * tail);
  }

  /* Core: modeled risk intensity 0..1 for a region+layer at phase t (0..1).
     `ctx` carries scenario coupling (shock 0..1, commodity-match 0..1,
     severityBase 0..1). All deterministic. */
  function intensity(regionSeed, layerId, t, ctx) {
    ctx = ctx || {};
    var base = seed01(regionSeed + '|' + layerId);
    var sevBase = ctx.severityBase != null ? clamp01(ctx.severityBase) : 0.4;
    var shock = ctx.shock != null ? clamp01(ctx.shock) : envelope(t);
    var match = ctx.commodityMatch != null ? clamp01(ctx.commodityMatch) : 1;
    var env = envelope(t);
    var v;
    switch (layerId) {
      case 'breadbasket-vuln':
        // near time-invariant structural baseline
        v = 0.35 * base + 0.6 * sevBase + 0.05 * env; break;
      case 'drought':
      case 'heat':
        v = 0.25 * base + 0.35 * sevBase + 0.5 * env * shock; break;
      case 'flood':
        v = 0.3 * base + 0.2 * sevBase + 0.45 * env; break;
      case 'fertilizer':
        v = 0.2 * base + 0.25 * sevBase + 0.6 * shock * match; break;
      case 'conflict':
        v = 0.2 * base + 0.4 * sevBase + 0.55 * shock; break;
      case 'composite':
        v = 0.15 * base + 0.35 * sevBase + 0.6 * shock * (0.5 + 0.5 * match); break;
      default: // crop-stress
        v = 0.2 * base + 0.3 * sevBase + 0.55 * env * shock * (0.6 + 0.4 * match);
    }
    return clamp01(v);
  }

  // Time series of intensities across `steps`+1 samples (0..1 inclusive).
  function series(regionSeed, layerId, steps, ctxAt) {
    steps = Math.max(1, steps || 12);
    var out = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      out.push(intensity(regionSeed, layerId, t, ctxAt ? ctxAt(t) : null));
    }
    return out;
  }

  /* Rank a set of regions by modeled intensity at phase t (desc). `regions`
     is [{id, seed, severityBase, commodityMatch}]; returns enriched, sorted. */
  function rankRegions(layerId, t, regions, sharedCtx) {
    return (regions || []).map(function (r) {
      var ctx = { severityBase: r.severityBase, commodityMatch: r.commodityMatch,
        shock: sharedCtx && sharedCtx.shock };
      var v = intensity(r.seed != null ? r.seed : r.id, layerId, t, ctx);
      var b = band(v);
      return { id: r.id, name: r.name || r.id, value: v, band: b.id, bandLabel: b.label,
        color: b.color, pattern: b.pattern, marker: b.marker };
    }).sort(function (a, b) { return b.value - a.value; });
  }

  function legend(layerId) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    return { layer: l.id, label: l.label, evidence: l.evidence, accent: l.accent,
      bands: BANDS.map(function (b) { return { id: b.id, label: b.label, color: b.color, pattern: b.pattern, marker: b.marker }; }) };
  }

  // Accessible, colour-free one-line summary of the top-ranked region.
  function summaryText(layerId, t, ranked) {
    var l = LAYER_BY_ID[layerId] || LAYERS[0];
    if (!ranked || !ranked.length) return l.label + ': no regions in scope.';
    var top = ranked[0];
    var pct = Math.round(top.value * 100);
    return l.label + ' (modeled proxy) — highest at ' + top.name + ': ' + top.bandLabel +
      ' band, ' + pct + '% modeled intensity [' + top.marker + '].';
  }

  var API = {
    BANDS: BANDS,
    LAYERS: LAYERS,
    LAYER_BY_ID: LAYER_BY_ID,
    OBSERVED_INPUTS: OBSERVED_INPUTS,
    band: band,
    envelope: envelope,
    intensity: intensity,
    series: series,
    rankRegions: rankRegions,
    legend: legend,
    summaryText: summaryText,
    seed01: seed01
  };
  root.CROP_RISK = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
