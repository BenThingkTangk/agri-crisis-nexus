/* ============================================================
   AGRI-NEXUS — Food War simulation engine (deterministic core)

   A scenario-EXPLORATION tool, not a forecast. Given a parameter set
   it produces a fully deterministic day-0..180 timeline of modeled
   KPIs plus an explainable event log. Interventions are applied as
   deterministic modifiers so a baseline-vs-intervention comparison
   yields stable deltas.

   No randomness, no imports, no DOM. Loads as window.SIM_ENGINE and is
   loadable in a node:vm sandbox for tests.
   ============================================================ */
(function (root) {
  'use strict';

  var HORIZON = 180; // days, 0..180 inclusive

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* Logistic ramp 0..1 across the shock onset; deterministic. */
  function ramp(day, onset, speed) {
    var k = 0.06 + speed * 0.06; // propagation speed -> steepness
    var x = k * (day - onset);
    return 1 / (1 + Math.exp(-x));
  }

  /* ---------------- presets ----------------
     Each preset is a complete default parameter set. `commodities`
     scopes which commodity routes the shock degrades. */
  var PRESETS = [
    { id: 'blacksea-blockade', label: 'Black Sea blockade', initiator: 'cp-turkish',
      intensity: 5, duration: 120, propagation: 4, commodities: ['wheat', 'maize'],
      reserveBuffer: 3, routeSubstitution: 2, marketFriction: 4, responseLag: 3,
      blurb: 'Turkish Straits corridor closes; Black Sea wheat cannot reach MENA.' },
    { id: 'suez-closure', label: 'Red Sea / Suez closure', initiator: 'cp-suez',
      intensity: 4, duration: 90, propagation: 4, commodities: ['wheat', 'maize', 'fertilizer'],
      reserveBuffer: 3, routeSubstitution: 3, marketFriction: 3, responseLag: 3,
      blurb: 'Suez + Bab al-Mandab disruption forces the Cape detour.' },
    { id: 'multi-drought', label: 'Multi-breadbasket drought', initiator: 'bb-usmidwest',
      intensity: 4, duration: 150, propagation: 2, commodities: ['maize', 'soy', 'wheat'],
      reserveBuffer: 2, routeSubstitution: 3, marketFriction: 3, responseLag: 4,
      blurb: 'Simultaneous yield loss across major producing regions.' },
    { id: 'fertilizer-embargo', label: 'Fertilizer embargo / input shock', initiator: 'fh-russia',
      intensity: 5, duration: 160, propagation: 2, commodities: ['fertilizer'],
      reserveBuffer: 2, routeSubstitution: 2, marketFriction: 4, responseLag: 4,
      blurb: 'Potash/nitrogen export cut-off degrades next-season yields.' },
    { id: 'export-cascade', label: 'Export-control cascade', initiator: 'bb-indogangetic',
      intensity: 4, duration: 100, propagation: 5, commodities: ['rice', 'wheat'],
      reserveBuffer: 3, routeSubstitution: 2, marketFriction: 5, responseLag: 2,
      blurb: 'Precautionary export bans spread across producers.' },
    { id: 'port-cyber', label: 'Port cyberattack / logistics failure', initiator: 'cp-usgulf',
      intensity: 4, duration: 45, propagation: 5, commodities: ['maize', 'soy'],
      reserveBuffer: 4, routeSubstitution: 3, marketFriction: 3, responseLag: 2,
      blurb: 'Terminal operating systems offline; throughput collapses then recovers.' },
    { id: 'hormuz-fertilizer', label: 'Hormuz fertilizer shock', initiator: 'cp-hormuz',
      intensity: 4, duration: 70, propagation: 4, commodities: ['fertilizer'],
      reserveBuffer: 3, routeSubstitution: 2, marketFriction: 4, responseLag: 3,
      blurb: 'Gulf nitrogen/urea flows through Hormuz interrupted.' },
    { id: 'polycrisis', label: 'Compound polycrisis', initiator: 'cp-turkish',
      intensity: 5, duration: 180, propagation: 3, commodities: ['wheat', 'maize', 'rice', 'fertilizer'],
      reserveBuffer: 2, routeSubstitution: 2, marketFriction: 5, responseLag: 5,
      blurb: 'Overlapping conflict, drought and input shocks compound.' },
  ];
  var PRESET_BY_ID = {};
  PRESETS.forEach(function (p) { PRESET_BY_ID[p.id] = p; });

  /* ---------------- interventions ----------------
     Each returns deterministic modifiers applied to the daily curves.
     Values are fractions (0..1) of mitigation on the relevant KPI. */
  var INTERVENTIONS = [
    { id: 'release-reserves', label: 'Release strategic reserves', reserve: -0.10, price: 0.18, human: 0.15 },
    { id: 'reroute', label: 'Reroute via Cape / alternate ports', capacity: 0.22, price: 0.10 },
    { id: 'relax-export', label: 'Relax export controls', capacity: 0.12, price: 0.14 },
    { id: 'humanitarian-corridor', label: 'Protected humanitarian corridor', human: 0.28, capacity: 0.08 },
    { id: 'input-support', label: 'Fertilizer / input support', price: 0.08, yield: 0.16 },
    { id: 'demand-management', label: 'Demand management', price: 0.12, human: 0.10 },
  ];
  var INTERVENTION_BY_ID = {};
  INTERVENTIONS.forEach(function (i) { INTERVENTION_BY_ID[i.id] = i; });

  function normalizeParams(params) {
    params = params || {};
    var base = params.preset && PRESET_BY_ID[params.preset] ? PRESET_BY_ID[params.preset] : {};
    function pick(k, dflt) { return params[k] != null ? params[k] : (base[k] != null ? base[k] : dflt); }
    return {
      preset: params.preset || null,
      initiator: pick('initiator', 'cp-turkish'),
      intensity: clamp(+pick('intensity', 4), 1, 5),
      duration: clamp(+pick('duration', 120), 1, HORIZON),
      propagation: clamp(+pick('propagation', 3), 1, 5),
      commodities: pick('commodities', ['wheat']),
      reserveBuffer: clamp(+pick('reserveBuffer', 3), 1, 5),
      routeSubstitution: clamp(+pick('routeSubstitution', 3), 1, 5),
      marketFriction: clamp(+pick('marketFriction', 3), 1, 5),
      responseLag: clamp(+pick('responseLag', 3), 1, 5),
      interventions: (params.interventions || []).filter(function (id) { return INTERVENTION_BY_ID[id]; }),
    };
  }

  function interventionMods(ids) {
    var m = { capacity: 0, price: 0, reserve: 0, human: 0, yield: 0 };
    (ids || []).forEach(function (id) {
      var iv = INTERVENTION_BY_ID[id]; if (!iv) return;
      ['capacity', 'price', 'reserve', 'human', 'yield'].forEach(function (k) { if (iv[k]) m[k] += iv[k]; });
    });
    return m;
  }

  /* Compute the KPI vector for a single day, deterministically. */
  function dayKpis(p, mods, day) {
    var onset = 2;
    var recovery = p.duration; // shock eases after duration
    var shock = ramp(day, onset, p.propagation);
    if (day > recovery) {
      var ease = ramp(day, recovery + (p.responseLag * 2), p.propagation);
      shock = shock * (1 - 0.8 * ease);
    }
    var sev = p.intensity / 5;

    // Route capacity: 100% down toward a floor set by intensity, softened by substitution + reroute.
    var capFloor = 100 - (55 * sev);
    var subst = (p.routeSubstitution / 5) * 22 + mods.capacity * 100;
    var routeCapacity = clamp(100 - (100 - capFloor) * shock + subst * shock, 5, 100);

    // Price pressure index (100 = baseline). Rises with shock + friction, minus interventions.
    var friction = 1 + (p.marketFriction / 5) * 0.9;
    var priceRaw = 100 + (sev * 95 * friction) * shock;
    var pricePressure = clamp(priceRaw * (1 - mods.price * shock), 100, 400);

    // Reserve buffer (days of cover), depletes with shock, deeper if buffer param low.
    var startBuffer = 20 + p.reserveBuffer * 14;
    var reserveBuffer = clamp(startBuffer - (startBuffer - 6) * shock * (1 - mods.reserve) , 0, startBuffer);
    reserveBuffer = clamp(reserveBuffer + mods.reserve * -0 , 0, startBuffer); // reserve mod handled above

    // Exposed import-dependent population proxy (millions), scaled by shock + commodity breadth.
    var breadth = Math.min(1, p.commodities.length / 4);
    var exposedPop = clamp((80 + 220 * sev * breadth) * shock, 0, 400);

    // Humanitarian caseload (millions), lags via responseLag, mitigated by human interventions.
    var humShock = ramp(day, onset + p.responseLag * 3, p.propagation);
    var humanitarianCaseload = clamp((10 + 60 * sev * breadth) * humShock * (1 - mods.human), 0, 120);

    // Affected nodes/countries (count) grows with shock.
    var affectedNodes = Math.round(clamp((2 + 12 * sev) * shock, 0, 18));

    // Confidence decays as the scenario runs further from the observed present.
    var confidence = Math.round(clamp(82 - day * 0.18 - p.intensity * 2, 30, 90));

    return {
      day: day,
      routeCapacity: round1(routeCapacity),
      pricePressure: round1(pricePressure),
      exposedPop: round1(exposedPop),
      reserveBuffer: round1(reserveBuffer),
      humanitarianCaseload: round1(humanitarianCaseload),
      affectedNodes: affectedNodes,
      confidence: confidence,
      shock: round1(shock * 100),
    };
  }

  function buildTimeline(p, mods) {
    var t = [];
    for (var d = 0; d <= HORIZON; d++) t.push(dayKpis(p, mods, d));
    return t;
  }

  /* Explainable cascade log — deterministic narrative keyed to the curve. */
  function buildEventLog(p, timeline) {
    var log = [];
    var initName = p.initiator;
    log.push({ day: 0, severity: 'moderate', text: 'Scenario initialized at ' + initName + ' (intensity ' + p.intensity + '/5, ' + p.duration + '-day shock).' });
    // Find day route capacity first drops below 75, 50, 25.
    var thresholds = [{ v: 75, s: 'moderate', m: 'Effective route capacity falls below 75% — first reroute pressure.' },
      { v: 50, s: 'high', m: 'Route capacity below 50% — substitution routes saturate.' },
      { v: 25, s: 'critical', m: 'Route capacity below 25% — corridor effectively severed.' }];
    thresholds.forEach(function (th) {
      for (var i = 0; i < timeline.length; i++) {
        if (timeline[i].routeCapacity <= th.v) { log.push({ day: timeline[i].day, severity: th.s, text: 'Day ' + timeline[i].day + ': ' + th.m }); break; }
      }
    });
    // Price milestones.
    [{ v: 130, s: 'moderate' }, { v: 175, s: 'high' }, { v: 220, s: 'critical' }].forEach(function (th) {
      for (var i = 0; i < timeline.length; i++) {
        if (timeline[i].pricePressure >= th.v) { log.push({ day: timeline[i].day, severity: th.s, text: 'Day ' + timeline[i].day + ': modeled price pressure crosses ' + th.v + ' (index).' }); break; }
      }
    });
    // Reserve depletion.
    for (var i = 0; i < timeline.length; i++) {
      if (timeline[i].reserveBuffer <= 10) { log.push({ day: timeline[i].day, severity: 'critical', text: 'Day ' + timeline[i].day + ': reserve buffer under 10 days of cover — importer scramble.' }); break; }
    }
    // Peak humanitarian.
    var peak = timeline.reduce(function (a, b) { return b.humanitarianCaseload > a.humanitarianCaseload ? b : a; }, timeline[0]);
    log.push({ day: peak.day, severity: 'critical', text: 'Day ' + peak.day + ': humanitarian caseload peaks near ' + peak.humanitarianCaseload + 'M (modeled).' });
    if (p.interventions.length) {
      log.push({ day: 0, severity: 'stable', text: 'Interventions active: ' + p.interventions.map(function (id) { return INTERVENTION_BY_ID[id].label; }).join(', ') + '.' });
    }
    log.sort(function (a, b) { return a.day - b.day; });
    return log;
  }

  function summarize(timeline) {
    var minCap = 100, maxPrice = 100, minReserve = Infinity, maxHuman = 0, maxExposed = 0, maxNodes = 0;
    timeline.forEach(function (k) {
      if (k.routeCapacity < minCap) minCap = k.routeCapacity;
      if (k.pricePressure > maxPrice) maxPrice = k.pricePressure;
      if (k.reserveBuffer < minReserve) minReserve = k.reserveBuffer;
      if (k.humanitarianCaseload > maxHuman) maxHuman = k.humanitarianCaseload;
      if (k.exposedPop > maxExposed) maxExposed = k.exposedPop;
      if (k.affectedNodes > maxNodes) maxNodes = k.affectedNodes;
    });
    return { minRouteCapacity: round1(minCap), peakPricePressure: round1(maxPrice), minReserveBuffer: round1(minReserve),
      peakHumanitarian: round1(maxHuman), peakExposed: round1(maxExposed), peakAffectedNodes: maxNodes };
  }

  /* Public: run a scenario (baseline + intervention overlay + deltas). */
  function runSim(rawParams) {
    var p = normalizeParams(rawParams);
    var baselineParams = {}; for (var k in p) baselineParams[k] = p[k]; baselineParams.interventions = [];
    var baseTimeline = buildTimeline(baselineParams, interventionMods([]));
    var mods = interventionMods(p.interventions);
    var timeline = buildTimeline(p, mods);
    var summary = summarize(timeline);
    var baseSummary = summarize(baseTimeline);
    var deltas = {
      routeCapacity: round1(summary.minRouteCapacity - baseSummary.minRouteCapacity),
      pricePressure: round1(summary.peakPricePressure - baseSummary.peakPricePressure),
      reserveBuffer: round1(summary.minReserveBuffer - baseSummary.minReserveBuffer),
      humanitarian: round1(summary.peakHumanitarian - baseSummary.peakHumanitarian),
      exposed: round1(summary.peakExposed - baseSummary.peakExposed),
    };
    return {
      params: p,
      horizon: HORIZON,
      timeline: timeline,
      baseline: baseTimeline,
      summary: summary,
      baselineSummary: baseSummary,
      deltas: deltas,
      eventLog: buildEventLog(p, timeline),
      modelCard: 'Scenario-exploration tool, not a prediction. KPIs are modeled proxies derived from the parameter set; observed data (chokepoint structure, breadbasket geography) is cited in provenance. Do not treat outputs as measured or forecast values.',
    };
  }

  /* ---------------- cinematic phased playback ----------------
     Eight deterministic phases mapped onto the day-0..180 timeline so the
     Theater can drive an explainable, phase-marked playback (not a video).
     Phase boundaries are derived from the modeled curve + parameters and are
     forced monotonic non-decreasing, so markers never cross. */
  var PHASES = [
    { id: 'trigger', label: 'Trigger', hint: 'Shock initiated at the initiator node.' },
    { id: 'chokepoint', label: 'Chokepoint disruption', hint: 'Throughput at the corridor degrades.' },
    { id: 'rerouting', label: 'Route rerouting', hint: 'Substitution routes absorb diverted volume.' },
    { id: 'price', label: 'Price / input propagation', hint: 'Price pressure and input costs propagate.' },
    { id: 'breadbasket', label: 'Breadbasket stress', hint: 'Production-zone exposure widens.' },
    { id: 'humanitarian', label: 'Humanitarian escalation', hint: 'Caseload rises in import-exposed regions.' },
    { id: 'response', label: 'Response / intervention', hint: 'Reserves, corridors and reroutes take effect.' },
    { id: 'stabilization', label: 'Stabilization / aftershock', hint: 'Shock eases; residual aftershocks persist.' },
  ];
  var PHASE_ORDER = PHASES.map(function (p) { return p.id; });

  function firstDay(timeline, pred, dflt) {
    for (var i = 0; i < timeline.length; i++) { if (pred(timeline[i])) return timeline[i].day; }
    return dflt;
  }

  // Ordered phase segments {index,id,label,hint,startDay,endDay} for a run.
  function computePhases(result) {
    var tl = result.timeline, p = result.params, H = result.horizon;
    var peakHuman = (result.summary && result.summary.peakHumanitarian) || 0;
    var raw = {
      trigger: 0,
      chokepoint: firstDay(tl, function (k) { return k.shock >= 15; }, 2),
      rerouting: firstDay(tl, function (k) { return k.routeCapacity <= 75; }, Math.round(H * 0.12)),
      price: firstDay(tl, function (k) { return k.pricePressure >= 130; }, Math.round(H * 0.2)),
      breadbasket: firstDay(tl, function (k) { return k.routeCapacity <= 50; }, Math.round(H * 0.3)),
      humanitarian: firstDay(tl, function (k) { return peakHuman > 0 && k.humanitarianCaseload >= peakHuman * 0.3; }, Math.round(H * 0.45)),
      response: Math.min(H, p.duration),
      stabilization: Math.min(H, p.duration + p.responseLag * 2),
    };
    var prev = 0, out = [];
    PHASE_ORDER.forEach(function (id, i) {
      var start = Math.max(0, Math.min(H, raw[id] != null ? raw[id] : prev));
      if (i > 0 && start <= prev) start = Math.min(H, prev + 1); // strictly after prior phase
      prev = start;
      out.push({ index: i, id: id, label: PHASES[i].label, hint: PHASES[i].hint, startDay: start, endDay: H });
    });
    out.forEach(function (ph, i) { if (i < out.length - 1) ph.endDay = out[i + 1].startDay; });
    return out;
  }

  function phaseForDay(day, phases) {
    var cur = phases[0];
    for (var i = 0; i < phases.length; i++) { if (day >= phases[i].startDay) cur = phases[i]; }
    return cur;
  }

  var LEDGER_EVIDENCE = {
    trigger: 'Initiator node structure (Chatham House chokepoint geography).',
    chokepoint: 'Chatham House corridor share + alternatives.',
    rerouting: 'Route-substitution parameter over the trade-arc network.',
    price: 'FAO Food Price Index dynamics (modeled response).',
    breadbasket: 'FAO crop-calendar production-zone geography.',
    humanitarian: 'FEWS NET import-exposure structure.',
    response: 'Intervention modifiers (reserves / corridors / reroute).',
    stabilization: 'Recovery ramp after shock duration + response lag.',
  };
  var LEDGER_NEXT = {
    trigger: 'Confirm corridor status; pre-position reroute capacity.',
    chokepoint: 'Decide whether to activate substitution routes.',
    rerouting: 'Weigh relaxing export controls to ease price pressure.',
    price: 'Consider strategic-reserve release for exposed importers.',
    breadbasket: 'Target input support to at-risk production zones.',
    humanitarian: 'Stand up protected humanitarian corridors.',
    response: 'Monitor delta vs baseline; sustain or taper interventions.',
    stabilization: 'Plan aftershock watch + reserve replenishment.',
  };
  function ledgerChanged(id, k) {
    if (!k) return 'Scenario state advancing.';
    switch (id) {
      case 'trigger': return 'Scenario initialized; shock onset ' + k.shock + '%.';
      case 'chokepoint': return 'Route capacity ' + k.routeCapacity + '% as corridor degrades.';
      case 'rerouting': return 'Capacity ' + k.routeCapacity + '%; substitution routes engaged.';
      case 'price': return 'Price pressure index ' + k.pricePressure + '.';
      case 'breadbasket': return 'Affected nodes ' + k.affectedNodes + '; exposed pop ' + k.exposedPop + 'M.';
      case 'humanitarian': return 'Humanitarian caseload ' + k.humanitarianCaseload + 'M (modeled).';
      case 'response': return 'Reserve buffer ' + k.reserveBuffer + 'd; interventions applied.';
      case 'stabilization': return 'Capacity recovering to ' + k.routeCapacity + '%.';
      default: return 'State advancing.';
    }
  }

  /* Synchronized causal ledger: one explainable entry per phase carrying what
     changed, why, evidence inputs, the modeled assumption, confidence, lag, and
     the next decision point. Deterministic; drives the Theater event rail. */
  function phaseLedger(result) {
    var phases = computePhases(result), tl = result.timeline, p = result.params, H = result.horizon;
    return phases.map(function (ph) {
      var k = tl[Math.max(0, Math.min(H, ph.startDay))];
      return {
        index: ph.index, id: ph.id, label: ph.label, startDay: ph.startDay, endDay: ph.endDay,
        changed: ledgerChanged(ph.id, k),
        why: ph.hint,
        evidence: LEDGER_EVIDENCE[ph.id] || '',
        assumption: 'Modeled proxy from scenario parameters — not a measured observation.',
        confidence: k ? k.confidence : null,
        lagDays: p.responseLag * 3,
        nextDecision: LEDGER_NEXT[ph.id] || '',
      };
    });
  }

  /* ---------------- scenario seeding from observed signals ----------------
     Phase VII: turn live intel/catalog signals into a SUGGESTED starting point
     for exploration. This is ADDITIVE and pure — it never runs a simulation,
     never mutates params, and is explicitly a scenario seed, NOT a prediction.
     Observed inputs are echoed with their sources so the operator can see
     exactly what nudged each suggestion; simulation outputs remain modeled
     proxies. */
  var SCENARIO_SEED_DISCLAIMER =
    'Scenario seed only — a starting point for exploration, NOT a prediction or forecast. ' +
    'Observed inputs are cited; simulation outputs remain modeled proxies.';

  function num0(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Accepts either an array of normalized events, an object { events:[...] },
  // or a pre-summarized signals object. Returns a stable, side-effect-free seed.
  function deriveScenarioSeed(signals) {
    var s = signals || {};
    var events = Array.isArray(s) ? s : (Array.isArray(s.events) ? s.events : null);

    // Signal tallies (deterministic; from events when provided, else explicit fields).
    var fires = 0, chokepoint = 0, conflict = 0, displacement = 0;
    var foodInsecurityPct = 0, priceInflation = 0, productionStress = 0;
    var sources = [];
    var seenSrc = {};

    function noteSource(id, name, asOf) {
      var key = id || name; if (!key || seenSrc[key]) return; seenSrc[key] = true;
      sources.push({ id: id || null, name: name || id || 'source', asOf: asOf || null });
    }

    if (events) {
      events.forEach(function (e) {
        if (!e) return;
        var dom = e.domain || '', cat = String(e.category || '').toLowerCase(), sev = e.severityScore || 0;
        if (/fire/.test(cat) || e.sourceId === 'firms') fires += 1;
        if (dom === 'logistics' || e.sourceId === 'portwatch') chokepoint = Math.max(chokepoint, sev);
        if (dom === 'conflict') conflict += 1;
        if (e.sourceId === 'unhcr' || /displac/.test(cat)) displacement += num0(e.value);
        if (e.sourceId === 'hungermap' || /food insecurity|fcs/.test(cat)) foodInsecurityPct = Math.max(foodInsecurityPct, num0(e.value));
        if (/inflation|cpi|price/.test(cat)) priceInflation = Math.max(priceInflation, num0(e.value));
        if (dom === 'weather' || /drought|agro-climate/.test(cat)) productionStress = Math.max(productionStress, sev);
        noteSource(e.sourceId, e.source, e.observedAt || e.fetchedAt);
      });
    } else {
      fires = num0(s.fires);
      chokepoint = num0(s.chokepoint);
      conflict = num0(s.conflict);
      displacement = num0(s.displacement);
      foodInsecurityPct = num0(s.foodInsecurityPct);
      priceInflation = num0(s.priceInflation);
      productionStress = num0(s.productionStress);
      (s.sources || []).forEach(function (src) { noteSource(src && src.id, src && src.name, src && src.asOf); });
    }

    // Weighted pressure score (0..1) — deterministic, bounded.
    var pressure = clamp(
      Math.min(1, fires / 40) * 0.2 +
      chokepoint * 0.2 +
      Math.min(1, conflict / 15) * 0.15 +
      Math.min(1, displacement / 3_000_000) * 0.15 +
      Math.min(1, foodInsecurityPct / 60) * 0.15 +
      Math.min(1, priceInflation / 40) * 0.1 +
      productionStress * 0.05,
      0, 1);

    var suggestedIntensity = clamp(Math.round(1 + pressure * 4), 1, 5);

    // Pick the preset whose dominant driver matches the strongest observed signal.
    var drivers = [
      { id: 'blacksea-blockade', score: chokepoint, why: 'maritime chokepoint disruption is the strongest observed signal' },
      { id: 'multi-drought', score: Math.max(productionStress, Math.min(1, fires / 40)), why: 'breadbasket heat/fire/drought stress dominates the observed signals' },
      { id: 'export-cascade', score: Math.min(1, foodInsecurityPct / 60), why: 'elevated food-insecurity prevalence dominates the observed signals' },
      { id: 'polycrisis', score: Math.min(1, (displacement / 3_000_000)) * 0.6 + Math.min(1, conflict / 15) * 0.4, why: 'compounding displacement and conflict signals dominate' },
    ];
    drivers.sort(function (a, b) { return b.score - a.score; });
    var top = drivers[0].score > 0 ? drivers[0] : { id: 'multi-drought', why: 'no strong live signal — defaulting to a broad multi-breadbasket baseline' };
    var suggestedPreset = PRESET_BY_ID[top.id] ? top.id : 'multi-drought';

    return {
      suggestedPreset: suggestedPreset,
      suggestedIntensity: suggestedIntensity,
      pressure: round1(pressure * 100) / 100,
      inputs: {
        activeFires: fires,
        chokepointSeverity: round1(chokepoint * 100) / 100,
        conflictEvents: conflict,
        displacedPersons: displacement,
        foodInsecurityPct: round1(foodInsecurityPct),
        priceInflationPct: round1(priceInflation),
        productionStress: round1(productionStress * 100) / 100,
      },
      rationale: 'Suggested "' + (PRESET_BY_ID[suggestedPreset] ? PRESET_BY_ID[suggestedPreset].label : suggestedPreset) +
        '" at intensity ' + suggestedIntensity + '/5 because ' + top.why + '.',
      disclaimer: SCENARIO_SEED_DISCLAIMER,
      sources: sources,
    };
  }

  var API = {
    HORIZON: HORIZON,
    PRESETS: PRESETS,
    PRESET_BY_ID: PRESET_BY_ID,
    INTERVENTIONS: INTERVENTIONS,
    INTERVENTION_BY_ID: INTERVENTION_BY_ID,
    PHASES: PHASES,
    SCENARIO_SEED_DISCLAIMER: SCENARIO_SEED_DISCLAIMER,
    normalizeParams: normalizeParams,
    runSim: runSim,
    computePhases: computePhases,
    phaseForDay: phaseForDay,
    phaseLedger: phaseLedger,
    deriveScenarioSeed: deriveScenarioSeed,
    clamp: clamp,
  };
  root.SIM_ENGINE = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
