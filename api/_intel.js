// AGRI-NEXUS Phase III domain engine — pure, dependency-free, DOM/DB-free.
//
// This module holds the *decidable* business logic behind predictive alerts,
// mission orchestration, War Room presence, and deterministic (AI-free) ATOM
// structured outputs. It never touches the database, the network, or the DOM,
// so both the API layer and the test suite can import it directly and reason
// about it in isolation (same pattern as _sources.js / _aggregate.js).
//
// Guiding constraints encoded here:
//   * Any modeled intelligence is explicitly labeled `basis:'modeled'` with a
//     confidence in [0,1) and stated assumptions. We never emit confidence 1.0
//     and never claim a future event is certain.
//   * Observed feed triggers are labeled `basis:'observed'`; human input is
//     `basis:'analyst'`.
//   * All state transitions are validated by explicit state machines so the API
//     cannot be coerced into an illegal lifecycle jump.

import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shared vocab
// ---------------------------------------------------------------------------
export const SEVERITIES = ['moderate', 'high', 'critical'];
export const SEVERITY_RANK = { moderate: 1, high: 2, critical: 3 };

export const ALERT_BASIS = ['observed', 'modeled', 'analyst'];
export const HORIZONS = ['24h', '7d', '30d', 'seasonal'];

// Alert lifecycle state machine.
export const ALERT_STATUS = ['new', 'acknowledged', 'escalated', 'resolved'];
const ALERT_TRANSITIONS = {
  new: ['acknowledged', 'escalated', 'resolved'],
  acknowledged: ['escalated', 'resolved'],
  escalated: ['resolved', 'acknowledged'],
  resolved: [], // terminal; reopen is a deliberate, separate action if ever added
};

// Mission lifecycle (mirrors the DB enum; archived is terminal-ish).
export const MISSION_STATUS = ['proposed', 'active', 'blocked', 'complete', 'archived'];
const MISSION_TRANSITIONS = {
  proposed: ['active', 'archived'],
  active: ['blocked', 'complete', 'archived'],
  blocked: ['active', 'archived'],
  complete: ['archived', 'active'], // allow reopening a prematurely-closed mission
  archived: [],
};

// Task lifecycle.
export const TASK_STATUS = ['todo', 'doing', 'blocked', 'done'];
const TASK_TRANSITIONS = {
  todo: ['doing', 'blocked', 'done'],
  doing: ['blocked', 'done', 'todo'],
  blocked: ['doing', 'todo', 'done'],
  done: ['todo'], // allow reopening
};

function canTransition(map, from, to) {
  if (from === to) return true; // idempotent no-op is allowed
  const allowed = map[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function alertStatusCanTransition(from, to) {
  return ALERT_STATUS.includes(to) && canTransition(ALERT_TRANSITIONS, from, to);
}
export function missionStatusCanTransition(from, to) {
  return MISSION_STATUS.includes(to) && canTransition(MISSION_TRANSITIONS, from, to);
}
export function taskStatusCanTransition(from, to) {
  return TASK_STATUS.includes(to) && canTransition(TASK_TRANSITIONS, from, to);
}

// Map a lifecycle action to its resulting status (used by the alerts API).
export function alertActionToStatus(action) {
  return { acknowledge: 'acknowledged', escalate: 'escalated', resolve: 'resolved' }[action] || null;
}

// ---------------------------------------------------------------------------
// Predictive alert derivation
// ---------------------------------------------------------------------------
// Commodity + region keyword maps used to enrich alerts from free-text events.
const COMMODITY_KEYWORDS = {
  wheat: ['wheat', 'grain'],
  maize: ['maize', 'corn'],
  rice: ['rice', 'paddy'],
  soy: ['soy', 'soybean'],
  fertilizer: ['fertilizer', 'fertiliser', 'urea', 'potash', 'phosphate', 'ammonia'],
  palmoil: ['palm oil', 'palm'],
  sugar: ['sugar', 'cane'],
};
const REGION_KEYWORDS = {
  'Black Sea': ['black sea', 'ukraine', 'russia', 'odesa', 'bosphorus', 'kerch'],
  'South Asia': ['india', 'pakistan', 'bangladesh'],
  'Southeast Asia': ['indonesia', 'vietnam', 'thailand', 'malacca'],
  'North America': ['united states', 'usa', 'u.s.', 'canada', 'mississippi'],
  'Horn of Africa': ['ethiopia', 'somalia', 'kenya', 'sudan'],
  'Middle East': ['egypt', 'suez', 'hormuz', 'yemen', 'bab-el-mandeb'],
  'South America': ['brazil', 'argentina', 'panama'],
};

function scanKeywords(text, map) {
  const hay = String(text || '').toLowerCase();
  const out = [];
  for (const [label, kws] of Object.entries(map)) {
    if (kws.some((k) => hay.includes(k))) out.push(label);
  }
  return out;
}

// Horizon heuristic from category/keywords. Structural/policy signals project
// further out than acute weather/logistics disruptions.
function inferHorizon(text) {
  const t = String(text || '').toLowerCase();
  if (/(drought|season|harvest|planting|climate|el niño|el nino|la nina|la niña)/.test(t)) return 'seasonal';
  if (/(policy|export ban|tariff|sanction|subsidy|reserve)/.test(t)) return '30d';
  if (/(price|supply|shortage|stock|inventory)/.test(t)) return '7d';
  return '24h';
}

// Deterministic confidence in [0.2, 0.9]. Higher for observed multi-source,
// severe signals; never 1.0. Modeled projections are capped lower than observed.
export function computeConfidence({ basis = 'modeled', severity = 'moderate', sourceCount = 1, corroboration = 0 } = {}) {
  const sevW = { moderate: 0.15, high: 0.25, critical: 0.35 }[severity] || 0.15;
  const srcW = Math.min(0.2, Math.max(0, sourceCount - 1) * 0.07);
  const corrW = Math.min(0.15, corroboration * 0.05);
  const base = basis === 'observed' ? 0.5 : basis === 'analyst' ? 0.45 : 0.35;
  const raw = base + sevW + srcW + corrW;
  // Hard cap strictly below 1 — we never assert future certainty.
  return Math.round(Math.min(0.9, Math.max(0.2, raw)) * 100) / 100;
}

function stableId(prefix, parts) {
  // Deterministic, dependency-free hash (djb2) for idempotent alert keys.
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${prefix}:${h.toString(16)}`;
}

// Turn a normalized live-feed event into a triageable, explainable alert.
// `basis` is 'observed' because it is a real published signal; any forward-
// looking framing is explicitly hedged in the uncertainty/assumptions.
export function alertFromEvent(ev, { now = Date.now() } = {}) {
  if (!ev || typeof ev !== 'object') return null;
  const title = String(ev.title || '').trim();
  if (!title) return null;
  const severity = SEVERITIES.includes(ev.severity) ? ev.severity : 'moderate';
  const text = `${title} ${ev.category || ''} ${ev.geography || ''} ${ev.summary || ''}`;
  const commodities = scanKeywords(text, COMMODITY_KEYWORDS);
  const regions = ev.geography ? [String(ev.geography).slice(0, 80)] : scanKeywords(text, REGION_KEYWORDS);
  const horizon = inferHorizon(text);
  const confidence = computeConfidence({ basis: 'observed', severity, sourceCount: 1 });
  const iso = new Date(now).toISOString();
  return {
    key: stableId('obs', [ev.source || '', ev.id || title]),
    title: title.slice(0, 400),
    severity,
    basis: 'observed',
    confidence,
    horizon,
    regions,
    commodities,
    status: 'new',
    source: ev.source || null,
    url: ev.url || null,
    category: ev.category || null,
    geography: ev.geography || null,
    eventAt: ev.published || null,
    causalChain: [
      { step: 'trigger', detail: `Observed signal from ${ev.source || 'live feed'}: ${title}`.slice(0, 300) },
    ],
    assumptions: [
      'Signal is a real observed report; downstream agricultural impact is a projection, not a certainty.',
    ],
    createdAt: iso,
    updatedAt: iso,
    modeled: false,
  };
}

// Derive additional *modeled* alerts from crop-risk state. These are explicitly
// projections — labeled modeled, hedged, and confidence-capped. `riskState` is
// an array of { region, commodity, score (0..100), drivers:[], sources:[] }.
export function alertsFromCropRisk(riskState, { now = Date.now(), threshold = 60 } = {}) {
  if (!Array.isArray(riskState)) return [];
  const iso = new Date(now).toISOString();
  const out = [];
  for (const r of riskState) {
    if (!r || typeof r !== 'object') continue;
    const score = Number(r.score);
    if (!Number.isFinite(score) || score < threshold) continue;
    const severity = score >= 85 ? 'critical' : score >= 72 ? 'high' : 'moderate';
    const drivers = Array.isArray(r.drivers) ? r.drivers.slice(0, 6) : [];
    const confidence = computeConfidence({ basis: 'modeled', severity, sourceCount: (r.sources || []).length, corroboration: drivers.length });
    out.push({
      key: stableId('mdl', [r.region || '', r.commodity || '', String(Math.round(score / 5))]),
      title: `Modeled crop-risk elevation: ${r.commodity || 'commodity'} in ${r.region || 'region'} (index ${Math.round(score)})`,
      severity,
      basis: 'modeled',
      confidence,
      horizon: inferHorizon(`${r.commodity} ${drivers.join(' ')}`) === '24h' ? 'seasonal' : inferHorizon(`${r.commodity} ${drivers.join(' ')}`),
      regions: r.region ? [String(r.region)] : [],
      commodities: r.commodity ? [String(r.commodity)] : [],
      status: 'new',
      source: 'crop-risk-model',
      url: null,
      category: 'crop-risk',
      geography: r.region || null,
      eventAt: iso,
      causalChain: [
        { step: 'model', detail: `Crop-risk index ${Math.round(score)} ≥ ${threshold} threshold` },
        ...drivers.map((d) => ({ step: 'driver', detail: String(d).slice(0, 200) })),
      ],
      assumptions: [
        'PROJECTION — modeled from proxy indicators, not an observed shortfall.',
        `Fires when the composite risk index crosses the operational threshold of ${threshold}.`,
        'Index blends weather/price/logistics proxies; individual drivers may resolve independently.',
      ],
      createdAt: iso,
      updatedAt: iso,
      modeled: true,
    });
  }
  return out;
}

// Full derivation pass: observed events + modeled crop-risk, de-duplicated by
// key, sorted by severity then confidence. This is what the alerts API calls.
export function deriveAlerts({ events = [], cropRisk = [], now = Date.now(), threshold = 60 } = {}) {
  const seen = new Set();
  const all = [];
  for (const ev of events) {
    const a = alertFromEvent(ev, { now });
    if (a && !seen.has(a.key)) { seen.add(a.key); all.push(a); }
  }
  for (const a of alertsFromCropRisk(cropRisk, { now, threshold })) {
    if (!seen.has(a.key)) { seen.add(a.key); all.push(a); }
  }
  all.sort((x, y) => (SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]) || (y.confidence - x.confidence));
  return all;
}

// ---------------------------------------------------------------------------
// Agricultural relevance / exposure scoring
// ---------------------------------------------------------------------------
// The raw live feed mirrors generic hazards (earthquakes, prescribed fires,
// wildfires) that are not agricultural crises. Promoting all of them into the
// Alert Center is noise, not intelligence. We score each hazard for genuine
// agricultural exposure and only promote high-relevance signals as OBSERVED
// alerts. Severe hazards with plausible-but-unproven ag impact become clearly
// MODELED projections; everything else stays in the Intel/live feed.
export const AG_PROMOTE_THRESHOLD = 45; // >= this -> actionable OBSERVED alert
export const AG_MODEL_THRESHOLD = 25;   // >= this (and severe) -> MODELED projection

// Categories that plausibly drive agricultural crises. Deliberately EXCLUDES
// generic hazards (earthquake, prescribed/wildfire, volcano) so mirroring the
// raw hazard feed no longer floods the Alert Center.
const AG_CATEGORY_RE = /(drought|flood|inundat|harvest|planting|crop|grain|cereal|famine|food security|fertil|urea|potash|locust|pest|blight|rust|frost|heat ?wave|export ban|import ban|tariff|sanction|cyclone|hurricane|typhoon|monsoon|el ni|la ni)/;
// Maritime/inland grain chokepoints — disruptions here are high-exposure.
const CHOKEPOINT_RE = /(suez|hormuz|bosphorus|dardanelles|malacca|panama canal|kerch|bab-el-mandeb|strait)/;

// Score 0..100. Blends commodity hits, breadbasket/chokepoint region hits, an
// agricultural-category signal, severity, and — most importantly — whether the
// event matches one of the team's own enabled alert rules (explicit analyst
// intent). Pure and deterministic.
export function agRelevanceScore({ text = '', severity = 'moderate', commodities = [], regions = [], category = '', rules = [] } = {}) {
  const hay = String(text + ' ' + (category || '')).toLowerCase();
  const comm = (commodities && commodities.length) ? commodities : scanKeywords(hay, COMMODITY_KEYWORDS);
  const reg = scanKeywords(hay, REGION_KEYWORDS); // curated breadbaskets + chokepoints only
  let score = 0;
  score += Math.min(40, comm.length * 18);
  score += Math.min(24, reg.length * 12);
  if (AG_CATEGORY_RE.test(hay)) score += 16;
  if (CHOKEPOINT_RE.test(hay)) score += 10;
  score += { moderate: 4, high: 8, critical: 14 }[severity] || 4;
  if (Array.isArray(rules) && rules.some((r) => ruleMatchesText(r, hay, severity))) score += 22;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// Does an enabled team alert rule match this hazard's text + severity? Mirrors
// the server's eventMatchesRule but operates on already-flattened text so it can
// live in the pure engine.
function ruleMatchesText(rule, hay, severity) {
  if (!rule) return false;
  if ((SEVERITY_RANK[severity] || 1) < (SEVERITY_RANK[rule.min_severity] || 1)) return false;
  const cats = Array.isArray(rule.categories) ? rule.categories : [];
  if (cats.length && !cats.some((c) => hay.includes(String(c).toLowerCase()))) return false;
  const geos = Array.isArray(rule.geographies) ? rule.geographies : [];
  if (geos.length && !geos.some((g) => hay.includes(String(g).toLowerCase()))) return false;
  return true;
}

// Compute ag-relevance for an already-stored alert row (used by reconciliation).
export function alertRelevance(row, rules = []) {
  if (!row) return 0;
  const text = `${row.title || ''} ${row.category || ''} ${row.geography || ''}`;
  return agRelevanceScore({
    text,
    severity: row.severity || 'moderate',
    commodities: row.commodities || [],
    regions: row.regions || [],
    category: row.category || '',
    rules,
  });
}

// Build a MODELED projection alert from an observed hazard whose ag-relevance is
// below the observed-promotion bar but which is severe enough to warrant a
// hedged projection. Linked to the observed evidence; never claims certainty.
function modeledFromEvent(ev, observed, relevance, now) {
  const iso = new Date(now).toISOString();
  // Hedge the projection one notch below the observed hazard's severity.
  const severity = observed.severity === 'critical' ? 'high' : 'moderate';
  const confidence = computeConfidence({ basis: 'modeled', severity, sourceCount: 1, corroboration: Math.round(relevance / 25) });
  const regionLabel = (observed.regions && observed.regions[0]) || observed.geography || 'the affected region';
  const commodityLabel = (observed.commodities && observed.commodities.length) ? observed.commodities.join(', ') : 'regional agricultural output';
  return {
    key: stableId('mdl-ev', [ev.source || '', ev.id || observed.title]),
    title: `Modeled agricultural impact projection: ${String(ev.title || 'hazard').slice(0, 200)}`,
    severity,
    basis: 'modeled',
    confidence,
    horizon: observed.horizon === '24h' ? '7d' : observed.horizon,
    regions: observed.regions || [],
    commodities: observed.commodities || [],
    status: 'new',
    source: ev.source || null,
    url: ev.url || null,
    category: ev.category || null,
    geography: ev.geography || null,
    eventAt: ev.published || null,
    causalChain: [
      { step: 'observed-evidence', detail: `Observed hazard: ${String(ev.title || '').slice(0, 240)}` },
      { step: 'exposure', detail: `In/near ${regionLabel}; potential exposure to ${commodityLabel}.`.slice(0, 300) },
      { step: 'projection', detail: `Ag-relevance ${relevance}/100 crossed the modeled threshold (${AG_MODEL_THRESHOLD}) but stayed below observed promotion (${AG_PROMOTE_THRESHOLD}).` },
    ],
    assumptions: [
      'PROJECTION — modeled potential agricultural impact of an observed hazard, NOT an observed shortfall.',
      'The underlying event is real; its downstream effect on food/agriculture is uncertain and may not materialize.',
      `Emitted as modeled (not observed) because ag-relevance ${relevance} is below the observed-promotion threshold of ${AG_PROMOTE_THRESHOLD}.`,
    ],
    createdAt: iso,
    updatedAt: iso,
    modeled: true,
    agRelevance: relevance,
  };
}

// Classify a single event into an actionable OBSERVED alert, a MODELED
// projection, or skip (stays in the Intel/live feed). Rules bias promotion
// toward what the team has explicitly said it cares about.
export function classifyEvent(ev, { now = Date.now(), rules = [] } = {}) {
  const observed = alertFromEvent(ev, { now });
  if (!observed) return { kind: 'skip', relevance: 0, reason: 'invalid' };
  const text = `${ev.title || ''} ${ev.category || ''} ${ev.geography || ''} ${ev.summary || ''}`;
  const relevance = agRelevanceScore({
    text, severity: observed.severity, commodities: observed.commodities,
    regions: observed.regions, category: ev.category, rules,
  });
  observed.agRelevance = relevance;
  if (relevance >= AG_PROMOTE_THRESHOLD) return { kind: 'observed', relevance, observed };
  if (relevance >= AG_MODEL_THRESHOLD && SEVERITY_RANK[observed.severity] >= 2) {
    return { kind: 'modeled', relevance, modeled: modeledFromEvent(ev, observed, relevance, now) };
  }
  return { kind: 'skip', relevance, observed };
}

// Relevance-gated derivation pass. Unlike deriveAlerts (which mirrors every
// event), this promotes only agriculturally-relevant observed hazards, emits
// hedged modeled projections for severe borderline hazards, folds in modeled
// crop-risk, dedupes by key, and reports what it did. This is what the alerts
// API's derive path calls.
export function deriveAlertsDetailed({ events = [], cropRisk = [], now = Date.now(), threshold = 60, rules = [] } = {}) {
  const seen = new Set();
  const alerts = [];
  const stats = { considered: 0, promotedObserved: 0, modeled: 0, skippedLowRelevance: 0 };
  for (const ev of events) {
    stats.considered++;
    const c = classifyEvent(ev, { now, rules });
    if (c.kind === 'observed') {
      if (!seen.has(c.observed.key)) { seen.add(c.observed.key); alerts.push(c.observed); stats.promotedObserved++; }
    } else if (c.kind === 'modeled') {
      if (!seen.has(c.modeled.key)) { seen.add(c.modeled.key); alerts.push(c.modeled); stats.modeled++; }
    } else {
      stats.skippedLowRelevance++;
    }
  }
  for (const a of alertsFromCropRisk(cropRisk, { now, threshold })) {
    if (!seen.has(a.key)) { seen.add(a.key); alerts.push(a); stats.modeled++; }
  }
  alerts.sort((x, y) => (SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]) || (y.confidence - x.confidence));
  return { alerts, stats };
}

// Explainability panel content for a single alert (why it fired, evidence,
// thresholds/assumptions, uncertainty, next effects, recommended decisions).
export function explainAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;
  const modeled = alert.basis === 'modeled';
  const confPct = alert.confidence != null ? Math.round(alert.confidence * 100) : null;
  const chain = Array.isArray(alert.causal_chain || alert.causalChain) ? (alert.causal_chain || alert.causalChain) : [];
  const assumptions = Array.isArray(alert.assumptions) ? alert.assumptions : [];
  return {
    label: modeled ? 'Modeled projection' : alert.basis === 'analyst' ? 'Analyst-entered signal' : 'Observed trigger',
    modeled,
    whyFired: chain.length
      ? chain.map((c) => (typeof c === 'string' ? c : `${c.step}: ${c.detail}`))
      : ['No causal chain recorded.'],
    evidence: (Array.isArray(alert.evidence) ? alert.evidence : [])
      .concat(alert.url ? [{ label: alert.source || 'source', url: alert.url }] : []),
    thresholds: modeled ? ['Composite risk index crossed operational threshold.'] : ['Direct observed report — no modeled threshold.'],
    assumptions,
    uncertainty: confPct != null
      ? `Confidence ${confPct}% — this is ${modeled ? 'a projection, not a forecast of certainty' : 'an observed signal whose downstream impact remains uncertain'}. Confidence never implies certainty.`
      : 'Confidence not quantified for this signal.',
    nextEffects: recommendNextEffects(alert),
    recommendedDecisions: recommendDecisions(alert),
  };
}

function recommendNextEffects(alert) {
  const eff = [];
  const commodities = (alert.commodities || []);
  const regions = (alert.regions || []);
  if (commodities.length) eff.push(`Potential price/supply pressure on ${commodities.join(', ')}.`);
  if (regions.length) eff.push(`Downstream exposure concentrated in ${regions.join(', ')}.`);
  if (alert.severity === 'critical') eff.push('Cross-commodity contagion plausible if unaddressed.');
  if (!eff.length) eff.push('No specific downstream effects modeled.');
  return eff;
}

function recommendDecisions(alert) {
  const d = [];
  if (SEVERITY_RANK[alert.severity] >= 2) d.push('Convene War Room review and assign an owner.');
  d.push('Acknowledge to confirm triage, or escalate to a mission if action is required.');
  if (alert.basis === 'modeled') d.push('Corroborate the modeled projection against an observed source before committing resources.');
  return d;
}

// ---------------------------------------------------------------------------
// Mission SLA clock
// ---------------------------------------------------------------------------
export function slaClock(mission, now = Date.now()) {
  if (!mission || mission.sla_minutes == null) return { hasSla: false };
  const start = mission.activated_at ? new Date(mission.activated_at).getTime() : (mission.created_at ? new Date(mission.created_at).getTime() : now);
  const budgetMs = Math.max(0, Number(mission.sla_minutes)) * 60000;
  const elapsedMs = Math.max(0, now - start);
  const remainingMs = budgetMs - elapsedMs;
  const pctElapsed = budgetMs > 0 ? Math.min(1, elapsedMs / budgetMs) : 1;
  const terminal = mission.status === 'complete' || mission.status === 'archived';
  return {
    hasSla: true,
    budgetMs,
    elapsedMs,
    remainingMs,
    pctElapsed: Math.round(pctElapsed * 100) / 100,
    breached: !terminal && remainingMs < 0,
    atRisk: !terminal && remainingMs >= 0 && pctElapsed >= 0.8,
  };
}

// ---------------------------------------------------------------------------
// Mission templates (the five named playbooks)
// ---------------------------------------------------------------------------
export const MISSION_TEMPLATES = [
  {
    key: 'chokepoint-disruption',
    name: 'Chokepoint Disruption',
    pillar: 'Secure Infrastructure',
    priority: 'high',
    slaMinutes: 720,
    objective: 'Assess and mitigate a maritime/inland chokepoint disruption affecting grain flows.',
    tasks: ['Confirm chokepoint status from observed sources', 'Quantify tonnage/route exposure', 'Identify alternate routing', 'Brief affected commodity desks'],
    gates: ['Approve reroute plan', 'Approve stakeholder notification'],
  },
  {
    key: 'crop-failure',
    name: 'Crop Failure Response',
    pillar: 'Regenerative Biology',
    priority: 'high',
    slaMinutes: 2880,
    objective: 'Respond to a projected or observed regional crop failure and its supply consequences.',
    tasks: ['Validate yield-loss estimate against ground truth', 'Model downstream price impact', 'Coordinate substitute supply', 'Prepare humanitarian contingency'],
    gates: ['Approve substitute-supply commitment'],
  },
  {
    key: 'fertilizer-shock',
    name: 'Fertilizer Shock',
    pillar: 'Coordination Layer',
    priority: 'high',
    slaMinutes: 1440,
    objective: 'Manage a fertilizer supply/price shock and its next-season yield risk.',
    tasks: ['Map exposed input dependencies', 'Assess next-season yield risk', 'Identify alternate suppliers', 'Advise affected growers'],
    gates: ['Approve procurement hedge'],
  },
  {
    key: 'humanitarian-surge',
    name: 'Humanitarian Surge',
    pillar: 'Clinical Intelligence',
    priority: 'critical',
    slaMinutes: 480,
    objective: 'Coordinate a humanitarian food-security surge for an at-risk population.',
    tasks: ['Confirm affected population + needs', 'Stage relief logistics', 'Coordinate with partner agencies', 'Establish monitoring cadence'],
    gates: ['Approve relief deployment', 'Approve partner coordination'],
  },
  {
    key: 'logistics-cyber',
    name: 'Logistics Cyber Incident',
    pillar: 'Secure Infrastructure',
    priority: 'critical',
    slaMinutes: 240,
    objective: 'Contain a cyber incident affecting agricultural logistics/OT systems.',
    tasks: ['Isolate affected systems', 'Assess operational impact', 'Activate manual fallback', 'Coordinate incident comms'],
    gates: ['Approve containment action', 'Approve public disclosure'],
  },
];

const TEMPLATE_BY_KEY = Object.fromEntries(MISSION_TEMPLATES.map((t) => [t.key, t]));

export function templateByKey(key) {
  return TEMPLATE_BY_KEY[key] || null;
}

// Produce a mission payload + task/gate seeds from a template, merging overrides
// (e.g. title/geography/source_ref from an originating alert or ATOM brief).
export function instantiateTemplate(key, overrides = {}) {
  const t = TEMPLATE_BY_KEY[key];
  if (!t) return null;
  return {
    mission: {
      title: overrides.title || t.name,
      objective: overrides.objective || t.objective,
      pillar: overrides.pillar || t.pillar,
      priority: overrides.priority || t.priority,
      status: 'proposed',
      geography: overrides.geography || null,
      sourceRef: overrides.sourceRef || null,
      slaMinutes: overrides.slaMinutes != null ? overrides.slaMinutes : t.slaMinutes,
      templateKey: t.key,
    },
    tasks: (overrides.tasks || t.tasks).map((title, i) => ({ title, sort: i, status: 'todo' })),
    gates: overrides.gates || t.gates,
  };
}

// ---------------------------------------------------------------------------
// War Room presence freshness (derived from heartbeat; never faked)
// ---------------------------------------------------------------------------
export const PRESENCE_ONLINE_MS = 60_000;   // heartbeat within 60s -> online
export const PRESENCE_AWAY_MS = 300_000;    // within 5 min -> away; older -> offline

export function presenceFreshness(lastSeenAt, now = Date.now()) {
  const t = lastSeenAt ? new Date(lastSeenAt).getTime() : 0;
  if (!t || Number.isNaN(t)) return { status: 'offline', ageMs: Infinity, label: 'offline' };
  const ageMs = Math.max(0, now - t);
  if (ageMs <= PRESENCE_ONLINE_MS) return { status: 'online', ageMs, label: 'online' };
  if (ageMs <= PRESENCE_AWAY_MS) return { status: 'away', ageMs, label: 'away' };
  return { status: 'offline', ageMs, label: 'offline' };
}

// Parse @mentions from a message body against a member roster
// ([{ id, display_name, email? }]). Returns matched user ids (deduped). Matching
// is case-insensitive on the first token of the display name, the full name, a
// dotted handle, or the email local-part (the part before '@').
export function parseMentions(body, roster = []) {
  const text = String(body || '');
  const matches = text.match(/@([a-z0-9._-]+)/gi) || [];
  if (!matches.length) return [];
  const wanted = new Set(matches.map((m) => m.slice(1).toLowerCase()));
  const ids = new Set();
  for (const m of roster) {
    if (!m || !m.id) continue;
    const name = String(m.display_name || '').toLowerCase();
    const first = name.split(/\s+/)[0] || '';
    const handle = name.replace(/\s+/g, '.');
    const localPart = String(m.email || '').toLowerCase().split('@')[0] || '';
    if (wanted.has(first) || wanted.has(handle) || wanted.has(name) || (localPart && wanted.has(localPart))) {
      ids.add(m.id);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Deterministic (AI-free) ATOM structured builders. Used as the labeled
// fallback whenever the server-side LLM path is unavailable. Every output
// carries generator:'deterministic' so the UI can badge it honestly.
// ---------------------------------------------------------------------------
function clampList(arr, n) { return (Array.isArray(arr) ? arr : []).slice(0, n); }

export function buildAlertExplanation(alert) {
  const x = explainAlert(alert) || {};
  return {
    generator: 'deterministic',
    kind: 'alert-explanation',
    title: alert && alert.title ? String(alert.title).slice(0, 200) : 'Alert',
    label: x.label,
    modeled: !!x.modeled,
    summary: x.modeled
      ? 'This is a modeled projection derived from proxy indicators. It is not a certainty and should be corroborated.'
      : 'This is an observed signal. Downstream agricultural impact remains a projection.',
    whyFired: clampList(x.whyFired, 8),
    assumptions: clampList(x.assumptions, 8),
    uncertainty: x.uncertainty,
    recommendedDecisions: clampList(x.recommendedDecisions, 6),
  };
}

export function buildMissionBrief(mission, { tasks = [], alerts = [] } = {}) {
  const m = mission || {};
  return {
    generator: 'deterministic',
    kind: 'mission-brief',
    title: m.title ? String(m.title).slice(0, 200) : 'Mission',
    objective: m.objective || '',
    pillar: m.pillar || null,
    priority: m.priority || 'medium',
    situation: [
      m.geography ? `Area of concern: ${m.geography}.` : 'No geography specified.',
      alerts.length ? `Linked to ${alerts.length} alert(s).` : 'No linked alerts.',
    ],
    objectives: clampList((tasks || []).map((t) => t.title), 12),
    keyRisks: m.priority === 'critical' || m.priority === 'high'
      ? ['Time-critical; SLA breach risk.', 'Coordination gaps across desks.']
      : ['Standard operational risk.'],
    note: 'Deterministic brief (AI unavailable) — structured from mission record, no generated speculation.',
  };
}

export function buildActionCards(context = {}) {
  const cards = [];
  const sev = context.severity || 'moderate';
  if (SEVERITY_RANK[sev] >= 2) cards.push({ action: 'escalate', label: 'Escalate to mission', rationale: 'Severity warrants coordinated action.' });
  cards.push({ action: 'acknowledge', label: 'Acknowledge', rationale: 'Confirm the signal has been triaged.' });
  if (context.basis === 'modeled') cards.push({ action: 'corroborate', label: 'Corroborate projection', rationale: 'Validate modeled projection against observed data.' });
  cards.push({ action: 'assign', label: 'Assign owner', rationale: 'Establish accountability.' });
  return { generator: 'deterministic', kind: 'action-cards', cards: clampList(cards, 6) };
}

export function buildAfterAction(mission, { tasks = [], decisions = [] } = {}) {
  const m = mission || {};
  const done = (tasks || []).filter((t) => t.status === 'done').length;
  const total = (tasks || []).length;
  return {
    generator: 'deterministic',
    kind: 'after-action',
    title: `After-action: ${m.title ? String(m.title).slice(0, 180) : 'Mission'}`,
    outcome: m.status === 'complete' ? 'completed' : m.status || 'in-progress',
    tasksCompleted: `${done}/${total}`,
    decisions: clampList((decisions || []).map((d) => `${d.gate}: ${d.decision}`), 12),
    lessons: total && done < total
      ? ['Not all tasks completed at closure — review residual actions.']
      : ['Objectives met per task ledger.'],
    note: 'Deterministic after-action summary (AI unavailable) — derived from task/decision records only.',
  };
}

// ===========================================================================
// Phase IV — geofenced breadbasket early-warning engine
// ===========================================================================
// All functions below are pure and deterministic (fixed `now` → fixed output).
// They separate OBSERVED (live signals attributed by geometry) from MODELED
// (scenario state) and ANALYST (manual) inputs, and never assert certainty:
// outputs are labeled early-warning / scenario intelligence, not prediction.

// ---------------------------------------------------------------------------
// Geometry — polygon / bbox / point-in-radius. Coordinates are [lon, lat] to
// stay GeoJSON-compatible; bbox is [west, south, east, north].
// ---------------------------------------------------------------------------
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pointInBbox(pt, bbox) {
  if (!pt || !Array.isArray(bbox) || bbox.length !== 4) return false;
  const [w, s, e, n] = bbox.map(Number);
  if ([w, s, e, n].some((v) => !Number.isFinite(v))) return false;
  const lon = Number(pt.lon);
  const lat = Number(pt.lat);
  return lon >= Math.min(w, e) && lon <= Math.max(w, e) && lat >= Math.min(s, n) && lat <= Math.max(s, n);
}

// Ray-casting point-in-polygon. `ring` is an array of [lon, lat] vertices.
export function pointInPolygon(pt, ring) {
  if (!pt || !Array.isArray(ring) || ring.length < 3) return false;
  const x = Number(pt.lon);
  const y = Number(pt.lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const denom = (yj - yi) || 1e-12;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / denom + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInGeofence(pt, geometry) {
  if (!pt || !geometry || typeof geometry !== 'object') return false;
  const lat = Number(pt.lat);
  const lon = Number(pt.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const p = { lat, lon };
  switch (geometry.type) {
    case 'bbox':
      return pointInBbox(p, geometry.bbox);
    case 'polygon':
      return pointInPolygon(p, geometry.coordinates);
    case 'point': {
      const c = geometry.center;
      if (!Array.isArray(c) || c.length !== 2) return false;
      const center = { lon: Number(c[0]), lat: Number(c[1]) };
      if (!Number.isFinite(center.lon) || !Number.isFinite(center.lat)) return false;
      const r = Number(geometry.radiusKm) || 0;
      return haversineKm(center, p) <= r;
    }
    default:
      return false;
  }
}

// Safe limits for custom zone geometry.
export const GEOFENCE_LIMITS = { maxPolygonPoints: 200, minRadiusKm: 1, maxRadiusKm: 5000 };

function lonLatInRange(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

// Validate + normalize a geometry object for persistence. Returns
// { ok:true, geometry } or { ok:false, error }.
export function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return { ok: false, error: 'geometry_required' };
  const type = geometry.type;
  if (type === 'bbox') {
    const b = geometry.bbox;
    if (!Array.isArray(b) || b.length !== 4) return { ok: false, error: 'bad_bbox' };
    const [w, s, e, n] = b.map(Number);
    if (![w, s, e, n].every(Number.isFinite)) return { ok: false, error: 'bad_bbox' };
    if (!lonLatInRange(w, s) || !lonLatInRange(e, n)) return { ok: false, error: 'bbox_out_of_range' };
    return { ok: true, geometry: { type: 'bbox', bbox: [w, s, e, n] } };
  }
  if (type === 'polygon') {
    const c = geometry.coordinates;
    if (!Array.isArray(c) || c.length < 3) return { ok: false, error: 'bad_polygon' };
    if (c.length > GEOFENCE_LIMITS.maxPolygonPoints) return { ok: false, error: 'too_many_points' };
    const ring = [];
    for (const pair of c) {
      if (!Array.isArray(pair) || pair.length !== 2) return { ok: false, error: 'bad_polygon_point' };
      const lon = Number(pair[0]);
      const lat = Number(pair[1]);
      if (!lonLatInRange(lon, lat)) return { ok: false, error: 'polygon_out_of_range' };
      ring.push([lon, lat]);
    }
    return { ok: true, geometry: { type: 'polygon', coordinates: ring } };
  }
  if (type === 'point') {
    const c = geometry.center;
    if (!Array.isArray(c) || c.length !== 2) return { ok: false, error: 'bad_center' };
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!lonLatInRange(lon, lat)) return { ok: false, error: 'center_out_of_range' };
    const r = Number(geometry.radiusKm);
    if (!Number.isFinite(r) || r < GEOFENCE_LIMITS.minRadiusKm || r > GEOFENCE_LIMITS.maxRadiusKm) {
      return { ok: false, error: 'bad_radius' };
    }
    return { ok: true, geometry: { type: 'point', center: [lon, lat], radiusKm: r } };
  }
  return { ok: false, error: 'bad_geometry_type' };
}

// ---------------------------------------------------------------------------
// Product-defined starter catalog of major breadbaskets + chokepoints. These
// are AgriOS operational watch zones for triage convenience — explicitly NOT
// official government boundary definitions (see CATALOG_DISCLAIMER). Geometry
// is coarse bbox / point-radius, derived from the app's existing region vocab.
// ---------------------------------------------------------------------------
export const CATALOG_DISCLAIMER =
  'Product-defined AgriOS operational watch zone with approximate geometry — NOT an official government or legal boundary definition.';

export const WATCH_CATALOG = [
  { slug: 'us-corn-belt', name: 'U.S. Corn Belt', kind: 'breadbasket', region: 'North America', crops: ['maize', 'soy'], geometry: { type: 'bbox', bbox: [-104, 36, -80, 49] } },
  { slug: 'black-sea-grain', name: 'Black Sea Grain Belt', kind: 'breadbasket', region: 'Black Sea', crops: ['wheat', 'maize'], geometry: { type: 'bbox', bbox: [22, 44, 56, 56] } },
  { slug: 'indo-gangetic-plain', name: 'Indo-Gangetic Plain', kind: 'breadbasket', region: 'South Asia', crops: ['wheat', 'rice'], geometry: { type: 'bbox', bbox: [70, 22, 90, 32] } },
  { slug: 'pampas', name: 'Argentine Pampas', kind: 'breadbasket', region: 'South America', crops: ['soy', 'maize', 'wheat'], geometry: { type: 'bbox', bbox: [-64, -39, -57, -31] } },
  { slug: 'brazil-cerrado', name: 'Brazil Cerrado', kind: 'breadbasket', region: 'South America', crops: ['soy', 'maize'], geometry: { type: 'bbox', bbox: [-60, -20, -45, -7] } },
  { slug: 'se-asia-rice', name: 'Southeast Asia Rice Bowl', kind: 'breadbasket', region: 'Southeast Asia', crops: ['rice'], geometry: { type: 'bbox', bbox: [98, 8, 110, 22] } },
  { slug: 'suez-canal', name: 'Suez Canal', kind: 'chokepoint', region: 'Middle East', crops: [], geometry: { type: 'point', center: [32.35, 30.5], radiusKm: 120 } },
  { slug: 'strait-of-hormuz', name: 'Strait of Hormuz', kind: 'chokepoint', region: 'Middle East', crops: [], geometry: { type: 'point', center: [56.4, 26.6], radiusKm: 130 } },
  { slug: 'bosphorus', name: 'Bosphorus / Turkish Straits', kind: 'chokepoint', region: 'Black Sea', crops: [], geometry: { type: 'point', center: [29.0, 41.1], radiusKm: 90 } },
  { slug: 'strait-of-malacca', name: 'Strait of Malacca', kind: 'chokepoint', region: 'Southeast Asia', crops: [], geometry: { type: 'point', center: [100.4, 2.5], radiusKm: 180 } },
  { slug: 'panama-canal', name: 'Panama Canal', kind: 'chokepoint', region: 'South America', crops: [], geometry: { type: 'point', center: [-79.7, 9.1], radiusKm: 110 } },
];

// Rows ready to seed as geofences for a team (pure — no DB access). Each carries
// the product-defined disclaimer in metadata so the UI/API can label it honestly.
export function catalogSeedRows() {
  return WATCH_CATALOG.map((z) => ({
    slug: z.slug,
    name: z.name,
    kind: z.kind,
    source: 'catalog',
    geometry: z.geometry,
    crops: z.crops || [],
    threats: [],
    region: z.region || null,
    notes: '',
    metadata: { disclaimer: CATALOG_DISCLAIMER, productDefined: true },
  }));
}

// ---------------------------------------------------------------------------
// Watch bands + zone scoring
// ---------------------------------------------------------------------------
export const WATCH_BANDS = ['calm', 'guarded', 'elevated', 'high', 'critical'];
export const WATCH_BAND_RANK = { calm: 0, guarded: 1, elevated: 2, high: 3, critical: 4 };

export function watchBand(score) {
  const s = Number(score) || 0;
  if (s >= 80) return 'critical';
  if (s >= 60) return 'high';
  if (s >= 40) return 'elevated';
  if (s >= 20) return 'guarded';
  return 'calm';
}

export const ZONE_DIMENSIONS = ['crop_weather', 'conflict_security', 'logistics_chokepoint', 'market_supply'];
export const ZONE_STALE_HOURS = 72;

const ZONE_DIM_PATTERNS = {
  crop_weather: /(drought|flood|inundat|harvest|planting|crop|grain|cereal|yield|frost|heat ?wave|monsoon|cyclone|hurricane|typhoon|locust|pest|blight|rust|el ni|la ni|rainfall|dry spell|famine)/,
  conflict_security: /(conflict|war|attack|military|missile|strike|shelling|unrest|coup|insurg|sanction|blockade|security|militia|violence)/,
  logistics_chokepoint: /(suez|hormuz|bosphorus|dardanelles|malacca|panama|kerch|bab-el-mandeb|strait|port|rail|shipping|freight|logistic|canal|export ban|import ban|vessel|congestion)/,
  market_supply: /(price|supply|shortage|stock|inventory|market|tariff|trade|reserve|demand|cost|hoarding)/,
};

function attributeEventToZone(zone, ev) {
  const lat = Number(ev.lat);
  const lon = Number(ev.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && zone.geometry) {
    if (pointInGeofence({ lat, lon }, zone.geometry)) return true;
  }
  const hay = `${ev.geography || ''} ${ev.title || ''} ${ev.summary || ''}`.toLowerCase();
  const needles = [zone.name, zone.region].filter(Boolean).map((s) => String(s).toLowerCase());
  return needles.some((n) => n.length > 3 && hay.includes(n));
}

// Score one zone from OBSERVED events + MODELED scenario + ANALYST inputs.
// Deterministic. Returns a full snapshot object (score/band/trend/dimensions/
// provenance/evidence/assumptions/confidence/freshness/stale/explanation).
export function scoreZone(zone, {
  events = [], scenario = null, analystInputs = [], now = Date.now(), previous = null, staleHours = ZONE_STALE_HOURS,
} = {}) {
  const z = zone || {};
  const dims = { crop_weather: 0, conflict_security: 0, logistics_chokepoint: 0, market_supply: 0, freshness_confidence: 0 };
  const observed = [];
  const evidence = [];
  let freshestAgeH = Infinity;
  const zoneCrops = (z.crops || []).map((s) => String(s).toLowerCase());

  for (const ev of (events || [])) {
    if (!ev || typeof ev !== 'object') continue;
    if (!attributeEventToZone(z, ev)) continue;
    const sev = SEVERITIES.includes(ev.severity) ? ev.severity : 'moderate';
    const sevBonus = { moderate: 0, high: 12, critical: 24 }[sev];
    const hay = `${ev.title || ''} ${ev.category || ''} ${ev.summary || ''} ${ev.geography || ''}`.toLowerCase();
    let matchedDim = false;
    for (const d of ZONE_DIMENSIONS) {
      if (ZONE_DIM_PATTERNS[d].test(hay)) {
        let inc = 18 + sevBonus;
        if (d === 'logistics_chokepoint' && z.kind === 'chokepoint') inc += 10;
        if (d === 'crop_weather' && zoneCrops.some((c) => hay.includes(c))) inc += 8;
        dims[d] = Math.min(100, dims[d] + inc);
        matchedDim = true;
      }
    }
    if (!matchedDim) {
      dims.crop_weather = Math.min(100, dims.crop_weather + 6 + sevBonus);
    }
    const at = ev.published ? new Date(ev.published).getTime() : NaN;
    if (Number.isFinite(at)) {
      const ageH = Math.max(0, (now - at) / 3_600_000);
      if (ageH < freshestAgeH) freshestAgeH = ageH;
    }
    observed.push({ title: String(ev.title || '').slice(0, 200), source: ev.source || null, severity: sev });
    if (evidence.length < 8) {
      evidence.push({ title: String(ev.title || '').slice(0, 200), url: ev.url || null, source: ev.source || null, at: ev.published || null });
    }
  }

  // MODELED — scenario pressure (projection, not observed).
  const modeled = [];
  if (scenario && typeof scenario === 'object') {
    const intensity = Math.max(0, Math.min(100, Number(scenario.intensity) || 0));
    const threat = String(scenario.threat || '').toLowerCase();
    let dim = 'crop_weather';
    if (/conflict|war|security/.test(threat)) dim = 'conflict_security';
    else if (/logistic|chokepoint|port|ship/.test(threat)) dim = 'logistics_chokepoint';
    else if (/price|market|supply|trade/.test(threat)) dim = 'market_supply';
    dims[dim] = Math.min(100, dims[dim] + Math.round(intensity * 0.3));
    modeled.push({ threat: scenario.threat || 'scenario', intensity, dimension: dim, note: 'Modeled scenario pressure — projection, not an observed signal.' });
  }

  // ANALYST — manual inputs.
  const analyst = [];
  for (const a of (analystInputs || [])) {
    if (!a || typeof a !== 'object') continue;
    const d = ZONE_DIMENSIONS.includes(a.dimension) ? a.dimension : null;
    const val = Math.max(0, Math.min(100, Number(a.score) || 0));
    if (d) dims[d] = Math.min(100, dims[d] + Math.round(val * 0.5));
    analyst.push({ dimension: a.dimension || null, score: val, note: String(a.note || '').slice(0, 200) });
  }

  // Freshness / confidence.
  const hasSignal = observed.length > 0;
  const freshnessHours = Number.isFinite(freshestAgeH) ? Math.round(freshestAgeH * 10) / 10 : null;
  const stale = !hasSignal || (freshnessHours != null && freshnessHours > staleHours);
  let freshnessConf;
  if (!hasSignal) freshnessConf = 10;
  else if (freshnessHours == null) freshnessConf = 40;
  else freshnessConf = Math.max(5, Math.min(100, Math.round(100 - freshnessHours * (90 / staleHours))));
  dims.freshness_confidence = freshnessConf;

  const weights = z.kind === 'chokepoint'
    ? { crop_weather: 0.15, conflict_security: 0.2, logistics_chokepoint: 0.45, market_supply: 0.2 }
    : z.kind === 'breadbasket'
      ? { crop_weather: 0.45, conflict_security: 0.2, logistics_chokepoint: 0.15, market_supply: 0.2 }
      : { crop_weather: 0.3, conflict_security: 0.25, logistics_chokepoint: 0.2, market_supply: 0.25 };
  let threatScore = 0;
  for (const d of ZONE_DIMENSIONS) threatScore += dims[d] * weights[d];
  const score = Math.max(0, Math.min(100, Math.round(threatScore)));
  const band = watchBand(score);

  const provCount = observed.length + modeled.length + analyst.length;
  let confidence = 0.2 + Math.min(0.4, provCount * 0.1) + (freshnessConf / 100) * 0.3;
  if (!hasSignal) confidence = Math.min(confidence, 0.35);
  confidence = Math.round(Math.min(0.9, Math.max(0.1, confidence)) * 100) / 100;

  let delta = 0;
  let trend = 'steady';
  if (previous && typeof previous.score === 'number') {
    delta = score - previous.score;
    trend = delta >= 5 ? 'rising' : delta <= -5 ? 'falling' : 'steady';
  }

  const assumptions = [
    'Early-warning watch score — scenario intelligence, NOT a deterministic prediction of a future event.',
    'Blends OBSERVED live signals attributed to this zone with MODELED scenario state and ANALYST inputs; provenance is kept separate below.',
    hasSignal
      ? `Freshest supporting signal is ~${freshnessHours}h old (${observed.length} signal(s) attributed).`
      : 'No live signals currently attributed to this zone; score reflects modeled/analyst inputs only.',
  ];
  if (stale) {
    assumptions.push(`STALE DATA WARNING — freshest signal exceeds the ${staleHours}h freshness window; treat with reduced confidence.`);
  }

  const explanation = `${z.name || 'Zone'}: watch score ${score}/100 (${band}). `
    + `Exposure — crop/weather ${dims.crop_weather}, conflict/security ${dims.conflict_security}, `
    + `logistics/chokepoint ${dims.logistics_chokepoint}, market/supply ${dims.market_supply}. `
    + `Confidence ${Math.round(confidence * 100)}%${stale ? ' (stale data)' : ''}.`;

  return {
    score,
    band,
    trend,
    delta,
    dimensions: dims,
    provenance: { observed, modeled, analyst },
    evidence,
    assumptions,
    confidence,
    freshnessHours,
    stale,
    explanation,
    generatedAt: new Date(now).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Alert policy matching, quiet hours, dedupe / cooldown
// ---------------------------------------------------------------------------
export function inQuietHours(quiet, now = Date.now()) {
  if (!quiet || typeof quiet !== 'object') return false;
  if (quiet.start == null || quiet.end == null) return false;
  const s = Number(quiet.start);
  const e = Number(quiet.end);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return false;
  const tzOffsetMin = Number(quiet.tzOffsetMinutes) || 0;
  const d = new Date(now + tzOffsetMin * 60000);
  const h = d.getUTCHours();
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // wraps midnight
}

export function policyMatchesSnapshot(policy, snapshot, { zoneId = null } = {}) {
  if (!policy || !policy.enabled) return false;
  if (!snapshot) return false;
  if ((WATCH_BAND_RANK[snapshot.band] || 0) < (WATCH_BAND_RANK[policy.min_band] || 0)) return false;
  const gz = Array.isArray(policy.geofence_ids) ? policy.geofence_ids : [];
  if (gz.length && zoneId && !gz.includes(zoneId)) return false;
  const threats = Array.isArray(policy.threats) ? policy.threats : [];
  if (threats.length) {
    const dims = snapshot.dimensions || {};
    if (!threats.some((t) => (Number(dims[t]) || 0) >= 40)) return false;
  }
  return true;
}

// Stable idempotency/dedupe key for a policy+zone+band within a time bucket.
export function notificationDedupeKey({ policyId = '', zoneId = '', band = '', windowMs = 3_600_000, now = Date.now() } = {}) {
  const bucket = Math.floor(now / Math.max(1, windowMs));
  return stableId('ntf', [policyId, zoneId, band, String(bucket)]);
}

// Decide whether a matching snapshot should raise a notification, honoring
// quiet hours + cooldown + repeat semantics.
export function shouldNotify(policy, snapshot, { zoneId = null, lastNotifiedAt = null, now = Date.now() } = {}) {
  if (!policyMatchesSnapshot(policy, snapshot, { zoneId })) return { notify: false, reason: 'no_match' };
  if (inQuietHours(policy.quiet_hours, now)) return { notify: false, reason: 'quiet_hours' };
  if (lastNotifiedAt) {
    const ageMin = (now - new Date(lastNotifiedAt).getTime()) / 60000;
    const cd = Number(policy.cooldown_minutes) || 0;
    if (ageMin < cd) return { notify: false, reason: 'cooldown' };
    if (!policy.repeat) return { notify: false, reason: 'already_notified' };
  }
  return { notify: true, reason: 'match' };
}

// ---------------------------------------------------------------------------
// Notification state machine
// ---------------------------------------------------------------------------
export const NOTIFICATION_STATES = ['unread', 'read', 'acknowledged'];
const NOTIFICATION_TRANSITIONS = {
  unread: ['read', 'acknowledged'],
  read: ['acknowledged', 'unread'],
  acknowledged: ['read'],
};
export function notificationStateCanTransition(from, to) {
  return NOTIFICATION_STATES.includes(to) && canTransition(NOTIFICATION_TRANSITIONS, from, to);
}
export function notificationActionToState(action) {
  return { read: 'read', unread: 'unread', acknowledge: 'acknowledged' }[action] || null;
}

// ---------------------------------------------------------------------------
// External integrations — SSRF-safe URL validation, HMAC signing, payloads
// ---------------------------------------------------------------------------
export const INTEGRATION_KINDS = ['webhook', 'slack', 'teams', 'email'];

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return p;
}

function isPrivateOrReservedHost(host) {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (/^(fc|fd)/i.test(h)) return true;   // IPv6 ULA
  if (/^fe80/i.test(h)) return true;      // IPv6 link-local
  const p = ipv4Parts(h);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;             // link-local + cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;    // private
  if (a === 192 && b === 168) return true;             // private
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
  if (a >= 224) return true;                           // multicast / reserved
  return false;
}

// Validate an outbound webhook URL against SSRF. HTTPS-only, no
// localhost/private/link-local/reserved hosts, only the default HTTPS port.
export function validateWebhookUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (_) {
    return { ok: false, error: 'invalid_url' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'https_required' };
  const host = (u.hostname || '').toLowerCase();
  if (!host) return { ok: false, error: 'invalid_host' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, error: 'blocked_host' };
  }
  if (isPrivateOrReservedHost(host)) return { ok: false, error: 'blocked_host' };
  if (u.port && u.port !== '443') return { ok: false, error: 'blocked_port' };
  return { ok: true, url: u.toString(), host };
}

export function signWebhookPayload(bodyString, secret) {
  return createHmac('sha256', String(secret == null ? '' : secret)).update(String(bodyString)).digest('hex');
}

export function notificationIdempotencyKey({ notificationId = '', channelId = '', attempt = 1 } = {}) {
  return stableId('idem', [notificationId, channelId, String(attempt)]);
}

// Canonical outbound payload — severity, zone, provenance, evidence, mission /
// deep link, timestamp, idempotency key. Never contains secrets.
export function buildWebhookPayload(notification, { deepLink = null, now = Date.now() } = {}) {
  const n = notification || {};
  const payload = (n.payload && typeof n.payload === 'object') ? n.payload : {};
  return {
    version: 1,
    id: n.id || null,
    severity: n.band || 'elevated',
    score: n.score != null ? n.score : null,
    zone: n.geofence
      ? { id: n.geofence.id || null, name: n.geofence.name || null }
      : (payload.zone || null),
    provenance: payload.provenance || {},
    evidence: Array.isArray(payload.evidence) ? payload.evidence.slice(0, 8) : [],
    mission: n.mission_id ? { id: n.mission_id } : null,
    deepLink: deepLink || payload.deepLink || null,
    timestamp: new Date(now).toISOString(),
    idempotencyKey: n.dedupe_key || null,
  };
}

// Adapt the canonical payload to a channel wire format. Slack/Teams get a text
// summary; generic webhook gets the full JSON payload.
export function formatChannelMessage(kind, payload) {
  const p = payload || {};
  const zoneName = (p.zone && p.zone.name) || 'Zone';
  const line = `AgriOS Watch — ${String(p.severity || '').toUpperCase()} — ${zoneName} (score ${p.score == null ? 'n/a' : p.score})${p.deepLink ? ' — ' + p.deepLink : ''}`;
  if (kind === 'slack' || kind === 'teams') return { text: line };
  return p;
}

// Exponential backoff for delivery retries, capped.
export const MAX_DELIVERY_ATTEMPTS = 5;
export function nextRetryDelayMs(attempt, { base = 30_000, cap = 3_600_000 } = {}) {
  const a = Math.max(1, Number(attempt) || 1);
  return Math.min(cap, base * (2 ** (a - 1)));
}
