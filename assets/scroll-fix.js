/* ============================================================
   SCROLL-FIX.JS
   Fixes the mouse-wheel dead zones:
   1. Filter inputs (native <input> traps wheel deltas on some browsers)
   2. Leaflet map (scrollWheelZoom hijacks page scroll on the map tab)
   ============================================================ */
(function(){
  'use strict';

  // ---------- Fix 1: forward wheel events from inputs/selects to the window ----------
  function forwardWheelToWindow(e){
    // Do nothing if the input is focused AND the target is a number/range spinner (native behavior expected there).
    const t = e.target;
    if (!t) return;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input') {
      const type = (t.type || 'text').toLowerCase();
      // Number/range benefit from wheel adjust — leave those alone
      if (type === 'number' || type === 'range') return;
    }
    // Otherwise: let the page scroll normally by forwarding the delta.
    // We can't just preventDefault (that stops scrolling entirely). Instead:
    // scroll the window and prevent the input from capturing.
    window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
  }

  document.addEventListener('wheel', function(e){
    const t = e.target;
    if (!t) return;
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const type = ((t.type || 'text') + '').toLowerCase();
      if (type === 'number' || type === 'range') return; // native scroll adjust OK
      // Only forward if the element isn't itself scrollable
      const cs = getComputedStyle(t);
      const canScroll = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && t.scrollHeight > t.clientHeight;
      if (canScroll) return;
      e.preventDefault();
      window.scrollBy({ top: e.deltaY, left: e.deltaX, behavior: 'auto' });
    }
  }, { passive: false, capture: true });

  // ---------- Fix 2: Disable Leaflet scrollWheelZoom so wheel scrolls the page ----------
  function disableMapWheelZoom(){
    // Look for any Leaflet map instance
    if (!window.L) return false;
    // Leaflet stores instances on the container element as ._leaflet_id but doesn't expose them globally.
    // We patch by walking DOM containers with class "leaflet-container".
    const containers = document.querySelectorAll('.leaflet-container');
    let patched = 0;
    containers.forEach(c => {
      // Leaflet attaches the map instance to the container as `_leaflet_map` in some versions,
      // otherwise we can find it via L.DomUtil's inner map. Easiest: fire a synthetic event that
      // Leaflet uses to disable wheel zoom.
      // Approach: monkey-patch L.Map.prototype.scrollWheelZoom via disable() on all live maps.
      // We can't grab instance easily — instead, add a wheel listener on the container that
      // stops Leaflet from receiving it and forwards to window.
      if (c.__wheelPatched) return;
      c.__wheelPatched = true;
      c.addEventListener('wheel', function(ev){
        // Stop Leaflet from seeing it
        ev.stopPropagation();
        // Scroll the page instead
        window.scrollBy({ top: ev.deltaY, left: ev.deltaX, behavior: 'auto' });
      }, { passive: false, capture: true });
      patched++;
    });
    return patched > 0;
  }

  // Retry until Leaflet map exists
  function tryPatchMap(attempt = 0){
    if (disableMapWheelZoom()) return;
    if (attempt < 40) setTimeout(() => tryPatchMap(attempt+1), 500);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => tryPatchMap(0), 500);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => tryPatchMap(0), 500));
  }
  // Also try again whenever the module changes (Leaflet may init lazily)
  window.addEventListener('atom:ready', () => setTimeout(() => tryPatchMap(0), 300));
  document.addEventListener('click', function(e){
    if (e.target && e.target.closest && e.target.closest('.nav-item')) {
      setTimeout(() => tryPatchMap(0), 400);
    }
  });
})();
