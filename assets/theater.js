/* ============================================================
   AGRI-NEXUS — Geospatial Intelligence Theater + Food War deck (UI)

   Cinematic canvas-2D globe (reliable, keyless, WebGL-independent) with
   fly-to, clustering, animated route arcs, accessible controls, and a
   detail GenUI drawer. Below it, an explainable animated Food War
   simulation deck driven by SIM_ENGINE.

   Depends on browser globals: AGRI_APP (bridge), THEATER_DATA,
   THEATER_FILTERS, THEATER_ACTIONS, SIM_ENGINE. Degrades to a data
   table if canvas is unavailable. No storage of any kind; URL state via
   history.replaceState only.
   ============================================================ */
(function () {
  'use strict';
  var A = window.AGRI_APP, D = window.THEATER_DATA, F = window.THEATER_FILTERS,
      ACT = window.THEATER_ACTIONS, SIM = window.SIM_ENGINE;
  if (!A || !D || !F || !SIM) return; // base app must be present

  var esc = A.esc, icon = A.icon;
  var REDUCED = !!A.reduced;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var SEVC = D.SEVERITY_COLOR;

  var st = {
    view: '3d', zoom: 1, rotLng: -20, rotLat: 12,
    filter: F.emptyState(),
    selected: null,
    // sim
    simParams: null, sim: null, day: 0, playing: false, speed: 1,
  };

  var canvas, ctx, W = 0, H = 0, DPR = 1, raf = null, animTo = null, dragging = false, lastPt = null, hoverNode = null;
  var simTimer = null, listeners = [], mounted = false;

  function on(el, ev, fn, opt) { if (!el) return; el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); }
  function offAll() { listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) {} }); listeners = []; }

  /* ================= projection ================= */
  function radius() { return Math.max(80, Math.min(W, H) * 0.42) * st.zoom; }
  function project(lat, lng) {
    var R = radius(), cx = W / 2, cy = H / 2;
    if (st.view === '2d') {
      var x = cx + ((lng - st.rotLng) / 180) * R;
      var y = cy - (lat / 90) * (R * 0.55);
      // wrap longitude
      while (x < cx - R) x += 2 * R; while (x > cx + R) x -= 2 * R;
      return { x: x, y: y, visible: true, front: true };
    }
    var la = lat * Math.PI / 180, lo = (lng - st.rotLng) * Math.PI / 180;
    var rla = st.rotLat * Math.PI / 180;
    var cosc = Math.sin(rla) * Math.sin(la) + Math.cos(rla) * Math.cos(la) * Math.cos(lo);
    var x = cx + R * Math.cos(la) * Math.sin(lo);
    var y = cy - R * (Math.cos(rla) * Math.sin(la) - Math.sin(rla) * Math.cos(la) * Math.cos(lo));
    return { x: x, y: y, visible: cosc >= -0.02, front: cosc >= 0 };
  }

  /* ================= draw ================= */
  function clear() { ctx.clearRect(0, 0, W, H); }
  function drawGlobe() {
    var R = radius(), cx = W / 2, cy = H / 2;
    if (st.view === '3d') {
      var g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R);
      g.addColorStop(0, '#16202a'); g.addColorStop(1, '#0b0f13');
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(95,179,196,0.10)';
      for (var la = -60; la <= 60; la += 30) drawParallel(la);
      for (var lo = -180; lo < 180; lo += 30) drawMeridian(lo);
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(95,179,196,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();
    } else {
      ctx.fillStyle = '#0b0f13'; ctx.fillRect(cx - R, cy - R * 0.55, 2 * R, R * 1.1);
      ctx.strokeStyle = 'rgba(95,179,196,0.10)'; ctx.lineWidth = 1;
      for (var la2 = -60; la2 <= 60; la2 += 30) { var p = project(la2, st.rotLng); ctx.beginPath(); ctx.moveTo(cx - R, p.y); ctx.lineTo(cx + R, p.y); ctx.stroke(); }
      ctx.strokeStyle = 'rgba(95,179,196,0.25)'; ctx.strokeRect(cx - R, cy - R * 0.55, 2 * R, R * 1.1);
    }
  }
  function drawParallel(lat) {
    ctx.beginPath(); var started = false;
    for (var lng = -180; lng <= 180; lng += 4) { var p = project(lat, lng); if (!p.visible) { started = false; continue; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
    ctx.stroke();
  }
  function drawMeridian(lng) {
    ctx.beginPath(); var started = false;
    for (var lat = -90; lat <= 90; lat += 4) { var p = project(lat, lng); if (!p.visible) { started = false; continue; } if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y); }
    ctx.stroke();
  }

  function activeSet() { return F.applyFilters(D.NODES, D.ROUTES, st.filter); }

  function drawRoutes(routes) {
    var t = Date.now() / 1000;
    routes.forEach(function (rt) {
      var fn = D.nodeById(rt.from), tn = D.nodeById(rt.to);
      if (!fn || !tn) return;
      var a = project(fn.lat, fn.lng), b = project(tn.lat, tn.lng);
      if (!a.front && !b.front) return;
      var midx = (a.x + b.x) / 2, midy = (a.y + b.y) / 2 - Math.hypot(b.x - a.x, b.y - a.y) * 0.18;
      var com = (D.COMMODITIES.filter(function (c) { return c.id === rt.commodity; })[0]) || { color: '#5fb3c4' };
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(midx, midy, b.x, b.y);
      ctx.strokeStyle = com.color; ctx.globalAlpha = 0.5; ctx.lineWidth = 1 + rt.weight / 12; ctx.stroke(); ctx.globalAlpha = 1;
      // directional particle (only when meaningful: higher severity/weight), respect reduced motion
      if (!REDUCED && (rt.severity === 'critical' || rt.severity === 'high')) {
        var f = (t * 0.25 + rt.weight * 0.05) % 1;
        var qx = qbez(a.x, midx, b.x, f), qy = qbez(a.y, midy, b.y, f);
        ctx.beginPath(); ctx.arc(qx, qy, 2.2, 0, Math.PI * 2); ctx.fillStyle = com.color; ctx.fill();
      }
    });
  }
  function qbez(p0, p1, p2, t) { var u = 1 - t; return u * u * p0 + 2 * u * t * p1 + t * t * p2; }

  /* proximity clustering in screen space */
  function clusterNodes(nodes) {
    var cell = 46, grid = {}, out = [];
    nodes.forEach(function (n) {
      var p = project(n.lat, n.lng); if (!p.front) return;
      var key = Math.round(p.x / cell) + ':' + Math.round(p.y / cell);
      if (!grid[key]) { grid[key] = { x: p.x, y: p.y, items: [], sev: 'stable' }; out.push(grid[key]); }
      var c = grid[key]; c.items.push(n); c.x = (c.x + p.x) / 2; c.y = (c.y + p.y) / 2;
      if (D.SEVERITY_ORDER[n.severity] > D.SEVERITY_ORDER[c.sev]) c.sev = n.severity;
    });
    return out;
  }

  var clusters = [];
  function drawNodes(nodes) {
    clusters = clusterNodes(nodes);
    clusters.forEach(function (c) {
      var n = c.items.length, r = n > 1 ? Math.min(22, 8 + n * 2) : nodeRadius(c.items[0]);
      var col = SEVC[c.sev] || '#7d8794';
      if (c.sev === 'critical' && !REDUCED && n === 1) {
        var pulse = (Math.sin(Date.now() / 400) + 1) / 2;
        ctx.beginPath(); ctx.arc(c.x, c.y, r + 4 + pulse * 6, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.globalAlpha = 0.25; ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.globalAlpha = hoverNode && c.items.indexOf(hoverNode) !== -1 ? 1 : 0.85; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 1.4; ctx.strokeStyle = '#0a0c0f'; ctx.stroke();
      if (n > 1) { ctx.fillStyle = '#0a0c0f'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), c.x, c.y); }
      else { drawKindGlyph(c.items[0], c.x, c.y); }
    });
  }
  function nodeRadius(n) { return 5 + D.SEVERITY_ORDER[n.severity]; }
  function drawKindGlyph(n, x, y) {
    ctx.fillStyle = '#0a0c0f'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var g = { chokepoint: '◆', breadbasket: '▲', fertilizer: '✦', exposed: '●' }[n.kind] || '';
    ctx.fillText(g, x, y);
  }

  function drawScene() {
    if (!ctx) return;
    clear(); drawGlobe();
    var set = activeSet();
    if (!st.filter.layers.length || st.filter.layers.indexOf('routes') !== -1) drawRoutes(set.routes);
    drawNodes(set.nodes);
    updateSrStatus(set);
  }

  /* ================= animation loop ================= */
  function needsRaf() { return (!REDUCED) && (animTo || st.playing || anyLiveMotion()); }
  function anyLiveMotion() { var s = activeSet(); return s.nodes.some(function (n) { return n.severity === 'critical'; }) || s.routes.some(function (r) { return r.severity === 'critical' || r.severity === 'high'; }); }
  function loop() {
    raf = null;
    if (animTo) stepFlyTo();
    drawScene();
    if (needsRaf() && mounted) raf = requestAnimationFrame(loop);
  }
  function kick() { if (!raf && mounted) raf = requestAnimationFrame(loop); else drawScene(); }

  function stepFlyTo() {
    var a = animTo, k = REDUCED ? 1 : 0.12;
    st.rotLng += (a.lng - st.rotLng) * k;
    st.rotLat += (a.lat - st.rotLat) * k;
    st.zoom += (a.zoom - st.zoom) * k;
    if (Math.abs(a.lng - st.rotLng) < 0.4 && Math.abs(a.lat - st.rotLat) < 0.4 && Math.abs(a.zoom - st.zoom) < 0.01) {
      st.rotLng = a.lng; st.rotLat = a.lat; st.zoom = a.zoom; animTo = null;
    }
  }
  function flyTo(lat, lng, zoom) {
    animTo = { lat: Math.max(-80, Math.min(80, lat)), lng: lng, zoom: zoom || Math.max(st.zoom, 1.6) };
    if (REDUCED) { stepFlyTo(); drawScene(); } else kick();
  }

  /* ================= sizing ================= */
  function resize() {
    if (!canvas) return;
    var box = canvas.parentNode.getBoundingClientRect();
    W = Math.max(280, box.width); H = Math.max(320, Math.min(560, box.width * 0.62));
    DPR = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawScene();
  }

  /* ================= hit testing ================= */
  function pick(px, py) {
    for (var i = 0; i < clusters.length; i++) {
      var c = clusters[i], n = c.items.length, r = (n > 1 ? Math.min(22, 8 + n * 2) : nodeRadius(c.items[0])) + 4;
      if ((px - c.x) * (px - c.x) + (py - c.y) * (py - c.y) <= r * r) return c;
    }
    return null;
  }

  /* ================= detail drawer (GenUI, tabbed) ================= */
  function openNode(node) {
    st.selected = node.id; syncUrl();
    var routes = node.kind === 'chokepoint' ? D.routesThrough(node.id) : D.ROUTES.filter(function (r) { return r.from === node.id || r.to === node.id; });
    var evBadge = node.observed
      ? '<span class="ev-badge observed" data-testid="evidence-observed">Observed · sourced</span>'
      : '<span class="ev-badge modeled" data-testid="evidence-modeled">Modeled · illustrative</span>';
    var tabs = ['Overview', 'Dependencies', 'Exposure', 'Actions', 'Provenance'];
    var body = '<div class="th-detail" data-testid="theater-detail">' +
      '<div class="th-d-head">' + kindChip(node) + evBadge + '<span class="sev-chip ' + node.severity + '">' + node.severity + '</span></div>' +
      '<div class="th-tabs" role="tablist">' + tabs.map(function (t, i) { return '<button class="th-tab' + (i === 0 ? ' active' : '') + '" role="tab" data-tab="' + t.toLowerCase() + '" data-testid="th-tab-' + t.toLowerCase() + '">' + t + '</button>'; }).join('') + '</div>' +
      '<div class="th-tabpanes">' +
        pane('overview', true, overviewHtml(node)) +
        pane('dependencies', false, depsHtml(node, routes)) +
        pane('exposure', false, exposureHtml(node, routes)) +
        pane('actions', false, actionsHtml(node)) +
        pane('provenance', false, provHtml(node)) +
      '</div></div>';
    A.openDrawer((node.name || 'Detail'), body);
    wireDetail(node, routes);
  }
  function pane(id, active, html) { return '<div class="th-pane' + (active ? ' active' : '') + '" data-pane="' + id + '"' + (active ? '' : ' hidden') + '>' + html + '</div>'; }
  function kindChip(n) { var l = { chokepoint: 'Chokepoint', breadbasket: 'Breadbasket', fertilizer: 'Fertilizer hub', exposed: 'Import-exposed' }[n.kind] || n.kind; return '<span class="kind-chip ' + n.kind + '">' + esc(l) + '</span>'; }
  function commodityChips(list) { return (list || []).map(function (c) { var m = D.COMMODITIES.filter(function (x) { return x.id === c; })[0]; return '<span class="com-chip" style="border-color:' + (m ? m.color : '#555') + '">' + esc(m ? m.label : c) + '</span>'; }).join(''); }
  function overviewHtml(n) {
    return '<p class="th-note">' + esc(n.note || '') + '</p>' +
      (n.share ? '<div class="mrow"><span class="k">Structural share</span><span class="v">' + esc(n.share) + '</span></div>' : '') +
      (n.category ? '<div class="mrow"><span class="k">Chokepoint type</span><span class="v">' + esc(n.category) + '</span></div>' : '') +
      '<div class="mrow"><span class="k">Commodities</span><span class="v">' + commodityChips(n.commodities) + '</span></div>' +
      (n.alternatives ? '<div class="mrow"><span class="k">Alternatives</span><span class="v">' + esc(n.alternatives.join('; ')) + '</span></div>' : '') +
      (n.humanitarian ? '<div class="mrow"><span class="k">Humanitarian pressure</span><span class="v">' + esc(n.humanitarian) + '</span></div>' : '');
  }
  function depsHtml(n, routes) {
    if (!routes.length) return '<p class="muted">No linked routes in the bundled network.</p>';
    return '<div class="th-deps">' + routes.map(function (r) {
      var fn = D.nodeById(r.from), tn = D.nodeById(r.to);
      return '<div class="dep-row"><span class="sev-dot ' + r.severity + '"></span>' + esc(fn ? fn.name : r.from) + ' → ' + esc(tn ? tn.name : r.to) +
        ' <span class="com-chip sm">' + esc(r.commodity) + '</span>' + (r.observed ? '' : ' <span class="ev-badge modeled sm">modeled</span>') + '</div>';
    }).join('') + '</div>';
  }
  function exposureHtml(n, routes) {
    var reach = {}; routes.forEach(function (r) { var id = r.to === n.id ? r.from : r.to; var x = D.nodeById(id); if (x) reach[x.id] = x; });
    var arr = Object.keys(reach).map(function (k) { return reach[k]; });
    return '<p class="th-note">Connected nodes reachable through this entity (' + arr.length + '):</p>' +
      (arr.length ? '<div class="th-deps">' + arr.map(function (x) { return '<div class="dep-row"><span class="sev-dot ' + x.severity + '"></span>' + esc(x.name) + ' ' + kindChip(x) + '</div>'; }).join('') + '</div>' : '<p class="muted">None.</p>');
  }
  function actionsHtml(n) {
    return '<div class="btn-row th-actions">' +
      '<button class="btn primary" data-act="mission" data-testid="th-act-mission">' + icon('flag') + ' Create team mission</button>' +
      '<button class="btn" data-act="warroom" data-testid="th-act-warroom">' + icon('swords') + ' Open War Room here</button>' +
      '<button class="btn" data-act="atom" data-testid="th-act-atom">' + icon('sparkles') + ' Ask ATOM about this</button>' +
      '<button class="btn" data-act="copy" data-testid="th-act-copy">' + icon('link') + ' Copy shareable link</button>' +
      '</div>';
  }
  function provHtml(n) {
    var s = n.sources || [];
    return '<p class="th-note">' + (n.observed ? 'Observed / sourced structural facts:' : 'Modeled proxy — cite underlying structure only:') + '</p>' +
      (s.length ? '<ul class="th-prov">' + s.map(function (x) { return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a></li>'; }).join('') + '</ul>' : '<p class="muted">No source attached.</p>');
  }
  function wireDetail(node, routes) {
    $$('.th-tab').forEach(function (b) { on(b, 'click', function () {
      $$('.th-tab').forEach(function (x) { x.classList.toggle('active', x === b); });
      var id = b.getAttribute('data-tab');
      $$('.th-pane').forEach(function (p) { var m = p.getAttribute('data-pane') === id; p.classList.toggle('active', m); p.hidden = !m; });
    }); });
    var da = $('.th-actions');
    if (da) $$('[data-act]', da).forEach(function (b) { on(b, 'click', function () {
      var act = b.getAttribute('data-act');
      if (act === 'mission') createMissionFrom(node);
      else if (act === 'warroom') { A.applyScenario({ type: 'foodwar', initiator: node.id, preset: guessPreset(node) }); }
      else if (act === 'atom') A.openAtom('Explain the dependency and exposure profile of ' + node.name + ' in global food trade, citing sources.');
      else if (act === 'copy') copyShareLink();
    }); });
    A.refreshIcons();
  }
  function guessPreset(node) {
    if (node.id === 'cp-turkish' || node.id === 'cp-blackseaports' || node.id === 'bb-blacksea') return 'blacksea-blockade';
    if (node.id === 'cp-suez' || node.id === 'cp-babel') return 'suez-closure';
    if (node.id === 'cp-hormuz' || node.kind === 'fertilizer') return 'fertilizer-embargo';
    if (node.kind === 'breadbasket') return 'multi-drought';
    return 'polycrisis';
  }
  function createMissionFrom(node) {
    if (window.AGRI_COLLAB && window.AGRI_COLLAB.openMissionComposer) {
      window.AGRI_COLLAB.openMissionComposer({ title: 'Mitigate risk at ' + node.name, objective: node.note || '' });
    } else {
      A.activateMode('command');
      if (A.refreshIcons) A.refreshIcons();
    }
  }

  /* ================= share link (no storage, no password) ================= */
  function currentUrlQuery() {
    var s = Object.assign({}, st.filter); s.sel = st.selected || null;
    if (st.simParams) s.sim = st.simParams;
    return F.serializeState(s);
  }
  function syncUrl() {
    try { var q = currentUrlQuery(); var url = location.pathname + (q ? '?' + q : '') + location.hash; history.replaceState(null, '', url); } catch (e) {}
  }
  function copyShareLink() {
    var q = currentUrlQuery(); var link = location.origin + location.pathname + (q ? '?' + q : '');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { flash('Shareable link copied.'); }, function () { flash(link); });
    else flash(link);
  }
  function flash(msg) { var s = $('#theaterStatus'); if (s) { s.textContent = msg; } }

  /* ================= SR + legend status ================= */
  function updateSrStatus(set) {
    var s = $('#theaterSr'); if (!s) return;
    s.textContent = set.nodes.length + ' nodes, ' + set.routes.length + ' routes shown. View ' + st.view + '.';
  }

  /* ================= interactions ================= */
  function bindCanvas() {
    on(canvas, 'pointerdown', function (e) { dragging = true; lastPt = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    on(canvas, 'pointermove', function (e) {
      var rect = canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top;
      if (dragging && lastPt) {
        var dx = e.clientX - lastPt.x, dy = e.clientY - lastPt.y; lastPt = { x: e.clientX, y: e.clientY };
        st.rotLng -= dx * 0.35 / st.zoom; st.rotLat = Math.max(-85, Math.min(85, st.rotLat + dy * 0.35 / st.zoom)); animTo = null; kick();
      } else {
        var c = pick(px, py); var hn = c ? c.items[0] : null;
        if (hn !== hoverNode) { hoverNode = hn; canvas.style.cursor = hn ? 'pointer' : 'grab'; showTooltip(c, px, py); kick(); }
        else showTooltip(c, px, py);
      }
    });
    on(canvas, 'pointerup', function (e) { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (x) {} });
    on(canvas, 'pointerleave', function () { dragging = false; hoverNode = null; hideTooltip(); });
    on(canvas, 'click', function (e) {
      var rect = canvas.getBoundingClientRect(), c = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (!c) return;
      if (c.items.length === 1) openNode(c.items[0]);
      else { flyTo(c.items[0].lat, c.items[0].lng, Math.min(3, st.zoom + 0.8)); }
    });
    on(canvas, 'wheel', function (e) { e.preventDefault(); var dir = e.deltaY > 0 ? -1 : 1; zoomBy(dir * 0.15); }, { passive: false });
    // keyboard
    canvas.setAttribute('tabindex', '0');
    on(canvas, 'keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowLeft') { st.rotLng -= 8; kick(); e.preventDefault(); }
      else if (k === 'ArrowRight') { st.rotLng += 8; kick(); e.preventDefault(); }
      else if (k === 'ArrowUp') { st.rotLat = Math.min(85, st.rotLat + 6); kick(); e.preventDefault(); }
      else if (k === 'ArrowDown') { st.rotLat = Math.max(-85, st.rotLat - 6); kick(); e.preventDefault(); }
      else if (k === '+' || k === '=') { zoomBy(0.2); e.preventDefault(); }
      else if (k === '-' || k === '_') { zoomBy(-0.2); e.preventDefault(); }
      else if (k === 'Home') { resetView(); e.preventDefault(); }
    });
  }
  function zoomBy(d) { st.zoom = Math.max(0.6, Math.min(3.2, st.zoom + d)); animTo = null; kick(); syncUrl(); }
  function resetView() { animTo = { lat: 12, lng: -20, zoom: 1 }; kick(); }

  function showTooltip(cluster, px, py) {
    var tip = $('#theaterTip'); if (!tip) return;
    if (!cluster) { tip.hidden = true; return; }
    var html;
    if (cluster.items.length > 1) html = '<b>' + cluster.items.length + ' entities</b><br><span class="tip-s">' + cluster.items.slice(0, 4).map(function (n) { return esc(n.name); }).join(', ') + (cluster.items.length > 4 ? '…' : '') + '</span>';
    else { var n = cluster.items[0]; html = '<b>' + esc(n.name) + '</b><br><span class="tip-s">' + esc(kindLabel(n)) + ' · ' + n.severity + ' · ' + (n.observed ? 'observed' : 'modeled') + '</span>'; }
    tip.innerHTML = html; tip.hidden = false;
    tip.style.left = Math.min(W - 180, px + 14) + 'px'; tip.style.top = (py + 14) + 'px';
  }
  function hideTooltip() { var tip = $('#theaterTip'); if (tip) tip.hidden = true; }
  function kindLabel(n) { return { chokepoint: 'Chokepoint', breadbasket: 'Breadbasket', fertilizer: 'Fertilizer hub', exposed: 'Import-exposed' }[n.kind] || n.kind; }

  /* ================= filters UI ================= */
  function buildFilters(host) {
    host.innerHTML = F.FILTER_DIMENSIONS.map(function (dim) {
      return '<div class="th-fdim" data-dim="' + dim.id + '"><div class="fdim-h">' + esc(dim.label) + ' <span class="fdim-or">OR</span></div><div class="fdim-opts">' +
        dim.options.map(function (o) { return '<button class="fchip" data-dim="' + dim.id + '" data-val="' + o + '" data-testid="fchip-' + dim.id + '-' + o + '">' + esc(o) + '</button>'; }).join('') +
        '</div></div>';
    }).join('') +
    '<div class="th-fmeta"><span class="fcount" id="theaterCount" data-testid="filter-count">—</span>' +
    '<span class="fand">AND across groups</span>' +
    '<button class="btn sm" id="theaterClear" data-testid="filter-clear">' + icon('x') + ' Clear all</button></div>';
    $$('.fchip', host).forEach(function (b) { on(b, 'click', function () { toggleFilter(b.getAttribute('data-dim'), b.getAttribute('data-val')); }); });
    on($('#theaterClear', host), 'click', function () { st.filter = F.emptyState(); st.filter.q = ''; var si = $('#theaterSearch'); if (si) si.value = ''; refreshFilterUI(); });
  }
  function toggleFilter(dim, val) {
    var arr = st.filter[dim]; if (!Array.isArray(arr)) return;
    var i = arr.indexOf(val); if (i === -1) arr.push(val); else arr.splice(i, 1);
    refreshFilterUI();
  }
  function refreshFilterUI() {
    $$('.fchip').forEach(function (b) { var dim = b.getAttribute('data-dim'), val = b.getAttribute('data-val'); b.classList.toggle('active', st.filter[dim] && st.filter[dim].indexOf(val) !== -1); });
    var set = activeSet(); var c = $('#theaterCount'); if (c) { var active = countActive(); c.textContent = set.count + ' results · ' + active + ' filters'; }
    renderResults(set);
    kick(); syncUrl();
  }
  function countActive() { var n = 0; ['layers', 'commodity', 'severity', 'category', 'evidence'].forEach(function (k) { n += st.filter[k].length; }); if (st.filter.region) n++; return n; }

  /* ================= NL search ================= */
  var exIdx = 0, exTimer = null;
  function buildSearch(host) {
    host.innerHTML =
      '<div class="th-search"><input id="theaterSearch" type="text" data-testid="theater-search" aria-label="Natural language search" placeholder="' + esc(F.NL_EXAMPLES[0]) + '" />' +
      '<button class="btn sm" id="theaterSearchBtn" data-testid="theater-search-btn">' + icon('search') + ' Parse</button></div>' +
      '<div class="th-understood" id="theaterUnderstood" data-testid="theater-understood" hidden></div>';
    var input = $('#theaterSearch', host);
    on($('#theaterSearchBtn', host), 'click', function () { runNL(input.value); });
    on(input, 'keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); runNL(input.value); } });
    if (!REDUCED) exTimer = setInterval(function () { exIdx = (exIdx + 1) % F.NL_EXAMPLES.length; if (document.activeElement !== input && !input.value) input.setAttribute('placeholder', F.NL_EXAMPLES[exIdx]); }, 3200);
  }
  function runNL(q) {
    var res = F.parseNL(q);
    var u = $('#theaterUnderstood');
    if (!res.understoodAny) { if (u) { u.hidden = false; u.innerHTML = '<span class="warn">Could not map that to filters. Try: <em>' + esc(F.NL_EXAMPLES[0]) + '</em></span>'; } return; }
    // merge understood into filter state
    ['layers', 'commodity', 'severity', 'category', 'evidence'].forEach(function (k) { st.filter[k] = res.state[k]; });
    st.filter.region = res.state.region;
    if (u) {
      u.hidden = false;
      var parts = [];
      if (res.understood.commodity.length) parts.push('commodity: ' + res.understood.commodity.join(', '));
      if (res.understood.severity.length) parts.push('severity: ' + res.understood.severity.join(', '));
      if (res.understood.layers.length) parts.push('layers: ' + res.understood.layers.join(', '));
      if (res.understood.category.length) parts.push('type: ' + res.understood.category.join(', '));
      if (res.understood.evidence.length) parts.push('evidence: ' + res.understood.evidence.join(', '));
      if (res.state.region) parts.push('region: “' + esc(res.state.region) + '”');
      u.innerHTML = '<span class="ok">Understood → ' + parts.join(' · ') + '</span>';
    }
    refreshFilterUI();
  }

  /* ================= results list (map alternative) ================= */
  function renderResults(set) {
    var host = $('#theaterResults'); if (!host) return;
    if (!set.nodes.length) { host.innerHTML = '<div class="empty" data-testid="theater-noresults">No entities match. <button class="btn sm" id="thResetFilters">Clear filters</button></div>'; var rb = $('#thResetFilters'); if (rb) on(rb, 'click', function () { st.filter = F.emptyState(); refreshFilterUI(); }); return; }
    host.innerHTML = set.nodes.slice(0, 40).map(function (n) {
      return '<button class="th-result" data-id="' + esc(n.id) + '" data-testid="theater-result"><span class="sev-dot ' + n.severity + '"></span><span class="tr-name">' + esc(n.name) + '</span><span class="tr-kind">' + esc(kindLabel(n)) + '</span>' + (n.observed ? '' : '<span class="ev-badge modeled sm">modeled</span>') + '</button>';
    }).join('');
    $$('.th-result', host).forEach(function (b) { on(b, 'click', function () { var n = D.nodeById(b.getAttribute('data-id')); if (n) { flyTo(n.lat, n.lng, Math.max(st.zoom, 1.8)); openNode(n); } }); });
  }

  /* ================= toolbar ================= */
  function buildToolbar(host) {
    host.innerHTML =
      '<button class="mtool" id="thZoomIn" aria-label="Zoom in" data-testid="th-zoom-in">+</button>' +
      '<button class="mtool" id="thZoomOut" aria-label="Zoom out" data-testid="th-zoom-out">−</button>' +
      '<button class="mtool" id="thHome" aria-label="Reset view" data-testid="th-home">⌂</button>' +
      '<button class="mtool" id="thToggle" aria-label="Toggle 2D/3D" data-testid="th-toggle">2D</button>' +
      '<button class="mtool" id="thCompass" aria-label="Reset north" data-testid="th-compass">✛</button>';
    on($('#thZoomIn', host), 'click', function () { zoomBy(0.3); });
    on($('#thZoomOut', host), 'click', function () { zoomBy(-0.3); });
    on($('#thHome', host), 'click', resetView);
    on($('#thCompass', host), 'click', function () { st.rotLat = 12; kick(); });
    on($('#thToggle', host), 'click', function () { st.view = st.view === '3d' ? '2d' : '3d'; $('#thToggle').textContent = st.view === '3d' ? '2D' : '3D'; kick(); syncUrl(); });
  }

  /* ================= legend ================= */
  function legendHtml() {
    return '<div class="th-legend" data-testid="theater-legend">' +
      '<div class="lg-group"><span class="lg-t">Severity</span>' + ['critical', 'high', 'moderate', 'stable'].map(function (s) { return '<span class="lg-item"><span class="sev-dot ' + s + '"></span>' + s + '</span>'; }).join('') + '</div>' +
      '<div class="lg-group"><span class="lg-t">Layers</span>' + D.LAYERS.map(function (l) { return '<span class="lg-item"><span class="lg-sw" style="background:' + l.color + '"></span>' + esc(l.label) + '</span>'; }).join('') + '</div>' +
      '<div class="lg-group"><span class="lg-t">Evidence</span><span class="lg-item"><span class="ev-badge observed sm">observed</span></span><span class="lg-item"><span class="ev-badge modeled sm">modeled</span></span></div>' +
      '</div>';
  }

  /* ================= Food War sim deck ================= */
  function simDeckHtml() {
    return '<div class="th-sim" data-testid="foodwar-deck">' +
      '<div class="section-title"><h3>' + icon('swords') + ' Food War simulation</h3><span class="meta">scenario-exploration · not a forecast</span></div>' +
      '<div class="sim-presets" id="simPresets"></div>' +
      '<div class="sim-params" id="simParams"></div>' +
      '<div class="sim-transport" id="simTransport"></div>' +
      '<div class="sim-kpis" id="simKpis" data-testid="sim-kpis"></div>' +
      '<div class="sim-lower"><div class="sim-interv" id="simInterv"></div><div class="sim-log" id="simLog" data-testid="sim-log"></div></div>' +
      '<div class="sim-modelcard" id="simModelCard"></div>' +
      '</div>';
  }
  function buildSimDeck() {
    var host = $('#simPresets');
    host.innerHTML = SIM.PRESETS.map(function (p) { return '<button class="sim-preset" data-p="' + p.id + '" data-testid="sim-preset-' + p.id + '"><b>' + esc(p.label) + '</b><span>' + esc(p.blurb) + '</span></button>'; }).join('');
    $$('.sim-preset', host).forEach(function (b) { on(b, 'click', function () { loadPreset(b.getAttribute('data-p')); }); });
    buildInterv();
    loadPreset(SIM.PRESETS[0].id, true);
  }
  function buildInterv() {
    var host = $('#simInterv');
    host.innerHTML = '<div class="fdim-h">Interventions <span class="fdim-or">baseline vs. overlay</span></div>' +
      SIM.INTERVENTIONS.map(function (iv) { return '<button class="fchip iv" data-iv="' + iv.id + '" data-testid="iv-' + iv.id + '">' + esc(iv.label) + '</button>'; }).join('');
    $$('.fchip.iv', host).forEach(function (b) { on(b, 'click', function () {
      var id = b.getAttribute('data-iv'); var arr = st.simParams.interventions || (st.simParams.interventions = []);
      var i = arr.indexOf(id); if (i === -1) arr.push(id); else arr.splice(i, 1);
      b.classList.toggle('active', arr.indexOf(id) !== -1); runScenario();
    }); });
  }
  function loadPreset(id, silent) {
    var p = SIM.PRESET_BY_ID[id]; if (!p) return;
    st.simParams = { preset: id, initiator: p.initiator, intensity: p.intensity, duration: p.duration, propagation: p.propagation, commodities: p.commodities.slice(), interventions: (st.simParams && st.simParams.interventions) || [] };
    $$('.sim-preset').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-p') === id); });
    buildParamControls(); runScenario();
    if (!silent) { var d = $('#simKpis'); if (d && d.scrollIntoView) d.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'nearest' }); }
  }
  function buildParamControls() {
    var p = st.simParams, host = $('#simParams');
    host.innerHTML =
      slider('intensity', 'Intensity', p.intensity, 1, 5) +
      slider('duration', 'Duration (days)', p.duration, 1, 180) +
      slider('propagation', 'Propagation speed', p.propagation, 1, 5);
    ['intensity', 'duration', 'propagation'].forEach(function (k) {
      var el = $('#sp-' + k, host); on(el, 'input', function () { p[k] = +el.value; var lab = $('#spv-' + k); if (lab) lab.textContent = el.value; runScenario(); });
    });
  }
  function slider(k, label, val, min, max) {
    return '<label class="sim-slab"><span>' + esc(label) + ' · <b id="spv-' + k + '">' + val + '</b></span>' +
      '<input type="range" id="sp-' + k + '" min="' + min + '" max="' + max + '" value="' + val + '" data-testid="sp-' + k + '"></label>';
  }
  function buildTransport() {
    var host = $('#simTransport');
    host.innerHTML =
      '<button class="mtool" id="simPlay" data-testid="sim-play" aria-label="Play/pause">▶</button>' +
      '<button class="mtool" id="simStepB" data-testid="sim-step-back" aria-label="Step back">⏴</button>' +
      '<button class="mtool" id="simStepF" data-testid="sim-step-fwd" aria-label="Step forward">⏵</button>' +
      '<button class="mtool" id="simRestart" data-testid="sim-restart" aria-label="Restart">⟲</button>' +
      '<input type="range" id="simScrub" min="0" max="180" value="0" data-testid="sim-scrub" aria-label="Timeline day">' +
      '<span class="sim-day" id="simDay" data-testid="sim-day">Day 0</span>' +
      '<select id="simSpeed" data-testid="sim-speed" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>' +
      '<button class="btn sm" id="simSaveBtn" data-testid="sim-save">' + icon('save') + ' Save scenario</button>';
    on($('#simPlay'), 'click', togglePlay);
    on($('#simStepB'), 'click', function () { setDay(st.day - 1); });
    on($('#simStepF'), 'click', function () { setDay(st.day + 1); });
    on($('#simRestart'), 'click', function () { pause(); setDay(0); });
    on($('#simScrub'), 'input', function () { pause(); setDay(+$('#simScrub').value); });
    on($('#simSpeed'), 'change', function () { st.speed = +$('#simSpeed').value; if (st.playing) { pause(); play(); } });
    on($('#simSaveBtn'), 'click', saveScenario);
  }
  function runScenario() {
    if (!st.simParams) return;
    st.sim = SIM.runSim(st.simParams);
    if (st.day > st.sim.horizon) st.day = st.sim.horizon;
    var scr = $('#simScrub'); if (scr) scr.max = st.sim.horizon;
    renderKpis(); renderLog(); renderModelCard();
    syncUrl();
    pushSnapshot();
  }
  function renderModelCard() { var h = $('#simModelCard'); if (h) h.innerHTML = icon('info') + ' <span>' + esc(st.sim.modelCard) + '</span>'; A.refreshIcons(); }
  function frame() { return st.sim ? st.sim.timeline[Math.max(0, Math.min(st.day, st.sim.horizon))] : null; }
  function baseFrame() { return st.sim ? st.sim.baseline[Math.max(0, Math.min(st.day, st.sim.horizon))] : null; }
  var KPI_DEFS = [
    { k: 'routeCapacity', label: 'Route capacity', suffix: '%', good: 'high' },
    { k: 'pricePressure', label: 'Price pressure', suffix: '', good: 'low' },
    { k: 'exposedPop', label: 'Exposed pop (M)', suffix: 'M', good: 'low' },
    { k: 'reserveBuffer', label: 'Reserve buffer (d)', suffix: 'd', good: 'high' },
    { k: 'humanitarianCaseload', label: 'Humanitarian (M)', suffix: 'M', good: 'low' },
    { k: 'affectedNodes', label: 'Affected nodes', suffix: '', good: 'low' },
    { k: 'confidence', label: 'Confidence', suffix: '%', good: 'high' },
  ];
  function renderKpis() {
    var host = $('#simKpis'); if (!host) return; var f = frame(), bf = baseFrame(); if (!f) return;
    host.innerHTML = KPI_DEFS.map(function (d) {
      var v = f[d.k], bv = bf[d.k], delta = Math.round((v - bv) * 10) / 10;
      var hasIv = st.simParams.interventions && st.simParams.interventions.length;
      var dcls = delta === 0 ? '' : ((d.good === 'high') === (delta > 0) ? 'pos' : 'neg');
      return '<div class="kpi-card" data-testid="kpi-' + d.k + '"><div class="kpi-l">' + esc(d.label) + '</div><div class="kpi-v">' + v + d.suffix + '</div>' +
        (hasIv ? '<div class="kpi-d ' + dcls + '">Δ vs base ' + (delta > 0 ? '+' : '') + delta + '</div>' : '') + '</div>';
    }).join('');
  }
  function renderLog() {
    var host = $('#simLog'); if (!host || !st.sim) return;
    host.innerHTML = '<div class="fdim-h">Cascade event log</div>' + st.sim.eventLog.map(function (e) {
      return '<div class="log-row ' + e.severity + (e.day <= st.day ? ' reached' : '') + '"><span class="log-day">D' + e.day + '</span><span class="log-dot ' + e.severity + '"></span>' + esc(e.text) + '</div>';
    }).join('');
  }
  function setDay(d) {
    if (!st.sim) return; st.day = Math.max(0, Math.min(st.sim.horizon, d));
    var scr = $('#simScrub'); if (scr) scr.value = st.day;
    var dl = $('#simDay'); if (dl) dl.textContent = 'Day ' + st.day;
    renderKpis(); highlightLog();
    var sr = $('#theaterSr'); if (sr) sr.textContent = 'Simulation day ' + st.day + '. Route capacity ' + frame().routeCapacity + '%.';
  }
  function highlightLog() { $$('#simLog .log-row').forEach(function (r) { var d = +(r.querySelector('.log-day').textContent.slice(1)); r.classList.toggle('reached', d <= st.day); }); }
  function play() { if (!st.sim) return; st.playing = true; var pb = $('#simPlay'); if (pb) pb.textContent = '❚❚'; var iv = Math.max(40, 160 / st.speed); simTimer = setInterval(function () { if (st.day >= st.sim.horizon) { pause(); return; } setDay(st.day + 2); }, iv); }
  function pause() { st.playing = false; var pb = $('#simPlay'); if (pb) pb.textContent = '▶'; if (simTimer) { clearInterval(simTimer); simTimer = null; } }
  function togglePlay() { if (st.playing) pause(); else { if (st.day >= st.sim.horizon) setDay(0); play(); } }

  /* snapshot bridge for Save Scenario via collab */
  function pushSnapshot() {
    if (!A.setSimSnapshot || !st.sim) return;
    var initNode = D.nodeById(st.simParams.initiator);
    A.setSimSnapshot({
      title: (SIM.PRESET_BY_ID[st.simParams.preset] ? SIM.PRESET_BY_ID[st.simParams.preset].label : 'Food War') + (initNode ? ' — ' + initNode.name : ''),
      threat: 'Food War: ' + (st.simParams.preset || 'custom'),
      pillar: 'Coordination Layer',
      params: Object.assign({ type: 'foodwar' }, st.simParams),
      result: { rating: st.sim.summary.minRouteCapacity + '% min capacity', summary: st.sim.summary, deltas: st.sim.deltas },
    });
  }
  function saveScenario() {
    pushSnapshot();
    if (window.AGRI_COLLAB && window.AGRI_COLLAB.saveScenario) window.AGRI_COLLAB.saveScenario();
    else flash('Sign in to save scenarios to your team.');
  }

  /* replay a saved foodwar scenario (called from app bridge) */
  function replay(params) {
    if (!params) return;
    st.simParams = { preset: params.preset || null, initiator: params.initiator || 'cp-turkish',
      intensity: +params.intensity || 4, duration: +params.duration || 120, propagation: +params.propagation || 3,
      commodities: params.commodities || ['wheat'], interventions: params.interventions || [] };
    if ($('#simParams')) { buildParamControls(); $$('.sim-preset').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-p') === st.simParams.preset); });
      $$('.fchip.iv').forEach(function (b) { b.classList.toggle('active', st.simParams.interventions.indexOf(b.getAttribute('data-iv')) !== -1); }); }
    runScenario(); setDay(0);
    var initNode = D.nodeById(st.simParams.initiator); if (initNode) flyTo(initNode.lat, initNode.lng, 1.8);
  }

  /* ================= ATOM action executor (allowlisted) ================= */
  function executeActions(validatedList) {
    (validatedList || []).forEach(function (v) {
      if (!v || !v.ok) return; var a = v.args;
      switch (v.type) {
        case 'select-layers': st.filter.layers = a.layers.slice(); refreshFilterUI(); break;
        case 'apply-filters': ['commodity', 'severity', 'layers'].forEach(function (k) { if (a[k] && a[k].length) st.filter[k] = a[k].slice(); }); if (a.region) st.filter.region = a.region; refreshFilterUI(); break;
        case 'fly-to': if (a.nodeId) { var n = D.nodeById(a.nodeId); if (n) { flyTo(n.lat, n.lng, 2); openNode(n); } } else flyTo(a.lat, a.lng, 2); break;
        case 'focus-chokepoint': case 'explain-dependency': var nd = D.nodeById(a.nodeId); if (nd) { flyTo(nd.lat, nd.lng, 2); openNode(nd); } break;
        case 'run-scenario': replay(a); break;
        case 'compare-intervention': st.simParams.interventions = a.interventions.slice(); if ($('#simInterv')) $$('.fchip.iv').forEach(function (b) { b.classList.toggle('active', a.interventions.indexOf(b.getAttribute('data-iv')) !== -1); }); runScenario(); break;
        case 'create-mission': if (window.AGRI_COLLAB && window.AGRI_COLLAB.openMissionComposer) window.AGRI_COLLAB.openMissionComposer({ title: a.title, objective: a.objective || '' }); break;
      }
    });
  }

  /* ================= mount / render ================= */
  function render(panel) {
    mounted = true;
    var canDraw = !!document.createElement('canvas').getContext;
    panel.innerHTML =
      '<div class="mode-head"><div class="eyebrow">Global Agricultural Intelligence Theater</div>' +
      '<h2>Food-trade <em>chokepoints</em>, routes &amp; exposure</h2>' +
      '<p class="lede">' + D.CHOKEPOINTS.length + ' Chatham House food-trade chokepoints, ' + D.BREADBASKETS.length + ' breadbaskets, ' + D.ROUTES.length + ' modeled routes. Filter, search, fly to a node, then run an explainable Food War simulation. Structural facts are sourced; simulation KPIs are modeled proxies.</p></div>' +
      '<div class="th-filters" id="theaterFilters"></div>' +
      '<div class="th-searchwrap" id="theaterSearchWrap"></div>' +
      (canDraw ?
        '<div class="th-stage"><div class="th-canvas-wrap"><canvas id="theaterCanvas" role="application" aria-label="Interactive agricultural trade globe"></canvas>' +
        '<div class="th-toolbar" id="theaterToolbar"></div><div class="th-tip" id="theaterTip" hidden></div></div>' +
        '<div class="th-side"><div class="th-results-h">Results</div><div class="th-results" id="theaterResults"></div></div></div>' +
        legendHtml()
        :
        '<div class="th-fallback" data-testid="theater-fallback"><p class="warn">Canvas unavailable — showing data table.</p><div id="theaterResults" class="th-results"></div></div>') +
      '<div id="theaterSr" class="sr-only" role="status" aria-live="polite"></div>' +
      '<div id="theaterStatus" class="th-status" role="status" aria-live="polite"></div>' +
      simDeckHtml();

    buildFilters($('#theaterFilters'));
    buildSearch($('#theaterSearchWrap'));
    if (canDraw) {
      canvas = $('#theaterCanvas'); ctx = canvas.getContext('2d');
      buildToolbar($('#theaterToolbar')); bindCanvas();
    }
    // sim deck
    // transport lives inside deck; build order: presets/interv then transport (needs KPI host)
    buildSimDeck();
    // insert transport controls right after params
    var deck = $('.th-sim'); var tr = $('#simTransport'); if (tr) buildTransport();
    refreshFilterUI();
    if (canDraw) { resize(); kick(); }
    on(window, 'resize', resize);
    A.refreshIcons();

    // apply any pending URL state captured at boot
    if (window.__THEATER_PENDING__) { applyState(window.__THEATER_PENDING__); window.__THEATER_PENDING__ = null; }
  }

  function applyState(state) {
    if (!state) return;
    ['layers', 'commodity', 'severity', 'category', 'evidence'].forEach(function (k) { if (state[k]) st.filter[k] = state[k].slice(); });
    if (state.region) st.filter.region = state.region;
    refreshFilterUI();
    if (state.sim && $('#simParams')) replay(state.sim);
    if (state.sel) { var n = D.nodeById(state.sel); if (n) { flyTo(n.lat, n.lng, 2); openNode(n); } }
  }

  function destroy() { mounted = false; pause(); if (raf) cancelAnimationFrame(raf); raf = null; if (exTimer) clearInterval(exTimer); offAll(); }

  /* Pause/resume the rAF loop on mode-leave/enter without tearing down state. */
  function setActive(active) {
    if (active) { if (!mounted) return; if (canvas) resize(); kick(); }
    else { if (raf) cancelAnimationFrame(raf); raf = null; }
  }

  window.THEATER = { render: render, applyState: applyState, executeActions: executeActions, replay: replay, destroy: destroy, setActive: setActive, getState: function () { return st; } };
})();
