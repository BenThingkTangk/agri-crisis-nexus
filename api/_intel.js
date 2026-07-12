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
// ([{ id, display_name }]). Returns matched user ids (deduped). Matching is
// case-insensitive on the first token of the display name or the full name.
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
    if (wanted.has(first) || wanted.has(handle) || wanted.has(name)) ids.add(m.id);
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
