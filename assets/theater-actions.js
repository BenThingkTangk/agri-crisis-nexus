/* ============================================================
   AGRI-NEXUS THEATER — ATOM structured-action allowlist + validator

   ATOM may return a fenced ```atom-actions JSON block requesting the
   theater perform bounded operations. NOTHING here executes arbitrary
   code: every action is validated against a strict allowlist + schema,
   with typed/clamped arguments. Unknown actions or bad args are
   rejected with a reason. The UI layer maps validated actions onto its
   own handlers.

   Loads as window.THEATER_ACTIONS; loadable in a node:vm sandbox.
   ============================================================ */
(function (root) {
  'use strict';

  var COMMODITIES = ['wheat', 'maize', 'rice', 'soy', 'fertilizer'];
  var LAYERS = ['chokepoint', 'breadbasket', 'fertilizer', 'exposed', 'routes', 'humanitarian'];
  var SEVERITIES = ['critical', 'high', 'moderate', 'stable'];

  function clampInt(v, lo, hi, dflt) { var n = parseInt(v, 10); if (isNaN(n)) return dflt; return n < lo ? lo : (n > hi ? hi : n); }
  function strArrIn(v, allowed) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (x) { return typeof x === 'string' && allowed.indexOf(x) !== -1; });
  }
  function shortStr(v, max) { if (typeof v !== 'string') return ''; return v.slice(0, max || 120); }

  /* Each entry: validate(args) -> {ok:true, args} | {ok:false, error}.
     `nodeIds` (optional) constrains id-referencing actions to known nodes. */
  var SCHEMA = {
    'select-layers': function (a) {
      var layers = strArrIn(a.layers, LAYERS);
      if (!layers.length) return { ok: false, error: 'no valid layers' };
      return { ok: true, args: { layers: layers } };
    },
    'apply-filters': function (a) {
      return { ok: true, args: {
        commodity: strArrIn(a.commodity, COMMODITIES),
        severity: strArrIn(a.severity, SEVERITIES),
        layers: strArrIn(a.layers, LAYERS),
        region: shortStr(a.region, 60),
      } };
    },
    'fly-to': function (a, ctx) {
      if (a.nodeId != null) {
        if (ctx && ctx.nodeIds && !ctx.nodeIds[a.nodeId]) return { ok: false, error: 'unknown nodeId' };
        return { ok: true, args: { nodeId: shortStr(a.nodeId, 40) } };
      }
      var lat = parseFloat(a.lat), lng = parseFloat(a.lng);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'bad coordinates' };
      return { ok: true, args: { lat: lat, lng: lng, label: shortStr(a.label, 60) } };
    },
    'focus-chokepoint': function (a, ctx) {
      var id = shortStr(a.nodeId || a.id, 40);
      if (!id) return { ok: false, error: 'missing chokepoint id' };
      if (ctx && ctx.nodeIds && !ctx.nodeIds[id]) return { ok: false, error: 'unknown chokepoint' };
      return { ok: true, args: { nodeId: id } };
    },
    'explain-dependency': function (a, ctx) {
      var id = shortStr(a.nodeId || a.id, 40);
      if (!id) return { ok: false, error: 'missing node id' };
      if (ctx && ctx.nodeIds && !ctx.nodeIds[id]) return { ok: false, error: 'unknown node' };
      return { ok: true, args: { nodeId: id } };
    },
    'run-scenario': function (a) {
      return { ok: true, args: {
        preset: shortStr(a.preset, 40) || null,
        initiator: shortStr(a.initiator, 40) || null,
        intensity: clampInt(a.intensity, 1, 5, 4),
        duration: clampInt(a.duration, 1, 180, 120),
        propagation: clampInt(a.propagation, 1, 5, 3),
        commodities: strArrIn(a.commodities, COMMODITIES),
        interventions: Array.isArray(a.interventions) ? a.interventions.map(function (x) { return shortStr(x, 40); }).filter(Boolean).slice(0, 6) : [],
      } };
    },
    'compare-intervention': function (a) {
      var ivs = Array.isArray(a.interventions) ? a.interventions.map(function (x) { return shortStr(x, 40); }).filter(Boolean).slice(0, 6) : [];
      if (!ivs.length) return { ok: false, error: 'no interventions to compare' };
      return { ok: true, args: { interventions: ivs } };
    },
    'create-mission': function (a) {
      var title = shortStr(a.title, 120);
      if (!title) return { ok: false, error: 'missing mission title' };
      return { ok: true, args: { title: title, objective: shortStr(a.objective, 400), pillar: shortStr(a.pillar, 60), sourceId: shortStr(a.sourceId, 40) } };
    },
  };
  var ALLOWLIST = Object.keys(SCHEMA);

  function validateAction(action, ctx) {
    if (!action || typeof action !== 'object') return { ok: false, error: 'not an object' };
    var type = action.type || action.action;
    if (typeof type !== 'string' || ALLOWLIST.indexOf(type) === -1) return { ok: false, error: 'action not allowlisted: ' + type };
    var res = SCHEMA[type](action.args || action, ctx || {});
    if (!res.ok) return { ok: false, error: res.error, type: type };
    return { ok: true, type: type, args: res.args };
  }

  /* Parse a fenced ```atom-actions JSON block; returns validated actions
     + rejected entries (for transparency). Never throws. */
  function parseAtomActions(content, ctx) {
    var out = { actions: [], rejected: [], text: String(content == null ? '' : content) };
    var m = out.text.match(/```atom-actions\s*([\s\S]*?)```/);
    if (!m) return out;
    out.text = out.text.replace(m[0], '').trim();
    var parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch (e) { out.rejected.push({ error: 'invalid JSON' }); return out; }
    var list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.actions) ? parsed.actions : [parsed]);
    list.slice(0, 12).forEach(function (a) {
      var v = validateAction(a, ctx);
      if (v.ok) out.actions.push(v); else out.rejected.push(v);
    });
    return out;
  }

  var API = {
    ALLOWLIST: ALLOWLIST,
    validateAction: validateAction,
    parseAtomActions: parseAtomActions,
  };
  root.THEATER_ACTIONS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
