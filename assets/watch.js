/* ============================================================
   AgriOS · Watch / Early-Warning operational surface (Phase IV)

   Enhancement layer over window.AGRI_APP. Renders the geofenced
   breadbasket early-warning engine: command summary, zone map,
   filters, click-to-drill explanation, compare, history sparkline,
   mission conversion, alert policies, an internal notification
   center, and owner-only external integration config.

   Every score/notification is EARLY-WARNING / SCENARIO intelligence,
   never deterministic prediction — provenance (observed / modeled /
   analyst) and freshness/confidence are shown, never fabricated.
   Fails soft: when the backend is unavailable the base app keeps
   running and this surface renders an honest error/empty state.
   ============================================================ */
(function () {
  'use strict';

  var A = window.AGRI_APP;
  if (!A) return;

  var esc = A.esc, icon = A.icon;
  var REDUCED = !!A.reduced;

  /* ---------------- state ---------------- */
  var session = null;
  var ROLE_RANK = { viewer: 1, analyst: 2, admin: 3, owner: 4 };
  function rankOf(r) { return ROLE_RANK[r] || 0; }
  function canAnalyst() { return session && rankOf(session.role) >= rankOf('analyst'); }
  function canOwner() { return session && rankOf(session.role) >= rankOf('owner'); }

  var state = {
    tab: 'zones',            // zones | policies | notifications | integrations
    zones: [],
    disclaimer: '',
    limits: null,
    summary: null,
    policies: [],
    bands: [],
    dimensions: [],
    notifications: [],
    unread: 0,
    channels: [],
    kinds: [],
    selected: null,          // selected zone id
    compare: [],             // up to 3 zone ids
    filters: { crop: '', threat: '', band: '', provenance: '', freshness: '' },
    loading: false,
    error: null,
    loaded: false,
  };

  var BANDS = ['calm', 'guarded', 'elevated', 'high', 'critical'];
  var BAND_RANK = { calm: 0, guarded: 1, elevated: 2, high: 3, critical: 4 };
  var BAND_COLOR = {
    calm: 'var(--muted)',
    guarded: 'var(--cyan,#3ca85a)',
    elevated: 'var(--sev-moderate,#c9a227)',
    high: 'var(--sev-high,#e08a1e)',
    critical: 'var(--sev-critical,#d43e28)',
  };
  var BAND_LABEL = { calm: 'Calm', guarded: 'Guarded', elevated: 'Elevated', high: 'High', critical: 'Critical' };

  var map = null, zoneLayer = null, panelEl = null;

  /* ---------------- utils ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }

  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  /* ---------------- fetch wrapper (mirrors collab.js) ---------------- */
  function api(path, opts) {
    opts = opts || {};
    var headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (session && session.csrfToken) headers['x-csrf-token'] = session.csrfToken;
    if (window.AGRIOS_AUTH && typeof window.AGRIOS_AUTH.authHeader === 'function') {
      var ah = window.AGRIOS_AUTH.authHeader();
      for (var hk in ah) { if (Object.prototype.hasOwnProperty.call(ah, hk)) headers[hk] = ah[hk]; }
    }
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { var e = new Error(j.message || 'Sign in to continue.'); e.authRequired = true; throw e; }
        if (!r.ok || j.ok === false) throw new Error(j.message || j.error || 'Request failed.');
        return j;
      });
    });
  }

  function accountSession() {
    var AA = window.AGRIOS_AUTH;
    if (!AA || typeof AA.isAuthed !== 'function' || !AA.isAuthed()) return null;
    var role = (typeof AA.getRole === 'function' && AA.getRole()) || 'operator';
    return { role: role === 'owner' ? 'owner' : 'analyst', account: true, csrfToken: null };
  }

  function resolveSession() {
    return api('/api/auth?action=session')
      .then(function (j) { session = j.authenticated ? j.session : (accountSession() || null); })
      .catch(function () { session = accountSession(); });
  }

  /* ---------------- styles ---------------- */
  var stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return; stylesInjected = true;
    var css = [
      '.watch-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}',
      '.watch-kpi{border:1px solid var(--border);border-radius:10px;padding:11px 13px;background:var(--surface,#1a160f)}',
      '.watch-kpi b{display:block;font:700 22px/1.1 var(--sans,system-ui);margin-bottom:2px}',
      '.watch-kpi span{font:500 11px/1.3 var(--mono,monospace);color:var(--muted);text-transform:uppercase;letter-spacing:.04em}',
      '.watch-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--border);padding-bottom:2px}',
      '.watch-tab{padding:7px 13px;border:1px solid transparent;border-radius:8px 8px 0 0;background:none;color:var(--muted);font:600 12.5px/1 var(--sans,system-ui);cursor:pointer}',
      '.watch-tab.active{color:var(--text);border-color:var(--border);border-bottom-color:transparent;background:var(--surface,#1a160f)}',
      '.watch-tab .cnt{margin-left:6px;font-size:10px;padding:1px 5px;border-radius:8px;border:1px solid var(--border)}',
      '.watch-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px}',
      '@media (max-width:900px){.watch-grid{grid-template-columns:1fr}}',
      '#watchMap{height:420px;border:1px solid var(--border);border-radius:11px;overflow:hidden}',
      '.watch-filters{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}',
      '.watch-filters select{background:var(--surface,#1a160f);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:5px 8px;font-size:12px}',
      '.watch-zone{border:1px solid var(--border);border-left-width:3px;border-radius:9px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:border-color .16s,transform .16s}',
      '.watch-zone:hover{border-color:var(--accent,#3ca85a)}',
      '.watch-zone.sel{border-color:var(--accent,#3ca85a);box-shadow:0 0 0 1px var(--accent,#3ca85a) inset}',
      '.watch-zone .zh{display:flex;justify-content:space-between;align-items:baseline;gap:8px}',
      '.watch-zone .zh b{font:600 13.5px/1.2 var(--sans,system-ui)}',
      '.watch-band{font:600 10px/1 var(--mono,monospace);text-transform:uppercase;letter-spacing:.04em;padding:3px 7px;border-radius:6px;border:1px solid currentColor;white-space:nowrap}',
      '.watch-score{font:700 15px/1 var(--mono,monospace)}',
      '.watch-dims{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}',
      '.watch-dim{flex:1;min-width:60px}',
      '.watch-dim .lab{font:500 9.5px/1.2 var(--mono,monospace);color:var(--muted);text-transform:uppercase}',
      '.watch-dim .bar{height:5px;border-radius:3px;background:var(--border);margin-top:2px;overflow:hidden}',
      '.watch-dim .bar i{display:block;height:100%;background:var(--sev-high,#e08a1e)}',
      '.watch-prov{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}',
      '.watch-tag{font:600 9.5px/1 var(--mono,monospace);text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--muted)}',
      '.watch-tag.observed{border-color:var(--cyan,#3ca85a);color:var(--cyan,#3ca85a)}',
      '.watch-tag.modeled{border-color:var(--sev-high,#e08a1e);color:var(--sev-high,#e08a1e)}',
      '.watch-tag.stale{border-color:var(--sev-critical,#d43e28);color:var(--sev-critical,#d43e28)}',
      '.watch-drill{border:1px solid var(--border);border-radius:11px;padding:14px;background:var(--surface,#1a160f)}',
      '.watch-drill h4{font:600 14px/1.2 var(--sans,system-ui);margin:0 0 4px}',
      '.watch-note{font-size:12px;color:var(--text-dim,#b7ad99);line-height:1.5}',
      '.watch-assump{margin:8px 0 0;padding-left:16px}.watch-assump li{font-size:12px;margin:2px 0;color:var(--text-dim,#b7ad99)}',
      '.watch-spark{margin-top:10px}',
      '.watch-ev{margin:8px 0 0;padding-left:16px}.watch-ev li{font-size:12px;margin:2px 0}',
      '.watch-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}',
      '.watch-btn{padding:6px 11px;border:1px solid var(--border);border-radius:7px;background:none;color:var(--text);font:600 12px/1 var(--sans,system-ui);cursor:pointer}',
      '.watch-btn.primary{border-color:var(--accent,#3ca85a);color:var(--accent,#3ca85a)}',
      '.watch-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.watch-notif{border:1px solid var(--border);border-left-width:3px;border-radius:9px;padding:10px 12px;margin-bottom:8px}',
      '.watch-notif.unread{background:var(--surface,#1a160f)}',
      '.watch-notif .nh{display:flex;justify-content:space-between;gap:8px}',
      '.watch-notif b{font:600 13px/1.3 var(--sans,system-ui)}',
      '.watch-empty{border:1px dashed var(--border);border-radius:11px;padding:26px;text-align:center;color:var(--muted);font-size:13px}',
      '.watch-err{border:1px solid var(--sev-critical,#d43e28);border-radius:11px;padding:16px;color:var(--sev-critical,#d43e28);font-size:13px}',
      '.watch-field{display:block;margin-bottom:9px}.watch-field span{display:block;font:500 11px/1.3 var(--mono,monospace);color:var(--muted);margin-bottom:3px;text-transform:uppercase}',
      '.watch-field input,.watch-field select,.watch-field textarea{width:100%;box-sizing:border-box;background:var(--surface,#1a160f);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:7px 9px;font-size:13px}',
      '.watch-disclaimer{font-size:11px;color:var(--muted);font-style:italic;margin:6px 0 12px}',
      '.watch-health{font:600 10px/1 var(--mono,monospace);text-transform:uppercase;padding:2px 6px;border-radius:5px;border:1px solid var(--border);color:var(--muted)}',
      '.watch-health.ready{border-color:var(--cyan,#3ca85a);color:var(--cyan,#3ca85a)}',
      '.watch-health.error{border-color:var(--sev-critical,#d43e28);color:var(--sev-critical,#d43e28)}',
    ].join('');
    try { var st = document.createElement('style'); st.id = 'watch-style'; st.textContent = css; (document.head || document.body).appendChild(st); } catch (_) {}
  }

  /* ---------------- data loaders ---------------- */
  function loadZones() {
    return api('/api/geofences?action=list').then(function (j) {
      state.zones = j.zones || []; state.disclaimer = j.disclaimer || ''; state.limits = j.limits || null;
    });
  }
  function loadSummary() {
    return api('/api/notifications?action=summary').then(function (j) { state.summary = j; })
      .catch(function () { state.summary = null; });
  }
  function loadPolicies() {
    return api('/api/policies?action=list').then(function (j) {
      state.policies = j.policies || []; state.bands = j.bands || BANDS; state.dimensions = j.dimensions || [];
    }).catch(function () { state.policies = []; });
  }
  function loadNotifications() {
    return api('/api/notifications?action=list').then(function (j) {
      state.notifications = j.notifications || []; state.unread = j.unread || 0;
    }).catch(function () { state.notifications = []; state.unread = 0; });
  }
  function loadChannels() {
    return api('/api/integrations?action=list').then(function (j) {
      state.channels = j.channels || []; state.kinds = j.kinds || [];
    }).catch(function () { state.channels = []; });
  }

  function loadAll() {
    state.loading = true; state.error = null; paint();
    return Promise.all([loadZones(), loadSummary(), loadPolicies(), loadNotifications(), loadChannels()])
      .then(function () { state.loading = false; state.loaded = true; paint(); })
      .catch(function (err) {
        state.loading = false; state.loaded = true;
        state.error = err && err.authRequired ? 'auth' : (err && err.message) || 'load_failed';
        paint();
      });
  }

  /* ---------------- filtering ---------------- */
  function filteredZones() {
    var f = state.filters;
    return state.zones.filter(function (z) {
      if (f.crop && (z.crops || []).indexOf(f.crop) === -1) return false;
      if (f.threat && (z.threats || []).indexOf(f.threat) === -1) return false;
      if (f.band && z.band !== f.band) return false;
      if (f.freshness === 'stale' && !z.stale) return false;
      if (f.freshness === 'fresh' && z.stale) return false;
      if (f.provenance === 'scored' && z.score == null) return false;
      if (f.provenance === 'unscored' && z.score != null) return false;
      return true;
    });
  }

  function cropOptions() {
    var set = {}; state.zones.forEach(function (z) { (z.crops || []).forEach(function (c) { set[c] = 1; }); });
    return Object.keys(set).sort();
  }
  function threatOptions() {
    var set = {}; state.zones.forEach(function (z) { (z.threats || []).forEach(function (t) { set[t] = 1; }); });
    return Object.keys(set).sort();
  }

  /* ---------------- map ---------------- */
  function toLatLng(lonlat) { return [lonlat[1], lonlat[0]]; }

  function initMap() {
    if (map || !window.L || !$('#watchMap')) return;
    map = L.map('watchMap', { scrollWheelZoom: false, worldCopyJump: true, minZoom: 1, maxZoom: 7, attributionControl: true }).setView([25, 20], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 8,
    }).addTo(map);
    zoneLayer = L.layerGroup().addTo(map);
    setTimeout(function () { if (map) map.invalidateSize(); }, 120);
    drawZones();
  }

  function drawZones() {
    if (!map || !zoneLayer) return;
    zoneLayer.clearLayers();
    filteredZones().forEach(function (z) {
      var color = BAND_COLOR[z.band] || BAND_COLOR.calm;
      var sel = state.selected === z.id;
      var g = z.geometry || {};
      var shape = null;
      try {
        if (g.type === 'bbox' && Array.isArray(g.bbox)) {
          shape = L.rectangle([[g.bbox[1], g.bbox[0]], [g.bbox[3], g.bbox[2]]],
            { color: color, weight: sel ? 3 : 1.5, fillOpacity: sel ? 0.28 : 0.14 });
        } else if (g.type === 'point' && Array.isArray(g.center)) {
          shape = L.circle(toLatLng(g.center), { radius: (Number(g.radiusKm) || 50) * 1000, color: color, weight: sel ? 3 : 1.5, fillOpacity: sel ? 0.3 : 0.16 });
        } else if (g.type === 'polygon' && Array.isArray(g.coordinates)) {
          shape = L.polygon(g.coordinates.map(toLatLng), { color: color, weight: sel ? 3 : 1.5, fillOpacity: sel ? 0.28 : 0.14 });
        }
      } catch (_) { shape = null; }
      if (!shape) return;
      shape.on('click', function () { selectZone(z.id); });
      var scoreTxt = z.score == null ? 'unscored' : (z.score + '/100 · ' + (BAND_LABEL[z.band] || z.band));
      shape.bindTooltip(esc(z.name) + ' — ' + scoreTxt, { sticky: true });
      zoneLayer.addLayer(shape);
    });
  }

  function focusZone(z) {
    if (!map || !z || !z.geometry) return;
    var g = z.geometry;
    try {
      if (g.type === 'bbox') map.fitBounds([[g.bbox[1], g.bbox[0]], [g.bbox[3], g.bbox[2]]], { maxZoom: 5, padding: [30, 30] });
      else if (g.type === 'point') map.setView(toLatLng(g.center), 5);
      else if (g.type === 'polygon') map.fitBounds(g.coordinates.map(toLatLng), { maxZoom: 5, padding: [30, 30] });
    } catch (_) {}
  }

  /* ---------------- selection + drill ---------------- */
  function zoneById(id) { for (var i = 0; i < state.zones.length; i++) if (state.zones[i].id === id) return state.zones[i]; return null; }

  function selectZone(id) {
    state.selected = id;
    drawZones();
    var z = zoneById(id);
    if (z) focusZone(z);
    paintDrill();
    $all('.watch-zone').forEach(function (n) { n.classList.toggle('sel', n.dataset.id === id); });
  }

  function toggleCompare(id) {
    var i = state.compare.indexOf(id);
    if (i >= 0) state.compare.splice(i, 1);
    else { if (state.compare.length >= 3) { A.refreshIcons && A.refreshIcons(); return; } state.compare.push(id); }
    paintDrill();
  }

  function sparkline(history) {
    if (!history || history.length < 2) return '<p class="watch-note">Not enough snapshots yet for a trend line. Run evaluations over time to build history.</p>';
    var pts = history.slice().reverse(); // oldest -> newest
    var w = 240, h = 46, max = 100;
    var step = w / (pts.length - 1);
    var d = pts.map(function (p, i) { var y = h - (Math.max(0, Math.min(100, p.score || 0)) / max) * h; return (i === 0 ? 'M' : 'L') + (i * step).toFixed(1) + ',' + y.toFixed(1); }).join(' ');
    return '<svg class="watch-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Watch score history">' +
      '<path d="' + d + '" fill="none" stroke="var(--sev-high,#e08a1e)" stroke-width="2"/></svg>';
  }

  function dimBars(dims) {
    if (!dims) return '';
    var order = ['crop_weather', 'conflict_security', 'logistics_chokepoint', 'market_supply', 'freshness_confidence'];
    var lab = { crop_weather: 'Crop/Wx', conflict_security: 'Conflict', logistics_chokepoint: 'Logistics', market_supply: 'Market', freshness_confidence: 'Freshness' };
    return '<div class="watch-dims">' + order.filter(function (k) { return dims[k] != null; }).map(function (k) {
      var v = Math.max(0, Math.min(100, Math.round(dims[k])));
      return '<div class="watch-dim"><div class="lab">' + lab[k] + '</div><div class="bar"><i style="width:' + v + '%"></i></div></div>';
    }).join('') + '</div>';
  }

  function provTags(z) {
    var t = [];
    if (z.score != null) t.push('<span class="watch-tag observed" title="Derived from ingested live signals">Observed</span>');
    t.push('<span class="watch-tag modeled">Modeled/scenario</span>');
    if (z.stale) t.push('<span class="watch-tag stale">Stale data</span>');
    return '<div class="watch-prov">' + t.join('') + '</div>';
  }

  function paintDrill() {
    var host = $('#watchDrill'); if (!host) return;
    // compare view takes precedence when 2+ selected
    if (state.compare.length >= 2) { renderCompare(host); return; }
    var z = state.selected ? zoneById(state.selected) : null;
    if (!z) {
      host.innerHTML = '<div class="watch-drill" data-testid="watch-drill-empty"><h4>' + icon('mouse-pointer-click') + ' Select a zone</h4>' +
        '<p class="watch-note">Click a zone on the map or in the list to see its exposure breakdown, provenance, assumptions, evidence, and score history. This is early-warning scenario intelligence — not a deterministic forecast.</p></div>';
      A.refreshIcons && A.refreshIcons(); return;
    }
    var color = BAND_COLOR[z.band] || BAND_COLOR.calm;
    var inCmp = state.compare.indexOf(z.id) >= 0;
    host.innerHTML =
      '<div class="watch-drill" data-testid="watch-drill">' +
      '<div class="zh" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">' +
        '<h4>' + icon('shield-alert') + ' ' + esc(z.name) + '</h4>' +
        (z.score == null ? '<span class="watch-tag">Unscored</span>' :
          '<span><span class="watch-score" style="color:' + color + '">' + z.score + '</span> <span class="watch-band" style="color:' + color + '">' + (BAND_LABEL[z.band] || z.band) + '</span></span>') +
      '</div>' +
      '<div class="watch-note">' + esc(z.region || z.kind || '') + (z.trend ? ' · trend: ' + esc(z.trend) + (z.delta != null ? ' (' + (z.delta >= 0 ? '+' : '') + z.delta + ')' : '') : '') + '</div>' +
      provTags(z) +
      dimBars(z.dimensions) +
      (z.confidence != null ? '<p class="watch-note" style="margin-top:8px">Confidence: <b>' + Math.round(z.confidence * 100) + '%</b>' + (z.freshness_hours != null ? ' · freshest input ' + Math.round(z.freshness_hours) + 'h old' : '') + '</p>' : '') +
      '<div id="watchDrillDetail"><p class="watch-note">Loading explanation…</p></div>' +
      '<div class="watch-row">' +
        '<button class="watch-btn" data-act="compare" data-testid="watch-compare-btn">' + icon('git-compare') + ' ' + (inCmp ? 'In compare' : 'Add to compare') + '</button>' +
        (canAnalyst() ? '<button class="watch-btn primary" data-act="snapshot" data-testid="watch-snapshot-btn">' + icon('activity') + ' Re-score zone</button>' : '') +
      '</div>' +
      '</div>';
    host.querySelector('[data-act="compare"]').addEventListener('click', function () { toggleCompare(z.id); });
    var snap = host.querySelector('[data-act="snapshot"]');
    if (snap) snap.addEventListener('click', function () { snapshotZone(z.id, snap); });
    A.refreshIcons && A.refreshIcons();
    loadDrillDetail(z.id);
  }

  function loadDrillDetail(id) {
    api('/api/geofences?action=get&id=' + encodeURIComponent(id)).then(function (j) {
      var det = $('#watchDrillDetail'); if (!det || state.selected !== id) return;
      var latest = j.latest, history = j.history || [];
      var html = '';
      if (latest) {
        var ev = (latest.evidence || []).slice(0, 6);
        var assum = (latest.assumptions || []).slice(0, 6);
        if (latest.explanation) html += '<p class="watch-note" style="margin-top:8px">' + esc(latest.explanation) + '</p>';
        if (ev.length) html += '<h5 class="watch-note" style="margin:8px 0 2px;font-weight:600">Evidence</h5><ul class="watch-ev">' + ev.map(function (e) {
          var label = typeof e === 'string' ? e : (e.label || e.title || e.note || JSON.stringify(e));
          return '<li>' + esc(label) + '</li>';
        }).join('') + '</ul>';
        if (assum.length) html += '<h5 class="watch-note" style="margin:8px 0 2px;font-weight:600">Assumptions</h5><ul class="watch-assump">' + assum.map(function (a) {
          return '<li>' + esc(typeof a === 'string' ? a : (a.note || JSON.stringify(a))) + '</li>';
        }).join('') + '</ul>';
      } else {
        html += '<p class="watch-note" style="margin-top:8px">No snapshot yet — run an evaluation or re-score to generate one.</p>';
      }
      html += '<h5 class="watch-note" style="margin:10px 0 2px;font-weight:600">Score history</h5>' + sparkline(history);
      det.innerHTML = html;
    }).catch(function () {
      var det = $('#watchDrillDetail'); if (det && state.selected === id) det.innerHTML = '<p class="watch-note">Detail unavailable.</p>';
    });
  }

  function renderCompare(host) {
    var ids = state.compare.slice(0, 3);
    api('/api/geofences?action=compare&ids=' + ids.map(encodeURIComponent).join(',')).then(function (j) {
      if (state.compare.length < 2) { paintDrill(); return; }
      var zs = j.zones || [];
      host.innerHTML = '<div class="watch-drill" data-testid="watch-compare">' +
        '<div class="zh" style="display:flex;justify-content:space-between;align-items:center"><h4>' + icon('git-compare') + ' Compare zones</h4>' +
        '<button class="watch-btn" data-act="clear">Clear</button></div>' +
        '<div style="display:grid;grid-template-columns:repeat(' + zs.length + ',1fr);gap:10px;margin-top:10px">' +
        zs.map(function (z) {
          var color = BAND_COLOR[z.band] || BAND_COLOR.calm;
          return '<div style="border:1px solid var(--border);border-radius:9px;padding:10px">' +
            '<b style="font-size:13px">' + esc(z.name) + '</b>' +
            '<div style="margin:6px 0"><span class="watch-score" style="color:' + color + '">' + (z.score == null ? '—' : z.score) + '</span> <span class="watch-band" style="color:' + color + '">' + (BAND_LABEL[z.band] || z.band || '—') + '</span></div>' +
            dimBars(z.dimensions) +
            '<p class="watch-note" style="margin-top:6px">' + esc(z.region || '') + (z.trend ? ' · ' + esc(z.trend) : '') + '</p>' +
            '</div>';
        }).join('') + '</div></div>';
      host.querySelector('[data-act="clear"]').addEventListener('click', function () { state.compare = []; paintDrill(); });
      A.refreshIcons && A.refreshIcons();
    }).catch(function () { host.innerHTML = '<div class="watch-err">Compare unavailable.</div>'; });
  }

  function snapshotZone(id, btn) {
    if (btn) btn.disabled = true;
    api('/api/geofences?action=snapshot', { method: 'POST', body: { id: id } })
      .then(function () { return loadZones(); })
      .then(function () { drawZones(); paintDrill(); paintZoneList(); })
      .catch(function () {})
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ---------------- evaluation ---------------- */
  function runEvaluation(btn) {
    if (btn) btn.disabled = true;
    api('/api/notifications?action=evaluate', { method: 'POST', body: {} })
      .then(function (j) {
        state.notifications = j.notifications || state.notifications;
        state.unread = j.unread != null ? j.unread : state.unread;
        return Promise.all([loadZones(), loadSummary()]);
      })
      .then(function () { drawZones(); paint(); })
      .catch(function () {})
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ---------------- notifications ---------------- */
  function notifAction(action, id) {
    return api('/api/notifications?action=' + action, { method: 'POST', body: { id: id } })
      .then(function (j) {
        if (j.notifications) { state.notifications = j.notifications; state.unread = j.unread || 0; }
        paint();
      }).catch(function () {});
  }
  function convertMission(id, btn) {
    if (btn) btn.disabled = true;
    api('/api/notifications?action=convert-mission', { method: 'POST', body: { id: id } })
      .then(function () { return loadNotifications(); })
      .then(function () { paint(); })
      .catch(function () {})
      .then(function () { if (btn) btn.disabled = false; });
  }

  /* ============================================================
     RENDER
     ============================================================ */
  function paint() {
    if (!panelEl) return;
    if (state.error === 'auth') {
      panelEl.innerHTML = '<div class="watch-empty" data-testid="watch-auth">' + icon('lock') + '<p>Sign in to view the early-warning watch.</p></div>';
      A.refreshIcons && A.refreshIcons(); return;
    }
    if (state.loading && !state.loaded) {
      panelEl.innerHTML = '<div class="watch-empty" data-testid="watch-loading">' + icon('loader') + ' Loading watch engine…</div>';
      A.refreshIcons && A.refreshIcons(); return;
    }
    if (state.error) {
      panelEl.innerHTML = '<div class="watch-err" data-testid="watch-error">' + icon('alert-triangle') + ' The watch engine is unavailable right now. ' + esc(String(state.error)) + '<div class="watch-row"><button class="watch-btn" id="watchRetry">Retry</button></div></div>';
      var rb = $('#watchRetry'); if (rb) rb.addEventListener('click', loadAll);
      A.refreshIcons && A.refreshIcons(); return;
    }

    panelEl.innerHTML =
      summaryBar() +
      tabsBar() +
      '<div id="watchTabBody"></div>';
    bindTabs();
    paintTab();
    A.refreshIcons && A.refreshIcons();
  }

  function summaryBar() {
    var s = state.summary; var c = (s && s.counts) || {};
    var kpi = function (v, l, tid) { return '<div class="watch-kpi" data-testid="' + tid + '"><b>' + (v == null ? '—' : v) + '</b><span>' + l + '</span></div>'; };
    var actions = (s && s.nextActions) || [];
    return '<div class="watch-summary">' +
      kpi(c.zones, 'Zones', 'kpi-zones') +
      kpi(c.underWatch, 'Under watch', 'kpi-watch') +
      kpi(c.rising, 'Rising', 'kpi-rising') +
      kpi(c.stale, 'Stale feeds', 'kpi-stale') +
      kpi(state.unread, 'Unread alerts', 'kpi-unread') +
      '</div>' +
      (actions.length ? '<div class="watch-note" data-testid="watch-next" style="margin:-4px 0 12px"><b>Next:</b> ' + esc(actions[0]) + '</div>' : '') +
      '<div class="watch-row" style="margin:-4px 0 14px">' +
        (canAnalyst() ? '<button class="watch-btn primary" id="watchEval" data-testid="watch-evaluate">' + icon('play') + ' Run evaluation</button>' : '') +
        (canAnalyst() && !state.zones.length ? '<button class="watch-btn" id="watchSeed" data-testid="watch-seed">' + icon('sprout') + ' Seed starter catalog</button>' : '') +
      '</div>';
  }

  function tabsBar() {
    var t = function (id, label, cnt) {
      return '<button class="watch-tab' + (state.tab === id ? ' active' : '') + '" data-tab="' + id + '" data-testid="watch-tab-' + id + '">' + esc(label) + (cnt != null ? '<span class="cnt">' + cnt + '</span>' : '') + '</button>';
    };
    return '<div class="watch-tabs" role="tablist">' +
      t('zones', 'Zones', state.zones.length) +
      t('notifications', 'Notifications', state.unread || null) +
      t('policies', 'Policies', state.policies.length) +
      t('integrations', 'Integrations', state.channels.length) +
      '</div>';
  }

  function bindTabs() {
    $all('.watch-tab', panelEl).forEach(function (b) {
      b.addEventListener('click', function () { state.tab = b.dataset.tab; paint(); });
    });
    var ev = $('#watchEval'); if (ev) ev.addEventListener('click', function () { runEvaluation(ev); });
    var seed = $('#watchSeed'); if (seed) seed.addEventListener('click', function () {
      seed.disabled = true;
      api('/api/geofences?action=seed-catalog', { method: 'POST', body: {} })
        .then(loadAll).catch(function () { seed.disabled = false; });
    });
  }

  function paintTab() {
    var body = $('#watchTabBody'); if (!body) return;
    if (state.tab === 'zones') return paintZonesTab(body);
    if (state.tab === 'notifications') return paintNotificationsTab(body);
    if (state.tab === 'policies') return paintPoliciesTab(body);
    if (state.tab === 'integrations') return paintIntegrationsTab(body);
  }

  /* ---- Zones tab ---- */
  function paintZonesTab(body) {
    if (!state.zones.length) {
      body.innerHTML = '<div class="watch-empty" data-testid="watch-zones-empty">' + icon('map') +
        '<p>No zones yet.' + (canAnalyst() ? ' Seed the product-defined starter catalog above to begin monitoring major breadbaskets and chokepoints.' : ' An analyst can seed the starter catalog.') + '</p></div>';
      A.refreshIcons && A.refreshIcons(); return;
    }
    body.innerHTML =
      '<p class="watch-disclaimer" data-testid="watch-disclaimer">' + esc(state.disclaimer || 'Zones are product-defined monitoring areas, not official government boundaries.') + '</p>' +
      filterBar() +
      '<div class="watch-grid">' +
        '<div><div id="watchMap" data-testid="watch-map"></div></div>' +
        '<div id="watchDrill"></div>' +
      '</div>' +
      '<div id="watchZoneList" style="margin-top:14px"></div>';
    bindFilters();
    initMap();
    paintDrill();
    paintZoneList();
    A.refreshIcons && A.refreshIcons();
  }

  function filterBar() {
    var opt = function (v, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'; };
    var f = state.filters;
    return '<div class="watch-filters" data-testid="watch-filters">' +
      '<select data-f="crop" aria-label="Filter by crop"><option value="">All crops</option>' + cropOptions().map(function (c) { return opt(c, f.crop); }).join('') + '</select>' +
      '<select data-f="threat" aria-label="Filter by threat"><option value="">All threats</option>' + threatOptions().map(function (t) { return opt(t, f.threat); }).join('') + '</select>' +
      '<select data-f="band" aria-label="Filter by severity band"><option value="">All bands</option>' + BANDS.map(function (b) { return '<option value="' + b + '"' + (b === f.band ? ' selected' : '') + '>' + BAND_LABEL[b] + '</option>'; }).join('') + '</select>' +
      '<select data-f="provenance" aria-label="Filter by scored state"><option value="">Scored + unscored</option><option value="scored"' + (f.provenance === 'scored' ? ' selected' : '') + '>Scored only</option><option value="unscored"' + (f.provenance === 'unscored' ? ' selected' : '') + '>Unscored only</option></select>' +
      '<select data-f="freshness" aria-label="Filter by freshness"><option value="">Any freshness</option><option value="fresh"' + (f.freshness === 'fresh' ? ' selected' : '') + '>Fresh</option><option value="stale"' + (f.freshness === 'stale' ? ' selected' : '') + '>Stale</option></select>' +
      '</div>';
  }

  function bindFilters() {
    $all('.watch-filters select', panelEl).forEach(function (sel) {
      sel.addEventListener('change', function () {
        state.filters[sel.dataset.f] = sel.value;
        drawZones(); paintZoneList();
      });
    });
  }

  function paintZoneList() {
    var host = $('#watchZoneList'); if (!host) return;
    var zs = filteredZones();
    if (!zs.length) { host.innerHTML = '<div class="watch-empty">No zones match the current filters.</div>'; return; }
    host.innerHTML = zs.map(function (z) {
      var color = BAND_COLOR[z.band] || BAND_COLOR.calm;
      return '<div class="watch-zone' + (state.selected === z.id ? ' sel' : '') + '" data-id="' + z.id + '" data-testid="watch-zone" style="border-left-color:' + color + '">' +
        '<div class="zh"><b>' + esc(z.name) + '</b>' +
          (z.score == null ? '<span class="watch-tag">Unscored</span>' :
            '<span><span class="watch-score" style="color:' + color + '">' + z.score + '</span> <span class="watch-band" style="color:' + color + '">' + (BAND_LABEL[z.band] || z.band) + '</span></span>') +
        '</div>' +
        '<div class="watch-note">' + esc(z.region || z.kind || '') + '</div>' +
        provTags(z) +
        '</div>';
    }).join('');
    $all('.watch-zone', host).forEach(function (n) { n.addEventListener('click', function () { selectZone(n.dataset.id); }); });
    A.refreshIcons && A.refreshIcons();
  }

  /* ---- Notifications tab ---- */
  function paintNotificationsTab(body) {
    if (!state.notifications.length) {
      body.innerHTML = '<div class="watch-empty" data-testid="watch-notif-empty">' + icon('bell') +
        '<p>No notifications. Run an evaluation to score zones and match your alert policies.</p></div>';
      A.refreshIcons && A.refreshIcons(); return;
    }
    body.innerHTML = state.notifications.map(function (n) {
      var color = BAND_COLOR[n.band] || BAND_COLOR.calm;
      var st = n.state || 'unread';
      var deliv = n.delivery_state || 'skipped';
      return '<div class="watch-notif ' + (st === 'unread' ? 'unread' : '') + '" data-testid="watch-notif" style="border-left-color:' + color + '">' +
        '<div class="nh"><b>' + esc(n.title || '') + '</b><span class="watch-band" style="color:' + color + '">' + (BAND_LABEL[n.band] || n.band || '') + '</span></div>' +
        '<div class="watch-note">' + esc(n.body || '') + '</div>' +
        '<div class="watch-note" style="margin-top:4px">' + esc(n.zone_name || '') + ' · ' + fmtWhen(n.created_at) + ' · state: ' + esc(st) + ' · delivery: ' + esc(deliv) +
          (n.delivery_attempts ? ' (' + n.delivery_attempts + ' attempt' + (n.delivery_attempts === 1 ? '' : 's') + ')' : '') +
          (n.mission_id ? ' · linked to mission' : '') + '</div>' +
        '<div class="watch-row">' +
          (st === 'unread' ? '<button class="watch-btn" data-act="read" data-id="' + n.id + '">Mark read</button>' : '<button class="watch-btn" data-act="unread" data-id="' + n.id + '">Mark unread</button>') +
          (st !== 'acknowledged' ? '<button class="watch-btn" data-act="acknowledge" data-id="' + n.id + '" data-testid="watch-ack">Acknowledge</button>' : '<span class="watch-tag observed">Acknowledged</span>') +
          (canAnalyst() && !n.mission_id ? '<button class="watch-btn primary" data-act="convert" data-id="' + n.id + '" data-testid="watch-convert">' + icon('crosshair') + ' Convert to mission</button>' : '') +
        '</div>' +
        '</div>';
    }).join('');
    $all('[data-act]', body).forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.id, act = b.dataset.act;
        if (act === 'convert') return convertMission(id, b);
        return notifAction(act, id);
      });
    });
    A.refreshIcons && A.refreshIcons();
  }

  /* ---- Policies tab ---- */
  function paintPoliciesTab(body) {
    var canW = canAnalyst();
    var list = state.policies.length ? state.policies.map(function (p) {
      return '<div class="watch-notif" data-testid="watch-policy" style="border-left-color:' + (BAND_COLOR[p.min_band] || BAND_COLOR.calm) + '">' +
        '<div class="nh"><b>' + esc(p.name) + '</b><span class="watch-tag' + (p.enabled ? ' observed' : '') + '">' + (p.enabled ? 'Enabled' : 'Disabled') + '</span></div>' +
        '<div class="watch-note">Min band: ' + esc(BAND_LABEL[p.min_band] || p.min_band) + ' · zones: ' + ((p.geofence_ids && p.geofence_ids.length) || 'all') +
          ' · cooldown: ' + (p.cooldown_minutes || 0) + 'm · repeat: ' + (p.repeat ? 'yes' : 'no') +
          (p.escalation_target ? ' · escalation: ' + esc(p.escalation_target) : '') + '</div>' +
        (canW ? '<div class="watch-row">' +
          '<button class="watch-btn" data-act="toggle" data-id="' + p.id + '" data-en="' + (p.enabled ? '0' : '1') + '">' + (p.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="watch-btn" data-act="delete" data-id="' + p.id + '">Delete</button>' +
        '</div>' : '') +
        '</div>';
    }).join('') : '<div class="watch-empty">No alert policies yet.' + (canW ? ' Create one below.' : '') + '</div>';

    body.innerHTML = list + (canW ? policyForm() : '');
    if (canW) {
      $all('[data-act]', body).forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.dataset.id;
          if (b.dataset.act === 'toggle') {
            api('/api/policies?action=toggle', { method: 'POST', body: { id: id, enabled: b.dataset.en === '1' } }).then(loadPolicies).then(paint).catch(function () {});
          } else if (b.dataset.act === 'delete') {
            api('/api/policies?action=delete', { method: 'POST', body: { id: id } }).then(loadPolicies).then(paint).catch(function () {});
          }
        });
      });
      var frm = $('#watchPolicyForm', body);
      if (frm) frm.addEventListener('submit', function (e) {
        e.preventDefault();
        var body2 = {
          name: $('#pName').value,
          minBand: $('#pBand').value,
          cooldownMinutes: Number($('#pCooldown').value) || 360,
          repeat: $('#pRepeat').checked,
          escalationTarget: $('#pEsc').value || null,
          enabled: true,
        };
        var sb = frm.querySelector('button[type="submit"]'); sb.disabled = true;
        api('/api/policies?action=save', { method: 'POST', body: body2 })
          .then(loadPolicies).then(paint).catch(function () { sb.disabled = false; });
      });
    }
    A.refreshIcons && A.refreshIcons();
  }

  function policyForm() {
    return '<form id="watchPolicyForm" data-testid="watch-policy-form" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">' +
      '<h4 style="font:600 13px/1.2 var(--sans,system-ui);margin:0 0 10px">New alert policy</h4>' +
      '<label class="watch-field"><span>Name</span><input id="pName" required minlength="2" maxlength="120" placeholder="e.g. Black Sea escalation"></label>' +
      '<label class="watch-field"><span>Minimum band</span><select id="pBand">' + BANDS.map(function (b) { return '<option value="' + b + '"' + (b === 'elevated' ? ' selected' : '') + '>' + BAND_LABEL[b] + '</option>'; }).join('') + '</select></label>' +
      '<label class="watch-field"><span>Cooldown (minutes)</span><input id="pCooldown" type="number" min="0" max="10080" value="360"></label>' +
      '<label class="watch-field"><span>Escalation target (optional label)</span><input id="pEsc" maxlength="200" placeholder="channel name / note"></label>' +
      '<label class="watch-field" style="display:flex;align-items:center;gap:8px"><input id="pRepeat" type="checkbox" style="width:auto"><span style="margin:0">Repeat after cooldown</span></label>' +
      '<button class="watch-btn primary" type="submit">' + icon('plus') + ' Create policy</button>' +
      '</form>';
  }

  /* ---- Integrations tab ---- */
  function paintIntegrationsTab(body) {
    var owner = canOwner();
    var list = state.channels.length ? state.channels.map(function (c) {
      var health = (c.health && c.health.status) || c.status || 'unknown';
      var hc = health === 'ready' ? 'ready' : (health === 'error' || health === 'not_configured' ? 'error' : '');
      return '<div class="watch-notif" data-testid="watch-channel">' +
        '<div class="nh"><b>' + esc(c.name) + ' <span class="watch-tag">' + esc(c.kind) + '</span></b><span class="watch-health ' + hc + '">' + esc(c.status || health) + '</span></div>' +
        '<div class="watch-note">' + (c.configured ? 'Configured' : 'Not configured') + (owner && c.secretRef ? ' · env: ' + esc(c.secretRef) : '') +
          (c.health && c.health.last_test_at ? ' · last test ' + fmtWhen(c.health.last_test_at) : '') +
          (c.health && c.health.last_error ? ' · error: ' + esc(c.health.last_error) : '') + '</div>' +
        (owner ? '<div class="watch-row">' +
          '<button class="watch-btn" data-act="test" data-id="' + c.id + '" data-testid="watch-test-dry">' + icon('flask-conical') + ' Dry-run test</button>' +
          (c.configured ? '<button class="watch-btn" data-act="test-live" data-id="' + c.id + '">' + icon('send') + ' Live test</button>' : '') +
          '<button class="watch-btn" data-act="toggle" data-id="' + c.id + '" data-en="' + (c.enabled ? '0' : '1') + '">' + (c.enabled ? 'Disable' : 'Enable') + '</button>' +
          '<button class="watch-btn" data-act="delete" data-id="' + c.id + '">Delete</button>' +
        '</div>' : '<div class="watch-note" style="margin-top:6px;font-style:italic">Analysts can view channel health but cannot change credentials.</div>') +
        '<div class="watch-note" data-result="' + c.id + '"></div>' +
        '</div>';
    }).join('') : '<div class="watch-empty">No integration channels configured.' + (owner ? ' Add one below.' : ' Owner access is required to configure channels.') + '</div>';

    body.innerHTML =
      '<p class="watch-disclaimer">Credentials are never stored or shown — a channel references an environment variable NAME whose value is read only at delivery time. Outbound requests are SSRF-guarded (HTTPS-only, no private hosts) and signed for the generic webhook.</p>' +
      list + (owner ? channelForm() : '');

    if (owner) {
      $all('[data-act]', body).forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.dataset.id;
          if (b.dataset.act === 'toggle') return api('/api/integrations?action=toggle', { method: 'POST', body: { id: id, enabled: b.dataset.en === '1' } }).then(loadChannels).then(paint).catch(function () {});
          if (b.dataset.act === 'delete') return api('/api/integrations?action=delete', { method: 'POST', body: { id: id } }).then(loadChannels).then(paint).catch(function () {});
          if (b.dataset.act === 'test' || b.dataset.act === 'test-live') return testChannel(id, b.dataset.act === 'test-live', b);
        });
      });
      var frm = $('#watchChannelForm', body);
      if (frm) frm.addEventListener('submit', function (e) {
        e.preventDefault();
        var payload = { kind: $('#cKind').value, name: $('#cName').value, secretRef: $('#cSecret').value || null, enabled: true };
        var sb = frm.querySelector('button[type="submit"]'); sb.disabled = true;
        api('/api/integrations?action=save', { method: 'POST', body: payload })
          .then(loadChannels).then(paint).catch(function (err) { sb.disabled = false; alert(err.message || 'Save failed'); });
      });
    }
    A.refreshIcons && A.refreshIcons();
  }

  function testChannel(id, live, btn) {
    if (btn) btn.disabled = true;
    var out = $('[data-result="' + id + '"]');
    if (out) out.textContent = live ? 'Running live test…' : 'Running dry-run…';
    api('/api/integrations?action=test', { method: 'POST', body: { id: id, live: !!live } })
      .then(function (j) {
        if (out) {
          if (j.delivered) out.textContent = 'Delivered (HTTP ' + (j.code || 'ok') + ').';
          else if (j.dryRun) out.textContent = 'Dry-run OK — validated ' + (j.wouldSend && j.wouldSend.host ? j.wouldSend.host : 'payload') + '. No request was sent.';
          else out.textContent = j.message || 'No delivery.';
        }
        return loadChannels();
      })
      .then(paint)
      .catch(function (err) { if (out) out.textContent = err.message || 'Test failed.'; })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function channelForm() {
    return '<form id="watchChannelForm" data-testid="watch-channel-form" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px">' +
      '<h4 style="font:600 13px/1.2 var(--sans,system-ui);margin:0 0 10px">Add integration channel</h4>' +
      '<label class="watch-field"><span>Kind</span><select id="cKind">' + (state.kinds.length ? state.kinds : ['webhook', 'slack', 'teams', 'email']).map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('') + '</select></label>' +
      '<label class="watch-field"><span>Name</span><input id="cName" required minlength="2" maxlength="120" placeholder="e.g. Ops Slack"></label>' +
      '<label class="watch-field"><span>Secret env var NAME (not the value)</span><input id="cSecret" maxlength="120" placeholder="AGRIOS_WEBHOOK_OPS" pattern="[A-Z][A-Z0-9_]{2,119}"></label>' +
      '<button class="watch-btn primary" type="submit">' + icon('plus') + ' Add channel</button>' +
      '</form>';
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  function init() {
    injectStyles();
    if (window.AGRIOS_AUTH && typeof window.AGRIOS_AUTH.onChange === 'function') {
      window.AGRIOS_AUTH.onChange(function () { resolveSession().then(function () { if (state.loaded) loadAll(); }); });
    } else {
      resolveSession();
    }
  }

  function render(panel) {
    panelEl = panel;
    injectStyles();
    if (!session) resolveSession().then(loadAll); else loadAll();
  }

  function onActivate() {
    if (map) setTimeout(function () { try { map.invalidateSize(); } catch (_) {} }, 60);
  }

  window.AGRI_WATCH = { init: init, render: render, onActivate: onActivate };
})();
