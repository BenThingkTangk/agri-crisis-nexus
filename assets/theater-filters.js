/* ============================================================
   AGRI-NEXUS THEATER — filters, NL parser, shareable URL state

   Pure deterministic functions. No DOM, no storage, no imports.
   - FILTER_DIMENSIONS: the filterable dimensions + option sets
   - applyFilters(nodes, routes, state): AND across dimensions, OR within
   - parseNL(query): deterministic keyword parser -> partial state + what
     it understood + unmatched tokens
   - serializeState/parseState: URL query <-> state (NEVER includes the
     gate password; storage-free)

   Loads as window.THEATER_FILTERS; loadable in a node:vm sandbox.
   ============================================================ */
(function (root) {
  'use strict';

  var COMMODITIES = ['wheat', 'maize', 'rice', 'soy', 'fertilizer'];
  var KINDS = ['chokepoint', 'breadbasket', 'fertilizer', 'exposed'];
  var SEVERITIES = ['critical', 'high', 'moderate', 'stable'];
  var CATEGORIES = ['maritime', 'coastal', 'inland'];
  var EVIDENCE = ['observed', 'modeled'];

  var FILTER_DIMENSIONS = [
    { id: 'layers', label: 'Layers', options: KINDS.concat(['routes', 'humanitarian']), combine: 'OR' },
    { id: 'commodity', label: 'Commodity', options: COMMODITIES, combine: 'OR' },
    { id: 'severity', label: 'Severity', options: SEVERITIES, combine: 'OR' },
    { id: 'category', label: 'Chokepoint type', options: CATEGORIES, combine: 'OR' },
    { id: 'evidence', label: 'Evidence', options: EVIDENCE, combine: 'OR' },
  ];

  function emptyState() {
    return { layers: [], commodity: [], severity: [], category: [], evidence: [], region: '', q: '', horizon: null, sel: null };
  }

  function has(arr, v) { return arr && arr.indexOf(v) !== -1; }

  /* AND across active dimensions; OR within each multi-select. Empty
     dimension = no constraint. */
  function nodeMatches(node, state) {
    if (state.layers.length && !has(state.layers, node.kind)) return false;
    if (state.commodity.length && !(node.commodities || []).some(function (c) { return has(state.commodity, c); })) return false;
    if (state.severity.length && !has(state.severity, node.severity)) return false;
    if (state.category.length) {
      if (node.kind !== 'chokepoint') return false;
      if (!has(state.category, node.category)) return false;
    }
    if (state.evidence.length) {
      var ev = node.observed ? 'observed' : 'modeled';
      if (!has(state.evidence, ev)) return false;
    }
    if (state.region) {
      var r = state.region.toLowerCase();
      if (String(node.name).toLowerCase().indexOf(r) === -1) return false;
    }
    return true;
  }

  function routeMatches(route, state, matchedNodeIds) {
    if (state.layers.length && !has(state.layers, 'routes')) return false;
    if (state.commodity.length && !has(state.commodity, route.commodity)) return false;
    if (state.severity.length && !has(state.severity, route.severity)) return false;
    if (state.evidence.length) {
      var ev = route.observed ? 'observed' : 'modeled';
      if (!has(state.evidence, ev)) return false;
    }
    // Category filter on routes: keep routes traversing a matched chokepoint of that category.
    if (state.category.length) {
      var viaOk = (route.via || []).some(function (id) { return matchedNodeIds && matchedNodeIds[id]; });
      if (!viaOk) return false;
    }
    if (state.region) {
      var r = state.region.toLowerCase();
      if (String(route.from).toLowerCase().indexOf(r) === -1 && String(route.to).toLowerCase().indexOf(r) === -1) return false;
    }
    return true;
  }

  function applyFilters(nodes, routes, state) {
    state = Object.assign(emptyState(), state || {});
    var outNodes = nodes.filter(function (n) { return nodeMatches(n, state); });
    var matchedIds = {};
    outNodes.forEach(function (n) { matchedIds[n.id] = true; });
    var outRoutes = (routes || []).filter(function (rt) { return routeMatches(rt, state, matchedIds); });
    return { nodes: outNodes, routes: outRoutes, count: outNodes.length + outRoutes.length };
  }

  /* ---------------- deterministic NL parser ---------------- */
  var NL_EXAMPLES = [
    'wheat chokepoints exposed to conflict',
    'fertilizer routes through Suez',
    'drought pressure in major maize zones',
    'critical maritime chokepoints for rice',
    'observed breadbaskets at high severity',
  ];

  var SEV_WORDS = { critical: 'critical', conflict: 'critical', famine: 'critical', high: 'high', elevated: 'high', drought: 'high', moderate: 'moderate', watch: 'moderate', stable: 'stable' };
  var KIND_WORDS = { chokepoint: 'chokepoint', chokepoints: 'chokepoint', breadbasket: 'breadbasket', breadbaskets: 'breadbasket', zone: 'breadbasket', zones: 'breadbasket', fertilizer: 'fertilizer', hub: 'fertilizer', hubs: 'fertilizer', import: 'exposed', importer: 'exposed', exposed: 'exposed', route: 'routes', routes: 'routes' };
  var CAT_WORDS = { maritime: 'maritime', strait: 'maritime', canal: 'maritime', coastal: 'coastal', port: 'coastal', ports: 'coastal', inland: 'inland', rail: 'inland', road: 'inland' };

  function parseNL(query) {
    var state = emptyState();
    var understood = { commodity: [], severity: [], layers: [], category: [], evidence: [] };
    var unmatched = [];
    var tokens = String(query || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    tokens.forEach(function (tok) {
      if (COMMODITIES.indexOf(tok) !== -1) { if (!has(state.commodity, tok)) { state.commodity.push(tok); understood.commodity.push(tok); } return; }
      if (SEV_WORDS[tok]) { var s = SEV_WORDS[tok]; if (!has(state.severity, s)) { state.severity.push(s); understood.severity.push(s); } return; }
      if (KIND_WORDS[tok]) { var k = KIND_WORDS[tok]; if (!has(state.layers, k)) { state.layers.push(k); understood.layers.push(k); } return; }
      if (CAT_WORDS[tok]) { var c = CAT_WORDS[tok]; if (!has(state.category, c)) { state.category.push(c); understood.category.push(c); } return; }
      if (tok === 'observed' || tok === 'measured') { if (!has(state.evidence, 'observed')) { state.evidence.push('observed'); understood.evidence.push('observed'); } return; }
      if (tok === 'modeled' || tok === 'modelled' || tok === 'assumed') { if (!has(state.evidence, 'modeled')) { state.evidence.push('modeled'); understood.evidence.push('modeled'); } return; }
      if (['through', 'in', 'to', 'exposed', 'for', 'the', 'of', 'at', 'and', 'or', 'major', 'zones', 'zone', 'pressure'].indexOf(tok) !== -1) return; // stopwords/handled
      // Named place -> region free-text (e.g. "suez", "black", "sea")
      unmatched.push(tok);
    });
    if (unmatched.length) state.region = unmatched.join(' ');
    state.q = String(query || '');
    var understoodAny = understood.commodity.length || understood.severity.length || understood.layers.length || understood.category.length || understood.evidence.length || state.region;
    return { state: state, understood: understood, unmatched: unmatched, understoodAny: !!understoodAny };
  }

  /* ---------------- URL state (storage-free, no password) ---------------- */
  var MULTI = ['layers', 'commodity', 'severity', 'category', 'evidence'];

  function serializeState(state) {
    state = Object.assign(emptyState(), state || {});
    var parts = [];
    MULTI.forEach(function (k) { if (state[k] && state[k].length) parts.push(k + '=' + encodeURIComponent(state[k].join(','))); });
    if (state.region) parts.push('region=' + encodeURIComponent(state.region));
    if (state.horizon != null) parts.push('horizon=' + encodeURIComponent(state.horizon));
    if (state.sel) parts.push('sel=' + encodeURIComponent(state.sel));
    if (state.sim && typeof state.sim === 'object') {
      // Compact sim descriptor only (never secrets).
      var s = state.sim;
      var simParts = [];
      ['preset', 'initiator', 'intensity', 'duration', 'propagation'].forEach(function (kk) { if (s[kk] != null) simParts.push(kk + ':' + s[kk]); });
      if (s.commodities && s.commodities.length) simParts.push('commodities:' + s.commodities.join('.'));
      if (s.interventions && s.interventions.length) simParts.push('interventions:' + s.interventions.join('.'));
      if (simParts.length) parts.push('sim=' + encodeURIComponent(simParts.join(';')));
    }
    return parts.join('&');
  }

  function parseState(qs) {
    var state = emptyState();
    if (!qs) return state;
    qs = String(qs).replace(/^[?#]/, '');
    qs.split('&').forEach(function (pair) {
      if (!pair) return;
      var idx = pair.indexOf('=');
      var key = decodeURIComponent(idx === -1 ? pair : pair.slice(0, idx));
      var val = idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1));
      if (key === 'password' || key === 'pw' || key === 'gate') return; // hard guard: never accept a password from URL
      if (MULTI.indexOf(key) !== -1) { state[key] = val ? val.split(',').filter(Boolean) : []; }
      else if (key === 'region') state.region = val;
      else if (key === 'horizon') state.horizon = parseInt(val, 10) || null;
      else if (key === 'sel') state.sel = val;
      else if (key === 'sim') {
        var sim = {};
        val.split(';').forEach(function (kv) {
          var c = kv.indexOf(':'); if (c === -1) return;
          var k = kv.slice(0, c), v = kv.slice(c + 1);
          if (k === 'commodities') sim.commodities = v.split('.').filter(Boolean);
          else if (k === 'interventions') sim.interventions = v.split('.').filter(Boolean);
          else if (k === 'intensity' || k === 'duration' || k === 'propagation') sim[k] = parseInt(v, 10);
          else sim[k] = v;
        });
        state.sim = sim;
      }
    });
    return state;
  }

  var API = {
    FILTER_DIMENSIONS: FILTER_DIMENSIONS,
    COMMODITIES: COMMODITIES, KINDS: KINDS, SEVERITIES: SEVERITIES, CATEGORIES: CATEGORIES, EVIDENCE: EVIDENCE,
    NL_EXAMPLES: NL_EXAMPLES,
    emptyState: emptyState,
    applyFilters: applyFilters,
    nodeMatches: nodeMatches,
    parseNL: parseNL,
    serializeState: serializeState,
    parseState: parseState,
  };
  root.THEATER_FILTERS = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
