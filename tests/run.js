// AGRI-NEXUS collaboration layer — automated tests.
//
// These exercise the security-critical, database-independent primitives:
// password hashing/verification, opaque token generation + hashing, RBAC
// comparisons, request validation, origin/CSRF checks, and the shape of the
// SQL migration (tables, constraints, indexes, tenant scoping). They run with
// no network and no real DATABASE_URL — the pg pool is lazy, so importing the
// modules never opens a connection.
//
//   node tests/run.js   (or: npm test)

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

import { hashPassword, verifyPassword, generateToken, hashToken, safeEqual } from '../api/_crypto.js';
import {
  str, email, password, oneOf, optionalOneOf, uuid, optionalUuid, strArray,
  optionalDate, jsonObject, ValidationError,
  PILLARS, MISSION_STATUS, MISSION_PRIORITY, ROLES, SEVERITIES,
} from '../api/_validate.js';
import { roleAtLeast } from '../api/_auth.js';
import { isSameOrigin, rateLimit, parseCookies, getSessionToken } from '../api/_http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.error('  ✗ ' + name); }
}
function eq(name, a, b) { ok(name + ` (got ${JSON.stringify(a)})`, a === b); }
async function throwsValidation(name, fn) {
  try { await fn(); fail++; failures.push(name); console.error('  ✗ ' + name + ' (did not throw)'); }
  catch (e) { ok(name, e instanceof ValidationError); }
}
function section(t) { console.log('\n' + t); }

/* ============================ crypto ============================ */
async function testCrypto() {
  section('crypto: password hashing');
  const { hash, salt } = await hashPassword('correct horse battery staple');
  ok('hash is hex and 128 chars (64 bytes)', /^[0-9a-f]{128}$/.test(hash));
  ok('salt present', typeof salt === 'string' && salt.length >= 16);
  ok('never stores plaintext', hash.indexOf('correct horse') === -1);

  ok('verify accepts correct password', await verifyPassword('correct horse battery staple', hash, salt));
  ok('verify rejects wrong password', !(await verifyPassword('wrong password xxxx', hash, salt)));
  ok('verify rejects empty hash/salt', !(await verifyPassword('x', '', '')));

  const { hash: h2 } = await hashPassword('correct horse battery staple');
  ok('same password -> different hash (unique salt)', h2 !== hash);

  section('crypto: tokens');
  const t1 = generateToken(32), t2 = generateToken(32);
  ok('token is url-safe base64', /^[A-Za-z0-9_-]+$/.test(t1));
  ok('tokens are unique', t1 !== t2);
  ok('hashToken is deterministic sha256 hex', hashToken('abc') === hashToken('abc') && /^[0-9a-f]{64}$/.test(hashToken('abc')));
  ok('hashToken differs from raw', hashToken(t1) !== t1);
  ok('safeEqual true for equal', safeEqual('abc', 'abc'));
  ok('safeEqual false for unequal', !safeEqual('abc', 'abd'));
  ok('safeEqual false for length mismatch', !safeEqual('abc', 'abcd'));
}

/* ============================ RBAC ============================ */
function testRbac() {
  section('rbac: role hierarchy');
  ok('owner >= admin', roleAtLeast('owner', 'admin'));
  ok('admin >= analyst', roleAtLeast('admin', 'analyst'));
  ok('analyst >= viewer', roleAtLeast('analyst', 'viewer'));
  ok('viewer >= viewer', roleAtLeast('viewer', 'viewer'));
  ok('viewer NOT >= analyst', !roleAtLeast('viewer', 'analyst'));
  ok('analyst NOT >= admin', !roleAtLeast('analyst', 'admin'));
  ok('admin NOT >= owner', !roleAtLeast('admin', 'owner'));
  ok('unknown role has no power', !roleAtLeast('nobody', 'viewer'));
  ok('null role rejected', !roleAtLeast(null, 'viewer'));
}

/* ============================ validation ============================ */
async function testValidation() {
  section('validate: str/email/password');
  eq('str trims', str('  hi ', 'f'), 'hi');
  await throwsValidation('str required missing', () => str(undefined, 'f'));
  await throwsValidation('str too long', () => str('x'.repeat(20), 'f', { max: 5 }));
  eq('str optional returns null', str(undefined, 'f', { required: false }), null);

  eq('email lowercases', email('User@Example.COM'), 'user@example.com');
  await throwsValidation('email invalid', () => email('not-an-email'));

  eq('password ok returns value', password('0123456789'), '0123456789');
  await throwsValidation('password too short', () => password('short'));
  await throwsValidation('password non-string', () => password(12345));

  section('validate: enums');
  eq('oneOf ok', oneOf('active', MISSION_STATUS, 'status'), 'active');
  await throwsValidation('oneOf invalid', () => oneOf('nope', MISSION_STATUS, 'status'));
  eq('optionalOneOf empty -> null', optionalOneOf('', MISSION_PRIORITY, 'p'), null);
  ok('PILLARS are the four canonical pillars', PILLARS.length === 4 &&
    PILLARS.join('|') === 'Secure Infrastructure|Coordination Layer|Regenerative Biology|Clinical Intelligence');
  ok('ROLES exact set', ROLES.join(',') === 'owner,admin,analyst,viewer');
  ok('SEVERITIES exact set', SEVERITIES.join(',') === 'moderate,high,critical');

  section('validate: uuid/date/array/json');
  const u = '11111111-2222-3333-4444-555555555555';
  eq('uuid ok', uuid(u, 'id'), u);
  await throwsValidation('uuid invalid', () => uuid('123', 'id'));
  eq('optionalUuid empty -> null', optionalUuid('', 'id'), null);
  eq('strArray trims + drops empties', JSON.stringify(strArray([' a ', '', 'b'], 'c')), JSON.stringify(['a', 'b']));
  await throwsValidation('strArray non-array', () => strArray('a,b', 'c'));
  ok('optionalDate parses to ISO', optionalDate('2026-01-02', 'd').startsWith('2026-01-02'));
  await throwsValidation('optionalDate invalid', () => optionalDate('not-a-date', 'd'));
  eq('jsonObject empty -> {}', JSON.stringify(jsonObject(undefined, 'm')), '{}');
  await throwsValidation('jsonObject rejects array', () => jsonObject([1, 2], 'm'));
}

/* ============================ http / origin / rate limit ============================ */
function req(headers) { return { headers, socket: { remoteAddress: '10.0.0.1' } }; }

function testHttp() {
  section('http: same-origin (CSRF guard)');
  ok('same origin passes', isSameOrigin(req({ host: 'app.example.com', origin: 'https://app.example.com' })));
  ok('cross origin blocked', !isSameOrigin(req({ host: 'app.example.com', origin: 'https://evil.com' })));
  ok('missing origin blocked (writes require it)', !isSameOrigin(req({ host: 'app.example.com' })));
  ok('referer fallback works', isSameOrigin(req({ host: 'app.example.com', referer: 'https://app.example.com/x' })));
  ok('x-forwarded-host honored', isSameOrigin(req({ host: 'internal', 'x-forwarded-host': 'app.example.com', origin: 'https://app.example.com' })));

  section('http: cookies');
  const c = parseCookies(req({ cookie: 'agri_session=abc123; other=1' }));
  eq('parseCookies reads session', c.agri_session, 'abc123');
  eq('getSessionToken', getSessionToken(req({ cookie: 'agri_session=tok' })), 'tok');
  eq('getSessionToken empty', getSessionToken(req({})), '');

  section('http: rate limiter');
  const ip = 'ratelimit-test-' + Math.random();
  const r = req({ 'x-forwarded-for': ip });
  let last;
  for (let i = 0; i < 3; i++) last = rateLimit(r, 'login', { limit: 3, windowMs: 60000 });
  ok('within limit allowed', last.ok);
  const over = rateLimit(r, 'login', { limit: 3, windowMs: 60000 });
  ok('over limit blocked', !over.ok);
  const otherBucket = rateLimit(r, 'register', { limit: 3, windowMs: 60000 });
  ok('separate bucket unaffected', otherBucket.ok);
}

/* ============================ migration / schema ============================ */
function testMigration() {
  section('migration: schema shape + tenant scoping');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  ok('at least one migration file', files.length >= 1);
  const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n').toLowerCase();

  const tables = ['users', 'teams', 'team_members', 'sessions', 'invitations',
    'missions', 'scenarios', 'alert_rules', 'alerts', 'alert_reads', 'audit_log'];
  tables.forEach((t) => ok('creates table ' + t, sql.includes('create table if not exists ' + t)));

  ok('uses pgcrypto for gen_random_uuid', sql.includes('gen_random_uuid()'));
  ok('is idempotent (create ... if not exists)', !/create table (?!if not exists)/.test(sql));
  ok('scopes tenant data by team_id', sql.includes('team_id'));

  // Unique constraints / dedup guarantees.
  ok('unique session token hash', /unique.*token_hash|token_hash.*unique/.test(sql) || sql.includes('sessions_token_hash'));
  ok('alerts deduped per team+event', /alerts[\s\S]*unique \(team_id, event_key\)|unique \(team_id, event_key\)/.test(sql));
  ok('alert_reads composite pk', /alert_reads[\s\S]*primary key \(alert_id, user_id\)/.test(sql));

  // Foreign keys + cascade for tenant cleanup.
  ok('has foreign keys', sql.includes('references'));
  ok('cascades on delete somewhere', sql.includes('on delete cascade'));
}

/* ============================ frontend race regression ============================ */
// Regression for the boot-order race fixed in this commit: boot() renders the
// Command panel (activateMode('command') -> onCommandRendered) BEFORE the async
// AGRI_COLLAB.init()/refreshSession() resolves. On a page reload with a valid
// session cookie, the Command panel first paints its signed-out placeholder;
// refreshSession() must then re-render every collaboration surface so the
// restored session's missions/scenarios/alerts/identity actually appear.
//
// We load the real assets/collab.js browser IIFE inside a node:vm context with
// hand-rolled window/document/fetch stubs (no jsdom dependency) and assert:
//   1) with a null session, onCommandRendered() shows the placeholder and does
//      NOT fetch /api/missions;
//   2) after refreshSession() restores the session, the collaboration surfaces
//      are re-rendered from the server (missions/scenarios/alerts fetched, real
//      mission card painted, identity label + alert bell updated).

function makeEl(id) {
  const listeners = {};
  return {
    id: id || '',
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    title: '',
    value: '',
    onclick: null,
    _attrs: {},
    style: { cssText: '', setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    animate() { return { onfinish: null }; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function buildCollabSandbox() {
  const registry = {};
  const surfaces = ['#teamMissions', '#teamMissionsMeta', '#identityLabel', '#identityBtn',
    '#openAlerts', '#alertCount', '#newMissionBtn', '#scenarioHistorySection', '#scenarioHistory',
    '#simSave'];
  surfaces.forEach((s) => { registry[s] = makeEl(s); });

  const documentStub = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    querySelector(sel) { return registry[sel] || null; },
    querySelectorAll() { return []; },
    createElement() { return makeEl(); },
    getElementById(id) { return registry['#' + id] || null; },
    addEventListener() {},
  };

  const SESSION = {
    user: { id: 'u1', email: 'owner@example.com', displayName: 'Owner One' },
    activeTeamId: 't1', role: 'owner', memberships: [], csrfToken: 'csrf-1',
  };
  const MISSION = {
    id: 'm1', title: 'Restored mission', objective: 'Persisted across reload',
    priority: 'high', status: 'active', pillar: 'Secure Infrastructure',
    geography: '', assignee_id: null, created_by_name: 'Owner One',
    created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
  };

  const fetchLog = [];
  function fetchStub(path, opts) {
    fetchLog.push({ path, method: (opts && opts.method) || 'GET' });
    let body = {};
    if (path.indexOf('/api/auth?action=session') === 0) body = { authenticated: true, session: SESSION };
    else if (path.indexOf('/api/missions') === 0) body = { missions: [MISSION] };
    else if (path.indexOf('/api/scenarios') === 0) body = { scenarios: [] };
    else if (path.indexOf('/api/alerts') === 0) body = { alerts: [], unread: 0 };
    return Promise.resolve({ ok: true, status: 200, json() { return Promise.resolve(body); } });
  }

  const A = {
    esc: (s) => String(s == null ? '' : s),
    icon: () => '',
    reduced: true,
    refreshIcons() {},
    getSimSnapshot() { return null; },
    applyScenario() {},
    activateMode() {},
    openDrawer() {},
    closeDrawer() {},
    pillars: [],
    badge: () => '',
    el: () => makeEl(),
  };

  const windowStub = { AGRI_APP: A };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    fetch: fetchStub,
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'test' },
    location: { href: 'https://app.example.com/', origin: 'https://app.example.com', search: '' },
    URLSearchParams,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  return { sandbox, registry, fetchLog, windowStub };
}

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function testCollabRace() {
  section('frontend: session-restore re-render race (regression)');
  const src = readFileSync(join(ROOT, 'assets', 'collab.js'), 'utf8');
  const { sandbox, registry, fetchLog, windowStub } = buildCollabSandbox();
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'assets/collab.js' });

  const collab = windowStub.AGRI_COLLAB;
  ok('collab IIFE published window.AGRI_COLLAB', !!collab);
  ok('exposes refreshSession bridge', collab && typeof collab.refreshSession === 'function');

  // Phase 1: Command panel renders while session is still null (pre-auth boot).
  collab.onCommandRendered();
  await flush();
  ok('signed-out placeholder rendered first',
    registry['#teamMissions'].innerHTML.indexOf('Sign in to plan') !== -1);
  ok('no /api/missions fetch while signed out',
    !fetchLog.some((c) => c.path.indexOf('/api/missions') === 0));

  // Phase 2: async session resolution restores the signed-in state.
  const restored = await collab.refreshSession();
  await flush();

  ok('session resolved to authenticated', restored && restored.role === 'owner');
  ok('fetched session on refresh', fetchLog.some((c) => c.path.indexOf('/api/auth?action=session') === 0));
  ok('re-rendered team missions from server (the fix)',
    fetchLog.some((c) => c.path.indexOf('/api/missions') === 0));
  ok('re-loaded scenario history', fetchLog.some((c) => c.path.indexOf('/api/scenarios') === 0));
  ok('synced alerts for restored session', fetchLog.some((c) => c.path.indexOf('/api/alerts') === 0));

  ok('placeholder replaced by real mission card',
    registry['#teamMissions'].innerHTML.indexOf('Sign in to plan') === -1 &&
    registry['#teamMissions'].innerHTML.indexOf('Restored mission') !== -1);
  ok('identity label shows restored owner',
    registry['#identityLabel'].innerHTML.indexOf('Owner One') !== -1);
  ok('alert bell revealed for signed-in user', registry['#openAlerts'].hidden === false);
  ok('new-mission affordance revealed for owner', registry['#newMissionBtn'].hidden === false);
}

/* ============================ geospatial theater + Food War engine ============================ */
// Load the four pure, dependency-free UMD theater modules inside a node:vm
// context (same technique as the collab test) and assert dataset validity,
// filter/NL/URL semantics, simulation determinism/bounds, and the ATOM action
// allowlist. These modules attach to `window` and never touch the DOM.
function loadTheaterModules() {
  const files = ['theater-data.js', 'sim-engine.js', 'theater-filters.js', 'theater-actions.js'];
  const win = {};
  const sandbox = { window: win, module: { exports: {} }, console };
  vm.createContext(sandbox);
  files.forEach((f) => {
    const src = readFileSync(join(ROOT, 'assets', f), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'assets/' + f });
  });
  return win;
}

function testTheaterData() {
  section('theater: dataset validity + provenance');
  const D = loadTheaterModules().THEATER_DATA;
  ok('THEATER_DATA published', !!D);

  // Exactly 14 Chatham House chokepoints: 8 maritime, 3 coastal, 3 inland.
  eq('14 chokepoints total', D.CHOKEPOINTS.length, 14);
  const byCat = { maritime: 0, coastal: 0, inland: 0 };
  D.CHOKEPOINTS.forEach((c) => { byCat[c.category] = (byCat[c.category] || 0) + 1; });
  eq('8 maritime chokepoints', byCat.maritime, 8);
  eq('3 coastal chokepoints', byCat.coastal, 3);
  eq('3 inland chokepoints', byCat.inland, 3);

  // Unique ids across all point entities.
  const ids = {};
  let dup = false;
  D.NODES.forEach((n) => { if (ids[n.id]) dup = true; ids[n.id] = true; });
  ok('all node ids unique', !dup);
  ok('NODE_BY_ID indexes every node', D.NODES.every((n) => D.NODE_BY_ID[n.id] === n));

  // Coordinates within valid ranges.
  const coordsOk = D.NODES.every((n) => n.lat >= -90 && n.lat <= 90 && n.lng >= -180 && n.lng <= 180);
  ok('all coordinates in range', coordsOk);

  // Severity values are from the known set.
  const sevOk = D.NODES.every((n) => D.SEVERITY_ORDER[n.severity] != null);
  ok('all severities known', sevOk);

  // Observed structural nodes carry cited http(s) provenance.
  const provOk = D.NODES.filter((n) => n.observed).every((n) => Array.isArray(n.sources) && n.sources.length &&
    n.sources.every((s) => /^https?:\/\//.test(s.url)));
  ok('observed nodes cite http(s) sources', provOk);

  // Chatham House provenance URLs incorporated.
  ok('Chatham House report source present',
    D.SOURCES.chatham_report && D.SOURCES.chatham_report.url.indexOf('chathamhouse.org') !== -1);
  ok('Chatham House chapter source present',
    D.SOURCES.chatham_ch2 && D.SOURCES.chatham_ch2.url.indexOf('chathamhouse.org') !== -1);
  ok('FAO crop calendar source present',
    D.SOURCES.fao_cropcal && D.SOURCES.fao_cropcal.url.indexOf('fao.org') !== -1);

  // Routes: modeled proxies, referential integrity on from/to/via.
  const routeRefOk = D.ROUTES.every((r) => D.NODE_BY_ID[r.from] && D.NODE_BY_ID[r.to] &&
    (r.via || []).every((v) => D.NODE_BY_ID[v] && D.NODE_BY_ID[v].kind === 'chokepoint'));
  ok('routes reference known nodes + chokepoint via', routeRefOk);
  ok('all routes are modeled (observed=false)', D.ROUTES.every((r) => r.observed === false));

  // Observed-vs-modeled separation: chokepoints are observed structural facts.
  ok('chokepoints are observed', D.CHOKEPOINTS.every((c) => c.observed === true));
  eq('five commodities', D.COMMODITIES.length, 5);
}

function testTheaterFilters() {
  section('theater: filters + NL parser + shareable URL state');
  const win = loadTheaterModules();
  const F = win.THEATER_FILTERS, D = win.THEATER_DATA;
  ok('THEATER_FILTERS published', !!F);

  // AND across dimensions, OR within a dimension.
  const wheatCrit = F.applyFilters(D.NODES, D.ROUTES, { layers: ['chokepoint'], commodity: ['wheat'], severity: ['critical'] });
  ok('AND/OR filter returns only matching chokepoints',
    wheatCrit.nodes.length > 0 && wheatCrit.nodes.every((n) => n.kind === 'chokepoint' && n.severity === 'critical' &&
      (n.commodities || []).indexOf('wheat') !== -1));
  const allNodes = F.applyFilters(D.NODES, D.ROUTES, {});
  eq('empty filter returns all nodes', allNodes.nodes.length, D.NODES.length);

  // Deterministic NL parser.
  const nl1 = F.parseNL('wheat chokepoints exposed to conflict');
  ok('NL maps wheat -> commodity', nl1.state.commodity.indexOf('wheat') !== -1);
  ok('NL maps conflict -> critical severity', nl1.state.severity.indexOf('critical') !== -1);
  ok('NL maps chokepoints -> layer', nl1.state.layers.indexOf('chokepoint') !== -1);
  ok('NL reports understoodAny', nl1.understoodAny === true);
  const nl2 = F.parseNL('fertilizer routes through Suez');
  ok('NL maps fertilizer + routes', nl2.state.commodity.indexOf('fertilizer') !== -1 && nl2.state.layers.indexOf('routes') !== -1);
  ok('NL routes unknown place to region', nl2.state.region.indexOf('suez') !== -1);
  ok('NL stopword-only understoodAny=false', F.parseNL('the of and').understoodAny === false);

  // URL serialize/parse round-trip.
  const state = { layers: ['chokepoint'], commodity: ['wheat'], severity: ['critical'], category: [], evidence: [], region: 'suez', sel: 'cp-suez' };
  const round = F.parseState(F.serializeState(state));
  ok('URL round-trip preserves layers', round.layers.join(',') === 'chokepoint');
  ok('URL round-trip preserves commodity', round.commodity.join(',') === 'wheat');
  ok('URL round-trip preserves region', round.region === 'suez');
  ok('URL round-trip preserves selection', round.sel === 'cp-suez');

  // Password must NEVER be accepted from or emitted to the URL.
  const injected = F.parseState('password=PutinSucksTinyChinaCocks&pw=x&gate=y&layers=chokepoint');
  ok('parseState drops password/pw/gate keys',
    injected.password === undefined && injected.pw === undefined && injected.gate === undefined && injected.layers.join(',') === 'chokepoint');
  const serialized = F.serializeState({ layers: ['chokepoint'], password: 'PutinSucksTinyChinaCocks', pw: 'x' });
  ok('serializeState never emits password', serialized.indexOf('password') === -1 && serialized.indexOf('PutinSucks') === -1 && serialized.indexOf('pw=') === -1);

  // Sim descriptor round-trips (compact, no secrets).
  const simState = { layers: [], commodity: [], severity: [], category: [], evidence: [], sim: { preset: 'suez-closure', intensity: 4, commodities: ['wheat', 'maize'], interventions: ['reroute'] } };
  const simRound = F.parseState(F.serializeState(simState));
  ok('URL round-trip preserves sim preset', simRound.sim && simRound.sim.preset === 'suez-closure');
  ok('URL round-trip preserves sim commodities', simRound.sim && simRound.sim.commodities.join(',') === 'wheat,maize');
}

function testSimEngine() {
  section('theater: Food War simulation engine');
  const SIM = loadTheaterModules().SIM_ENGINE;
  ok('SIM_ENGINE published', !!SIM);
  ok('8 presets', SIM.PRESETS.length === 8);
  ok('6 interventions', SIM.INTERVENTIONS.length === 6);

  const params = { preset: 'blacksea-blockade' };
  const a = SIM.runSim(params), b = SIM.runSim(params);
  ok('runSim is deterministic', JSON.stringify(a.timeline) === JSON.stringify(b.timeline));

  // Timeline bounds: day 0..180 inclusive.
  eq('timeline length 181', a.timeline.length, 181);
  eq('timeline starts day 0', a.timeline[0].day, 0);
  eq('timeline ends day 180', a.timeline[180].day, 180);

  // KPI ranges stay within modeled bounds every day.
  const boundsOk = a.timeline.every((k) => k.routeCapacity >= 5 && k.routeCapacity <= 100 &&
    k.confidence >= 30 && k.confidence <= 90 && k.pricePressure >= 100 && k.pricePressure <= 400 &&
    k.reserveBuffer >= 0 && k.humanitarianCaseload >= 0);
  ok('all KPIs within bounds across horizon', boundsOk);

  // Intervention overlay produces a non-zero delta vs baseline.
  const withIv = SIM.runSim({ preset: 'blacksea-blockade', interventions: ['release-reserves', 'reroute'] });
  const anyDelta = ['routeCapacity', 'pricePressure', 'reserveBuffer', 'humanitarian', 'exposed'].some((k) => withIv.deltas[k] !== 0);
  ok('interventions yield a non-zero baseline delta', anyDelta);
  ok('baseline (no interventions) has zero self-delta',
    ['routeCapacity', 'pricePressure', 'reserveBuffer'].every((k) => a.deltas[k] === 0));

  // Parameter clamping.
  eq('normalizeParams clamps intensity high', SIM.normalizeParams({ intensity: 99 }).intensity, 5);
  eq('normalizeParams clamps intensity low', SIM.normalizeParams({ intensity: -4 }).intensity, 1);
  eq('normalizeParams clamps duration to horizon', SIM.normalizeParams({ duration: 9999 }).duration, SIM.HORIZON);

  // Model card labels this as exploration, not prediction.
  ok('model card disclaims forecast', /not a (prediction|forecast)/i.test(a.modelCard));
  ok('event log is non-empty + ordered', a.eventLog.length > 0 &&
    a.eventLog.every((e, i) => i === 0 || a.eventLog[i - 1].day <= e.day));
}

function testTheaterActions() {
  section('theater: ATOM action allowlist + validation');
  const win = loadTheaterModules();
  const ACT = win.THEATER_ACTIONS, D = win.THEATER_DATA;
  ok('THEATER_ACTIONS published', !!ACT);

  const ctx = { nodeIds: D.NODE_BY_ID };

  ok('rejects non-allowlisted action', ACT.validateAction({ type: 'exec-shell', cmd: 'rm -rf /' }).ok === false);
  ok('rejects non-object', ACT.validateAction(null).ok === false);

  const sl = ACT.validateAction({ type: 'select-layers', layers: ['chokepoint', 'bogus', 'routes'] });
  ok('select-layers filters to valid layers', sl.ok === true && sl.args.layers.join(',') === 'chokepoint,routes');
  ok('select-layers with no valid layers rejected', ACT.validateAction({ type: 'select-layers', layers: ['bogus'] }).ok === false);

  ok('fly-to rejects bad coordinates', ACT.validateAction({ type: 'fly-to', lat: 999, lng: 0 }).ok === false);
  ok('fly-to accepts valid coordinates', ACT.validateAction({ type: 'fly-to', lat: 10, lng: 20 }).ok === true);
  ok('fly-to accepts known nodeId', ACT.validateAction({ type: 'fly-to', nodeId: 'cp-suez' }, ctx).ok === true);
  ok('fly-to rejects unknown nodeId', ACT.validateAction({ type: 'fly-to', nodeId: 'cp-nope' }, ctx).ok === false);

  ok('focus-chokepoint rejects unknown node', ACT.validateAction({ type: 'focus-chokepoint', nodeId: 'zzz' }, ctx).ok === false);
  ok('focus-chokepoint accepts known node', ACT.validateAction({ type: 'focus-chokepoint', nodeId: 'cp-turkish' }, ctx).ok === true);

  const rs = ACT.validateAction({ type: 'run-scenario', intensity: 99, duration: 9999, propagation: 42 });
  ok('run-scenario clamps intensity/duration/propagation',
    rs.ok === true && rs.args.intensity === 5 && rs.args.duration === 180 && rs.args.propagation === 5);

  ok('compare-intervention needs interventions', ACT.validateAction({ type: 'compare-intervention', interventions: [] }).ok === false);
  ok('create-mission needs a title', ACT.validateAction({ type: 'create-mission', objective: 'x' }).ok === false);

  // Fenced block parsing: validated + rejected split, never throws.
  const good = ACT.parseAtomActions('Here is the plan.\n```atom-actions\n{"actions":[{"type":"fly-to","nodeId":"cp-suez"},{"type":"exec-shell"}]}\n```\nDone.', ctx);
  ok('parseAtomActions extracts valid actions', good.actions.length === 1 && good.actions[0].type === 'fly-to');
  ok('parseAtomActions collects rejected', good.rejected.length === 1);
  ok('parseAtomActions strips the fenced block from text', good.text.indexOf('atom-actions') === -1 && good.text.indexOf('Here is the plan') !== -1);
  let threw = false;
  let bad;
  try { bad = ACT.parseAtomActions('```atom-actions\n{not valid json}\n```'); } catch (e) { threw = true; }
  ok('parseAtomActions never throws on invalid JSON', !threw && bad.actions.length === 0 && bad.rejected.length === 1);
  ok('parseAtomActions no block -> empty actions', ACT.parseAtomActions('just prose, no actions').actions.length === 0);
}

/* ============================ run ============================ */
(async function main() {
  console.log('AGRI-NEXUS collaboration test suite');
  try {
    await testCrypto();
    testRbac();
    await testValidation();
    testHttp();
    testMigration();
    await testCollabRace();
    testTheaterData();
    testTheaterFilters();
    testSimEngine();
    testTheaterActions();
  } catch (e) {
    console.error('\nFATAL: test harness threw:', e && e.message);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.error('Failing: ' + failures.join('; ')); process.exit(1); }
  process.exit(0);
})();
