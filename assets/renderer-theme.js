/* ============================================================
   Renderer theme — single source of truth for canvas/globe/chart
   colors that cannot use CSS `var()` directly (2D canvas, Chart.js).
   Values are resolved from the active design-system CSS variables at
   runtime so the globe and charts re-theme with the app (dark/light).
   Falls back to the canonical dark token values when CSS is
   unavailable (e.g. Node test / SSR).
   ============================================================ */
(function (global) {
  'use strict';

  // Canonical dark fallbacks (bare HSL triplets, matching design-tokens.json).
  var FALLBACK = {
    background: '210 15% 4%',
    surface: '210 14% 8%',
    surfaceAlt: '210 14% 11%',
    border: '210 12% 18%',
    foreground: '0 0% 95%',
    foregroundMuted: '210 8% 65%',
    accentPrimary: '174 100% 45%',
    accentSecondary: '266 70% 62%',
    accentTertiary: '38 92% 58%',
    success: '152 60% 45%',
    warning: '38 92% 55%',
    danger: '0 72% 55%',
    info: '217 91% 60%',
    sevHigh: '28 90% 55%',
    sevModerate: '45 90% 52%',
    chart1: '174 100% 45%',
    chart2: '266 70% 62%',
    chart3: '38 92% 58%',
    chart4: '217 91% 60%',
    chart5: '340 75% 60%'
  };

  // CSS variable name per logical token.
  var CSSVAR = {
    background: '--background',
    surface: '--surface-c',
    surfaceAlt: '--surface-alt',
    border: '--border-c',
    foreground: '--foreground',
    foregroundMuted: '--foreground-muted',
    accentPrimary: '--accent-primary',
    accentSecondary: '--accent-secondary',
    accentTertiary: '--accent-tertiary',
    success: '--success',
    warning: '--warning',
    danger: '--danger',
    info: '--info',
    sevHigh: '--sev-high-c',
    sevModerate: '--sev-moderate-c',
    chart1: '--chart-1',
    chart2: '--chart-2',
    chart3: '--chart-3',
    chart4: '--chart-4',
    chart5: '--chart-5'
  };

  function readTriplet(key) {
    if (typeof document !== 'undefined' && document.documentElement && global.getComputedStyle) {
      try {
        var v = global.getComputedStyle(document.documentElement).getPropertyValue(CSSVAR[key]);
        if (v && v.trim()) return v.trim();
      } catch (e) { /* fall through */ }
    }
    return FALLBACK[key];
  }

  // hsl() color from a logical token, with optional alpha.
  function hsl(key, alpha) {
    var t = readTriplet(key);
    return alpha == null || alpha >= 1 ? 'hsl(' + t + ')' : 'hsl(' + t + ' / ' + alpha + ')';
  }

  var RendererTheme = {
    hsl: hsl,
    triplet: readTriplet,
    // Traffic-light severity → color (label+color redundancy handled in DOM).
    severity: function (level) {
      switch (level) {
        case 'critical': return hsl('danger');
        case 'high': return hsl('sevHigh');
        case 'moderate': return hsl('sevModerate');
        case 'stable': return hsl('success');
        case 'strategic': return hsl('accentPrimary');
        case 'medium': return hsl('accentPrimary');
        default: return hsl('foregroundMuted');
      }
    },
    severityMap: function () {
      return {
        critical: hsl('danger'),
        high: hsl('sevHigh'),
        moderate: hsl('sevModerate'),
        stable: hsl('success'),
        neutral: hsl('foregroundMuted')
      };
    },
    accent: function (alpha) { return hsl('accentPrimary', alpha); },
    danger: function (alpha) { return hsl('danger', alpha); },
    surface: function (alpha) { return hsl('surface', alpha); },
    grid: function () { return hsl('border', 0.5); },
    axisLabel: function () { return hsl('foregroundMuted'); },
    tooltipSurface: function () { return hsl('surfaceAlt', 0.98); },
    series: function () {
      return [hsl('chart1'), hsl('chart2'), hsl('chart3'), hsl('chart4'), hsl('chart5')];
    },
    // Commodity palette bound to token hues.
    commodity: function () {
      return {
        wheat: hsl('danger'),
        rice: hsl('accentPrimary'),
        maize: hsl('sevHigh'),
        soy: hsl('success'),
        coffee: hsl('accentTertiary'),
        cocoa: hsl('sevModerate')
      };
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RendererTheme;
  global.RendererTheme = RendererTheme;
})(typeof window !== 'undefined' ? window : globalThis);
