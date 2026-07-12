/* ============================================================
   AgriOS — Theater globe: pure, DOM-free helpers.

   Renderer selection (progressive enhancement + guaranteed fallback),
   reduced-motion auto-rotation gating, deterministic starfield, arc
   colour ramp, and corner-telemetry formatting. Kept free of any DOM /
   canvas / window dependency so it is unit-testable in node:vm exactly
   like theater-data.js / sim-engine.js. assets/theater.js consumes it.
   ============================================================ */
(function () {
  'use strict';
  var G = {};

  // Ordered corner-telemetry labels (also asserted in tests).
  G.TELEMETRY_LABELS = ['Region', 'Live sources', 'Routes', 'Events', 'Updated'];

  // Choose a renderer from a plain capability object. Progressive enhancement:
  //   - no 2D canvas at all           -> data-table fallback (degraded)
  //   - a bundled WebGL renderer ready -> webgl
  //   - otherwise                      -> the robust enhanced canvas-2D globe
  // Never throws; `caps` is a plain object so this is fully testable with no DOM.
  // Note: `caps.webgl` means "a bundled WebGL renderer is available", NOT merely
  // that the browser exposes a WebGL context — we ship no CDN/Three.js dependency,
  // so the canvas-2D path is the reliable default and the guaranteed fallback.
  G.selectRenderer = function (caps) {
    caps = caps || {};
    if (!caps.canvas2d) {
      return { renderer: 'table', autoRotate: false, degraded: true,
        status: 'Canvas unavailable — showing data table.' };
    }
    if (caps.webgl) {
      return { renderer: 'webgl', autoRotate: !caps.reducedMotion, degraded: false,
        status: 'WebGL globe active.' };
    }
    return { renderer: 'canvas2d', autoRotate: !caps.reducedMotion, degraded: false,
      status: 'Enhanced canvas globe active.' };
  };

  // Probe whether a raw WebGL context is obtainable. Takes a canvas factory so it
  // can be exercised without a DOM. Returns false on any failure (never throws).
  G.detectWebGLContext = function (makeCanvas) {
    try {
      var c = makeCanvas && makeCanvas();
      if (!c || typeof c.getContext !== 'function') return false;
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  };

  // Auto-rotation is disabled under reduced-motion, unconditionally.
  G.autoRotateEnabled = function (reducedMotion) { return !reducedMotion; };

  // Idle auto-rotation angular step in degrees, scaled by frame delta so speed is
  // framerate-independent. ~3.75°/s at 60fps. Zero under reduced-motion.
  G.autoRotateStep = function (reducedMotion, dtMs) {
    if (reducedMotion) return 0;
    var dt = (typeof dtMs === 'number' && dtMs > 0) ? Math.min(dtMs, 100) : 16;
    return 0.0625 * (dt / 16);
  };

  // Corner telemetry rows from a data snapshot. Pure formatting so both the
  // labels and the rendered values are deterministically testable.
  G.buildTelemetry = function (d) {
    d = d || {};
    var live = d.sourcesLive != null ? d.sourcesLive : 0;
    var total = d.sourcesTotal != null ? d.sourcesTotal : 0;
    var updated;
    if (d.updatedText) updated = d.updatedText;
    else if (d.updatedMs != null && d.nowMs != null) updated = G.formatAge(d.nowMs - d.updatedMs);
    else updated = '—';
    return [
      { label: 'Region', value: d.region || 'Global' },
      { label: 'Live sources', value: String(live) + (total ? '/' + total : '') },
      { label: 'Routes', value: String(d.routes != null ? d.routes : 0) },
      { label: 'Events', value: String(d.events != null ? d.events : 0) },
      { label: 'Updated', value: updated },
    ];
  };

  G.formatAge = function (ms) {
    if (ms == null || !isFinite(ms)) return '—';
    if (ms < 0) ms = 0;
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  };

  // Deterministic seeded starfield (LCG PRNG — no Math.random in the render path,
  // so a given seed always yields the same, in-bounds field). Testable.
  G.starfield = function (seed, count, w, h) {
    var s = (seed >>> 0) || 1, out = [];
    function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    count = Math.max(0, count | 0);
    w = w || 1; h = h || 1;
    for (var i = 0; i < count; i++) {
      out.push({ x: rnd() * w, y: rnd() * h, r: 0.4 + rnd() * 1.2, a: 0.2 + rnd() * 0.6, tw: rnd() * Math.PI * 2 });
    }
    return out;
  };

  // Route-arc colour ramp: irrigation blue (near/low) -> harvest gold (far/high), t in 0..1.
  G.arcColor = function (t) {
    t = Math.max(0, Math.min(1, isFinite(t) ? t : 0));
    var r = Math.round(70 + (226 - 70) * t);
    var g = Math.round(150 + (170 - 150) * t);
    var b = Math.round(190 + (50 - 190) * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  };

  if (typeof window !== 'undefined') window.THEATER_GLOBE = G;
  if (typeof module !== 'undefined' && module.exports) module.exports = G;
})();
