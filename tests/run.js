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
import {
  SEVERITY_LEVELS, severityFromLevel, severityFromScale, severityScore,
  normalizeEvent, isValidEvent, dedupeEvents, aggregateStatus,
  withRetry, mapLimit, resetBreakers, cacheClear, breakerFailure, breakerAllows,
  SOURCES, isFillValue, FILL_SENTINELS,
} from '../api/_sources.js';
import { aggregate, clearSnapshots, recordSnapshot, getSnapshots } from '../api/_aggregate.js';
import { gdacs, usgs, worldbank, power, nass, parseNassValue, ADAPTERS } from '../api/_adapters.js';
import {
  loadUsers, authenticate, signSession, verifySession, resolveAccount,
  accountRoleAtLeast, bearerToken, revokeToken, clearRevocations,
  ACCOUNT_ROLES, DEFAULT_TTL_MS, MAX_TTL_MS, SCRYPT_PARAMS,
} from '../api/_accounts.js';
import accountHandler from '../api/account.js';
import { scryptSync, randomBytes, createHmac } from 'node:crypto';

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
  const files = ['theater-data.js', 'sim-engine.js', 'theater-filters.js', 'theater-actions.js', 'theater-globe.js'];
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
  const injected = F.parseState('password=FuckPutin&pw=x&gate=y&layers=chokepoint');
  ok('parseState drops password/pw/gate keys',
    injected.password === undefined && injected.pw === undefined && injected.gate === undefined && injected.layers.join(',') === 'chokepoint');
  const serialized = F.serializeState({ layers: ['chokepoint'], password: 'FuckPutin', pw: 'x' });
  ok('serializeState never emits password', serialized.indexOf('password') === -1 && serialized.indexOf('FuckPutin') === -1 && serialized.indexOf('pw=') === -1);

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

/* ============================ theater globe (renderer/telemetry/motion) ======= */
// The globe upgrade's decision logic lives in the DOM-free assets/theater-globe.js
// so it is testable exactly like the other theater modules. We assert renderer
// selection + guaranteed fallback, reduced-motion auto-rotation disabling,
// telemetry labels/values, deterministic starfield, and the arc colour ramp.
// A second block reads assets/theater.js as source to prove the DOM-side wiring
// (renderer selection call, telemetry HUD, controls, reduced-motion gating).
function testTheaterGlobe() {
  section('theater: globe renderer selection + fallback');
  const win = loadTheaterModules();
  const GB = win.THEATER_GLOBE;
  ok('THEATER_GLOBE published', !!GB);

  const webgl = GB.selectRenderer({ canvas2d: true, webgl: true, reducedMotion: false });
  ok('bundled WebGL available -> webgl renderer', webgl.renderer === 'webgl' && webgl.degraded === false);
  const canvas = GB.selectRenderer({ canvas2d: true, webgl: false, reducedMotion: false });
  ok('no bundled WebGL -> enhanced canvas-2D renderer', canvas.renderer === 'canvas2d' && canvas.degraded === false);
  const table = GB.selectRenderer({ canvas2d: false });
  ok('no canvas at all -> guaranteed table fallback', table.renderer === 'table' && table.degraded === true);
  ok('every renderer selection carries a visible status', !!webgl.status && !!canvas.status && !!table.status);
  ok('selectRenderer never throws on empty caps', (function () { try { return typeof GB.selectRenderer().renderer === 'string'; } catch (e) { return false; } })());

  ok('detectWebGLContext false when factory returns non-canvas', GB.detectWebGLContext(() => ({})) === false);
  ok('detectWebGLContext false and never throws on throwing factory',
    GB.detectWebGLContext(() => { throw new Error('no'); }) === false);
  ok('detectWebGLContext true when a context is obtainable',
    GB.detectWebGLContext(() => ({ getContext: (t) => (t === 'webgl' ? {} : null) })) === true);

  section('theater: reduced-motion auto-rotation disabling');
  ok('auto-rotate enabled when motion allowed', GB.autoRotateEnabled(false) === true);
  ok('auto-rotate disabled under reduced motion', GB.autoRotateEnabled(true) === false);
  ok('reduced-motion selection sets autoRotate=false',
    GB.selectRenderer({ canvas2d: true, webgl: false, reducedMotion: true }).autoRotate === false);
  ok('reduced-motion webgl selection also sets autoRotate=false',
    GB.selectRenderer({ canvas2d: true, webgl: true, reducedMotion: true }).autoRotate === false);
  eq('autoRotateStep is exactly zero under reduced motion', GB.autoRotateStep(true, 16), 0);
  ok('autoRotateStep positive when motion allowed', GB.autoRotateStep(false, 16) > 0);
  ok('autoRotateStep scales with frame delta', GB.autoRotateStep(false, 32) > GB.autoRotateStep(false, 16));
  ok('autoRotateStep clamps huge deltas (no runaway spin)',
    GB.autoRotateStep(false, 100000) === GB.autoRotateStep(false, 100));

  section('theater: corner telemetry labels + values');
  eq('telemetry labels are the five operational fields',
    GB.TELEMETRY_LABELS.join(','), 'Region,Live sources,Routes,Events,Updated');
  const rows = GB.buildTelemetry({ region: 'Suez', sourcesLive: 7, sourcesTotal: 10, routes: 23, events: 41, updatedMs: 1000, nowMs: 6000 });
  eq('telemetry row order matches labels',
    rows.map((r) => r.label).join(','), GB.TELEMETRY_LABELS.join(','));
  eq('telemetry region value', rows[0].value, 'Suez');
  eq('telemetry live/total value', rows[1].value, '7/10');
  eq('telemetry routes value', rows[2].value, '23');
  eq('telemetry events value', rows[3].value, '41');
  eq('telemetry updated renders relative age', rows[4].value, '5s ago');
  const empty = GB.buildTelemetry({});
  eq('telemetry defaults region to Global', empty[0].value, 'Global');
  eq('telemetry defaults updated to em-dash', empty[4].value, '—');
  eq('telemetry honors explicit updatedText (bundled)',
    GB.buildTelemetry({ updatedText: 'bundled' })[4].value, 'bundled');
  eq('formatAge minutes', GB.formatAge(120000), '2m ago');
  eq('formatAge hours', GB.formatAge(7200000), '2h ago');

  section('theater: deterministic starfield + arc colour ramp');
  const s1 = GB.starfield(1337, 50, 800, 500);
  const s2 = GB.starfield(1337, 50, 800, 500);
  eq('starfield count honored', s1.length, 50);
  ok('starfield is deterministic for a seed', JSON.stringify(s1) === JSON.stringify(s2));
  ok('starfield differs across seeds', JSON.stringify(GB.starfield(42, 50, 800, 500)) !== JSON.stringify(s1));
  ok('all stars within canvas bounds', s1.every((p) => p.x >= 0 && p.x <= 800 && p.y >= 0 && p.y <= 500 && p.a > 0));
  ok('arcColor near end is cyan-ish', /^rgb\(95,179,196\)$/.test(GB.arcColor(0)));
  ok('arcColor far end is emerald-ish', /^rgb\(74,222,150\)$/.test(GB.arcColor(1)));
  ok('arcColor clamps out-of-range input', GB.arcColor(9) === GB.arcColor(1) && GB.arcColor(-9) === GB.arcColor(0));

  section('theater: globe DOM wiring (assets/theater.js source)');
  const tsrc = readFileSync(join(ROOT, 'assets', 'theater.js'), 'utf8');
  ok('consumes THEATER_GLOBE', tsrc.indexOf('window.THEATER_GLOBE') !== -1 && /GB\s*=\s*window\.THEATER_GLOBE/.test(tsrc));
  ok('performs renderer selection with fallback', tsrc.indexOf('selectRenderer') !== -1 && tsrc.indexOf("renderer !== 'table'") !== -1);
  ok('renders a visible non-alarm renderer status', tsrc.indexOf('data-testid="theater-render-status"') !== -1);
  ok('renders corner telemetry HUD', tsrc.indexOf('data-testid="theater-telemetry"') !== -1 && tsrc.indexOf('updateTelemetry') !== -1);
  ok('adds an auto-rotation control', tsrc.indexOf('data-testid="th-rotate"') !== -1);
  ok('auto-rotation is gated by reduced motion', /if\s*\(REDUCED\)\s*return;\s*\/\/ reduced-motion never auto-rotates/.test(tsrc));
  ok('idle auto-rotation drives rotLng via autoRotateStep', tsrc.indexOf('autoRotateStep') !== -1 && tsrc.indexOf('st.rotLng +=') !== -1);
  ok('needsRaf accounts for autoRotate', /needsRaf[\s\S]*autoRotate/.test(tsrc));
  ok('draws starfield + procedural land + atmospheric halo', ['drawStarfield', 'drawLand', 'halo'].every((k) => tsrc.indexOf(k) !== -1));
  ok('preserves existing controls (zoom/home/toggle/compass)',
    ['data-testid="th-zoom-in"', 'data-testid="th-home"', 'data-testid="th-toggle"', 'data-testid="th-compass"'].every((k) => tsrc.indexOf(k) !== -1));
  ok('preserves canvas fallback data table', tsrc.indexOf('data-testid="theater-fallback"') !== -1);
}

/* ============================ ingestion pipeline ============================ */
// A fake fetch that serves canned JSON per-URL substring, records calls, and
// can simulate failures/timeouts — keeps adapter tests fully deterministic.
function fakeFetch(routes) {
  return async function (url) {
    for (const key of Object.keys(routes)) {
      if (url.indexOf(key) !== -1) {
        const r = routes[key];
        if (r === 'throw') throw new Error('network');
        return {
          ok: true, status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify(r),
        };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
  };
}
const noSleep = () => Promise.resolve();

function testSeverity() {
  section('ingestion: deterministic severity mapping');
  eq('levels ordered', SEVERITY_LEVELS.join(','), 'stable,moderate,high,critical');
  eq('famine -> critical', severityFromLevel('Famine declared'), 'critical');
  eq('orange -> high', severityFromLevel('Orange'), 'high');
  eq('yellow -> moderate', severityFromLevel('yellow watch'), 'moderate');
  eq('green -> stable', severityFromLevel('green/normal'), 'stable');
  eq('unknown -> moderate', severityFromLevel('qwerty'), 'moderate');
  eq('scale below first -> stable', severityFromScale(1, [4.5, 5.5, 6.5]), 'stable');
  eq('scale mid -> high', severityFromScale(6, [4.5, 5.5, 6.5]), 'high');
  eq('scale top -> critical', severityFromScale(7, [4.5, 5.5, 6.5]), 'critical');
  eq('scale NaN -> moderate', severityFromScale('x', [1, 2, 3]), 'moderate');
  ok('score monotonic', severityScore('critical') > severityScore('high') &&
    severityScore('high') > severityScore('moderate') && severityScore('moderate') > severityScore('stable'));
}

function testNormalize() {
  section('ingestion: normalizeEvent schema + provenance');
  const e = normalizeEvent({
    rawId: '42', domain: 'hazard', category: 'Flood', title: 'Flood in X',
    severity: 'orange', geography: 'Country X', lat: 10, lon: 20,
    published: '2026-01-02T00:00:00Z', confidence: 0.9, value: 3, unit: 'm',
  }, { sourceId: 'gdacs', fetchedAt: '2026-01-03T00:00:00Z' });
  eq('id is sourceId:rawId', e.id, 'gdacs:42');
  eq('source name resolved from registry', e.source, 'GDACS');
  eq('severity mapped from word', e.severity, 'high');
  eq('observedAt from published', e.observedAt, '2026-01-02T00:00:00.000Z');
  eq('fetchedAt preserved', e.fetchedAt, '2026-01-03T00:00:00Z');
  ok('provenance carries source+url+license', !!e.provenance && e.provenance.source === 'GDACS' &&
    /^https?:\/\//.test(e.provenance.sourceUrl) && typeof e.provenance.license === 'string');
  eq('evidence defaults observed', e.evidence, 'observed');
  eq('confidence clamped to 0..1', normalizeEvent({ rawId: '1', confidence: 5 }, { sourceId: 'usgs' }).confidence, 1);
  eq('missing coords -> null lat', normalizeEvent({ rawId: '1' }, { sourceId: 'usgs' }).lat, null);
  eq('modeled evidence respected', normalizeEvent({ rawId: '1', evidence: 'modeled' }, { sourceId: 'power' }).evidence, 'modeled');

  section('ingestion: isValidEvent');
  ok('valid indicator w/o coords passes', isValidEvent(normalizeEvent({ rawId: '1', severity: 'high' }, { sourceId: 'worldbank' })));
  ok('out-of-range coords rejected', !isValidEvent(normalizeEvent({ rawId: '1', lat: 999, lon: 0, severity: 'high' }, { sourceId: 'usgs' })));
  ok('missing id rejected', !isValidEvent({ severity: 'high' }));
}

function testDedupe() {
  section('ingestion: dedupe (id + spatiotemporal cluster)');
  const mk = (id, sid, lat, lon, conf) => normalizeEvent({ rawId: id, lat, lon, confidence: conf, severity: 'high', published: '2026-01-02T00:00:00Z' }, { sourceId: sid });
  // id-dedupe: two records with the identical stable id collapse to one.
  const idDup = dedupeEvents([mk('9', 'gdacs', 80.0, 100.0, 0.6), mk('9', 'gdacs', 80.0, 100.0, 0.6)]);
  ok('id-dedupe removes exact duplicate id', idDup.filter((e) => e.id === 'gdacs:9').length === 1);
  // spatiotemporal cluster: different ids/sources, same 0.1-grid cell + day => one kept.
  const a = mk('1', 'gdacs', 10.01, 20.01, 0.6);
  const b = mk('2', 'usgs', 10.02, 20.02, 0.9);
  const c = mk('3', 'eonet', 55.0, 5.0, 0.7);     // far away => distinct
  const out = dedupeEvents([a, b, c]);
  const cluster = out.filter((e) => e.domain === 'hazard' && Math.round(e.lat) === 10);
  ok('spatiotemporal cluster keeps one highest-confidence record', cluster.length === 1 && cluster[0].confidence === 0.9);
  ok('distinct location retained', out.some((e) => Math.round(e.lat) === 55));
  ok('non-geo indicators are never clustered away',
    dedupeEvents([mk('a', 'worldbank', null, null, 0.5), mk('b', 'worldbank', null, null, 0.5)]).length === 2);
}

function testAggregateStatus() {
  section('ingestion: aggregateStatus');
  eq('all ok -> live', aggregateStatus([{ status: 'ok' }, { status: 'ok' }]), 'live');
  eq('mix -> partial', aggregateStatus([{ status: 'ok' }, { status: 'down' }]), 'partial');
  eq('only stale -> stale', aggregateStatus([{ status: 'stale' }, { status: 'down' }]), 'stale');
  eq('all down -> degraded', aggregateStatus([{ status: 'down' }, { status: 'down' }]), 'degraded');
  eq('empty -> degraded', aggregateStatus([]), 'degraded');
}

async function testRetryConcurrency() {
  section('ingestion: retry/backoff + bounded concurrency');
  let n = 0;
  const val = await withRetry(() => { n++; if (n < 3) throw new Error('x'); return 'ok'; }, { retries: 3, baseDelayMs: 1, sleep: noSleep });
  ok('withRetry succeeds after transient failures', val === 'ok' && n === 3);
  let threw = false;
  try { await withRetry(() => { throw new Error('always'); }, { retries: 1, sleep: noSleep }); } catch (e) { threw = true; }
  ok('withRetry rethrows after exhausting retries', threw);

  let active = 0, peak = 0;
  await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
    active++; peak = Math.max(peak, active); await noSleep(); active--;
  });
  ok('mapLimit respects concurrency cap', peak <= 2);
  const order = await mapLimit([3, 1, 2], 2, async (x) => x * 10);
  ok('mapLimit preserves input order', order.join(',') === '30,10,20');
}

async function testAggregatePipeline() {
  section('ingestion: aggregate — partial failure tolerance + disabled + cache');
  resetBreakers(); cacheClear(); clearSnapshots();

  const good = { id: 'gdacs', ttlMs: 1000, run: async () => ([
    { rawId: 'g1', domain: 'hazard', severity: 'critical', lat: 1, lon: 1, published: '2026-01-02T00:00:00Z', confidence: 0.9 },
  ]) };
  const bad = { id: 'usgs', ttlMs: 1000, run: async () => { throw new Error('boom'); } };
  const disabled = { id: 'reliefweb', ttlMs: 1000, run: async () => { const e = new Error('no appname'); e.disabled = true; throw e; } };

  const agg = await aggregate({ adapters: [good, bad, disabled], fetchImpl: fakeFetch({}), sleep: noSleep, now: Date.parse('2026-01-03T00:00:00Z') });
  ok('one bad source does not fail the aggregate', agg.summary.total === 1 && agg.events[0].id === 'gdacs:g1');
  ok('bad source reported down', agg.sources.find((s) => s.id === 'usgs').status === 'down');
  ok('disabled source reported disabled, not down', agg.sources.find((s) => s.id === 'reliefweb').status === 'disabled');
  ok('status is partial (ok + down, ignoring disabled)', agg.status === 'partial');
  ok('summary counts observed', agg.summary.observed === 1 && agg.summary.modeled === 0);

  // Last-known-good: the good source is now cached. Make it fail; expect stale served.
  const goodFails = { id: 'gdacs', ttlMs: 1, run: async () => { throw new Error('down now'); } };
  breakerFailure('gdacs'); breakerFailure('gdacs'); breakerFailure('gdacs'); // trip breaker -> use LKG
  const agg2 = await aggregate({ adapters: [goodFails], fetchImpl: fakeFetch({}), sleep: noSleep, now: Date.parse('2026-01-03T01:00:00Z') });
  ok('last-known-good served as stale when source fails', agg2.sources[0].status === 'stale' && agg2.events.length === 1);

  section('ingestion: snapshots (no DB migration)');
  recordSnapshot(agg);
  ok('snapshot recorded to in-memory ring', getSnapshots().length === 1 && getSnapshots()[0].total === 1);
}

async function testRealAdapters() {
  section('ingestion: adapter parsing (fixtures, no network)');
  const gd = await gdacs({ fetchImpl: fakeFetch({ 'gdacs.org': { features: [
    { properties: { eventtype: 'FL', eventid: 7, name: 'Flood A', alertlevel: 'Orange', country: 'X', fromdate: '2026-01-02', url: { report: 'https://x' } }, geometry: { coordinates: [20, 10] } },
    { properties: { eventtype: 'EQ', eventid: 8 }, geometry: { coordinates: [0, 0] } }, // filtered (not agri type)
  ] } }) });
  ok('GDACS filters to agri hazard types', gd.length === 1 && gd[0].rawId === 'FL7' && gd[0].domain === 'hazard');

  const eq2 = await usgs({ fetchImpl: fakeFetch({ 'earthquake.usgs.gov': { features: [
    { id: 'us1', properties: { mag: 6.7, place: 'Region', time: 1735776000000, url: 'https://u' }, geometry: { coordinates: [30, 40] } },
  ] } }) });
  ok('USGS maps magnitude to critical severity', eq2[0].severity === 'critical' && eq2[0].lat === 40);

  const wb = await worldbank({ fetchImpl: fakeFetch({ 'worldbank.org': [
    { page: 1 }, [ { value: 45.2, date: '2025', countryiso3code: 'ETH', country: { id: 'ET', value: 'Ethiopia' } } ],
  ] }) });
  ok('World Bank maps high CPI to critical severity', wb[0].severity === 'critical' && wb[0].domain === 'market');
}

async function testSentinels() {
  section('ingestion: missing-data sentinels (isFillValue)');
  ok('NASA POWER -999 is a fill value', isFillValue(-999) === true);
  ok('all documented sentinels rejected', FILL_SENTINELS.every((s) => isFillValue(s) === true));
  ok('NaN is a fill value', isFillValue(NaN) === true);
  ok('Infinity is a fill value', isFillValue(Infinity) === true && isFillValue(-Infinity) === true);
  ok('non-numeric is a fill value', isFillValue('abc') === true);
  ok('real measurement is not a fill value', isFillValue(21.4) === false && isFillValue(0) === false);

  section('ingestion: normalizeEvent nulls sentinel/non-finite values');
  eq('sentinel -999 value -> null', normalizeEvent({ rawId: '1', value: -999 }, { sourceId: 'power' }).value, null);
  eq('NaN value -> null', normalizeEvent({ rawId: '1', value: NaN }, { sourceId: 'power' }).value, null);
  eq('real value preserved', normalizeEvent({ rawId: '1', value: 21.4 }, { sourceId: 'power' }).value, 21.4);

  section('ingestion: NASA POWER adapter backfill + no-data');
  const pt = { name: 'Iowa', lat: 41.9, lon: -93.6 };
  const now = new Date('2026-01-10T00:00:00Z');
  // Latest day is a -999 sentinel; adapter must backfill to the prior valid day.
  const backfill = await power({ fetchImpl: fakeFetch({ 'power.larc.nasa.gov': {
    properties: { parameter: {
      T2M: { '20260101': 18.2, '20260102': 19.6, '20260103': -999 },
      PRECTOTCORR: { '20260101': 1.1, '20260102': 2.3, '20260103': -999 },
    } },
  } }), point: pt, now });
  ok('backfills past -999 to latest valid day', backfill.length === 1 && backfill[0].value === 19.6);
  ok('title never embeds sentinel', backfill[0].title.indexOf('-999') === -1 && backfill[0].title.indexOf('19.6') !== -1);
  ok('precip fill on chosen day -> null-safe', backfill[0].value === 19.6);

  // Precip on the backfilled day is itself a sentinel -> extra.precipMm nulled.
  const precipFill = await power({ fetchImpl: fakeFetch({ 'power.larc.nasa.gov': {
    properties: { parameter: {
      T2M: { '20260102': 19.6 },
      PRECTOTCORR: { '20260102': -999 },
    } },
  } }), point: pt, now });
  ok('sentinel precip nulled in extra', precipFill[0].extra.precipMm === null);

  // All days are -999 -> adapter throws a no-data error (source marked degraded).
  let noData = false;
  try {
    await power({ fetchImpl: fakeFetch({ 'power.larc.nasa.gov': {
      properties: { parameter: { T2M: { '20260101': -999, '20260102': -999 }, PRECTOTCORR: {} } },
    } }), point: pt, now });
  } catch (e) { noData = !!e.noData; }
  ok('all-sentinel range throws no-data (degraded, not fabricated)', noData);

  // Empty series -> no-data.
  let emptyNoData = false;
  try {
    await power({ fetchImpl: fakeFetch({ 'power.larc.nasa.gov': { properties: { parameter: { T2M: {} } } } }), point: pt, now });
  } catch (e) { emptyNoData = !!e.noData; }
  ok('empty T2M series throws no-data', emptyNoData);

  // Implausible extreme (non-sentinel garbage) is skipped in favour of a valid day.
  const extreme = await power({ fetchImpl: fakeFetch({ 'power.larc.nasa.gov': {
    properties: { parameter: {
      T2M: { '20260101': 22.0, '20260102': 5000 },
      PRECTOTCORR: {},
    } },
  } }), point: pt, now });
  ok('implausible extreme temp skipped for valid day', extreme[0].value === 22.0);
}

/* ===================== USDA NASS (keyed market adapter) ===================== */
async function testNass() {
  const CORN = 'CORN, GRAIN - PRODUCTION, MEASURED IN BU';
  const WHEAT = 'WHEAT - PRODUCTION, MEASURED IN BU';
  const SOY = 'SOYBEANS - PRODUCTION, MEASURED IN BU';
  const RICE = 'RICE - PRODUCTION, MEASURED IN CWT';
  const row = (short, year, value, unit) => ({ short_desc: short, year: String(year), Value: value, unit_desc: unit, agg_level_desc: 'NATIONAL' });
  const KEY = 'test-fake-nass-key-DO-NOT-LOG';
  const withKey = { USDA_NASS_API_KEY: KEY };
  const now = new Date('2026-02-01T00:00:00Z');

  section('nass: value parsing (commas + suppression/formatting codes)');
  eq('plain integer', parseNassValue('1234'), 1234);
  eq('thousands separators stripped', parseNassValue('15,148,038,000'), 15148038000);
  eq('decimal preserved', parseNassValue('177.3'), 177.3);
  eq('(D) withheld -> null', parseNassValue('(D)'), null);
  eq('(Z) ~zero -> null', parseNassValue('(Z)'), null);
  eq('(NA) -> null', parseNassValue('(NA)'), null);
  eq('(X) not applicable -> null', parseNassValue('(X)'), null);
  eq('blank -> null', parseNassValue('   '), null);
  eq('null -> null', parseNassValue(null), null);
  eq('non-numeric text -> null', parseNassValue('n/a'), null);

  section('nass: successful parse + formatting');
  const data = [
    row(CORN, 2024, '15,341,057,000', 'BU'),
    row(WHEAT, 2024, '1,971,832,000', 'BU'),
    row(SOY, 2024, '4,366,000,000', 'BU'),
    row(RICE, 2024, '224,600,000', 'CWT'),
  ];
  const ev = await nass({ fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data } }), env: withKey, now });
  eq('emits one indicator per staple', ev.length, 4);
  const corn = ev.find((e) => e.rawId.indexOf('corn') !== -1);
  ok('corn value parsed with commas stripped', corn.value === 15341057000);
  ok('corn is market/national/no fabricated coords', corn.domain === 'market' && corn.geography === 'United States' && corn.lat === null && corn.lon === null);
  ok('corn title compact-formats value (no raw sentinel/comma-noise)', /15\.34B/.test(corn.title) && corn.title.indexOf('(D)') === -1);
  ok('deterministic id includes year', corn.rawId === 'nass-corn-grain-production-national-2024');
  eq('published is marketing-year end', corn.published, '2024-12-31T00:00:00Z');
  ok('provenance url is public site (no key)', corn.sourceUrl === 'https://quickstats.nass.usda.gov/');
  ok('unit carried from record', corn.unit === 'bu');

  section('nass: suppressed latest year backfills to last real value');
  const bf = await nass({ fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data: [
    row(CORN, 2025, '(D)', 'BU'),          // withheld latest
    row(CORN, 2024, '14,200,000,000', 'BU'),
    row(CORN, 2023, '13,700,000,000', 'BU'),
  ] } }), env: withKey, now });
  ok('backfills past withheld year', bf.length === 1 && bf[0].value === 14200000000);
  ok('id/year reflect the backfilled year', bf[0].rawId.endsWith('-2024'));

  section('nass: fully suppressed series emits nothing (never fabricate)');
  const allSup = await nass({ fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data: [
    row(CORN, 2025, '(D)', 'BU'), row(CORN, 2024, '(Z)', 'BU'),
  ] } }), env: withKey, now });
  eq('no valid year -> no event', allSup.length, 0);

  section('nass: disabled when key missing, error surfaces upstream failure');
  let disabled = false;
  try { await nass({ fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data } }), env: {}, now }); }
  catch (e) { disabled = !!e.disabled; }
  ok('missing USDA_NASS_API_KEY -> disabled (not a failure)', disabled);
  let upstreamThrew = false, wasDisabled = true;
  try { await nass({ fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': 'throw' }), env: withKey, now }); }
  catch (e) { upstreamThrew = true; wasDisabled = !!e.disabled; }
  ok('upstream error rejects (breaker/down path), not disabled', upstreamThrew && !wasDisabled);

  section('nass: API key never leaks into records, only into the request');
  let captured = null;
  const recFetch = async (url) => { captured = url; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data }) }; };
  const leakEv = await nass({ fetchImpl: recFetch, env: withKey, now });
  ok('key is sent on the outbound request (server-side)', typeof captured === 'string' && captured.indexOf(KEY) !== -1);
  ok('key absent from every emitted record', JSON.stringify(leakEv).indexOf(KEY) === -1);
  ok('no record sourceUrl carries a key param', leakEv.every((e) => e.sourceUrl.indexOf('key=') === -1 && e.sourceUrl.indexOf(KEY) === -1));

  section('nass: registry wiring + aggregate/health rail');
  ok('ADAPTERS registry now has 11 sources', ADAPTERS.length === 11);
  ok('nass registered in ADAPTERS', ADAPTERS.some((a) => a.id === 'nass'));
  ok('SOURCES has nass with env label + not keyless', SOURCES.nass && SOURCES.nass.env === 'USDA_NASS_API_KEY' && SOURCES.nass.keyless === false && SOURCES.nass.domain === 'market');

  resetBreakers(); cacheClear();
  const nassEntry = { id: 'nass', ttlMs: 1000, run: nass };
  const agg = await aggregate({ adapters: [nassEntry], fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data } }), env: withKey, sleep: noSleep, now: Date.parse('2026-02-01T00:00:00Z') });
  const nassHealth = agg.sources.find((s) => s.id === 'nass');
  ok('aggregate surfaces nass health row', !!nassHealth && nassHealth.status === 'ok' && nassHealth.env === 'USDA_NASS_API_KEY');
  ok('aggregate counts nass events', nassHealth.count === 4 && agg.summary.byDomain.market === 4);
  ok('normalized nass events carry USDA NASS source + license', agg.events.every((e) => e.source === 'USDA NASS' && /USDA NASS/.test(e.license)));
  ok('no key leaks through the full aggregate/normalize path', JSON.stringify(agg).indexOf(KEY) === -1);

  resetBreakers(); cacheClear();
  const aggOff = await aggregate({ adapters: [nassEntry], fetchImpl: fakeFetch({}), env: {}, sleep: noSleep, now: Date.parse('2026-02-01T00:00:00Z') });
  ok('nass reports disabled (not down) when key unset', aggOff.sources[0].status === 'disabled');
  resetBreakers(); cacheClear();
}

/* ============================ branding + security guards ============================ */
function testBrandingSecurity() {
  section('branding: AgriOS rebrand + no leakage');
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const app = readFileSync(join(ROOT, 'assets', 'app.js'), 'utf8');
  const combined = html + '\n' + app;

  ok('title uses AgriOS lockup', /<title>AgriOS · A Nirmata Holdings Company<\/title>/.test(html));
  ok('gate shows AgriOS wordmark', /Agri<span[^>]*>OS<\/span>/.test(html));
  ok('lockup subline present somewhere', combined.indexOf('A Nirmata Holdings Company') !== -1);
  ok('no visible AGRI-NEXUS product title', html.indexOf('AGRI-NEXUS · Command Center') === -1);
  ok('gate/topbar wordmark no longer AGRI-NEXUS', html.indexOf('AGRI-<b>NEXUS</b>') === -1 && html.indexOf('AGRI-NEXUS <span') === -1);
  ok('print brief rebranded', app.indexOf('AGRI-NEXUS COMMAND CENTER — Daily') === -1 && app.indexOf('AgriOS · A Nirmata Holdings Company — Daily') !== -1);

  section('security: gate + storage + forbidden brands');
  ok('access code is exact FuckPutin', /const PASSWORD\s*=\s*"FuckPutin"/.test(app));
  ok('old access code fully removed', combined.indexOf('PutinSucksTinyChinaCocks') === -1);
  ok('no localStorage', combined.indexOf('localStorage') === -1);
  ok('no sessionStorage', combined.indexOf('sessionStorage') === -1);
  ok('no IndexedDB', combined.indexOf('indexedDB') === -1 && combined.indexOf('IndexedDB') === -1);
  const forbidden = ['clinixAI', 'antimatterai', 'rrg.bio', 'thingktangk', 'HumanOS'];
  ok('no forbidden sibling brands in UI', forbidden.every((b) => combined.indexOf(b) === -1));

  section('a11y: traffic-light language redundancy');
  ok('signal bubble carries text label + aria (not colour alone)',
    /class="signal \$\{tl\}"[\s\S]*aria-label/.test(app) && app.indexOf('sig-lbl') !== -1);
  ok('evidence badges cover LIVE/STALE/MODELED/BUNDLED',
    ['LIVE', 'STALE', 'MODELED', 'BUNDLED'].every((k) => app.indexOf(k) !== -1));
  ok('accessible traffic legend present', app.indexOf("data-testid=\"traffic-legend\"") !== -1);
}

/* ===================== account auth (env-backed) ===================== */
async function testAccounts() {
  // ---- fake, test-only credentials generated at runtime (never real) ----
  const OWNER_PW = 'owner-pw-abcdef-123456';
  const OP_PW = 'operator-pw-xyz-987654';
  const S = SCRYPT_PARAMS;
  function mkRec(email, name, role, pw) {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(pw, salt, S.keylen, { N: S.N, r: S.r, p: S.p }).toString('hex');
    return { email, name, role, salt, hash };
  }
  const ownerRec = mkRec('ben@nirmata.example', 'Ben', 'owner', OWNER_PW);
  const opRec = mkRec('joel@nirmata.example', 'Joel', 'operator', OP_PW);

  const SECRET = 'test-only-session-secret-0123456789abcdef';
  const goodEnv = {
    AGRIOS_SESSION_SECRET: SECRET,
    AGRIOS_AUTH_USERS_JSON: JSON.stringify([ownerRec, opRec]),
  };

  // Handler mocks + limiter reset. The handler reads config from process.env,
  // so set it for the duration and restore afterward.
  const savedUsers = process.env.AGRIOS_AUTH_USERS_JSON;
  const savedSecret = process.env.AGRIOS_SESSION_SECRET;
  function setEnv(users, secret) {
    if (users === null) delete process.env.AGRIOS_AUTH_USERS_JSON;
    else process.env.AGRIOS_AUTH_USERS_JSON = users;
    if (secret === null) delete process.env.AGRIOS_SESSION_SECRET;
    else process.env.AGRIOS_SESSION_SECRET = secret;
  }
  function resetLimiters() {
    if (globalThis.__AGRI_RL__) globalThis.__AGRI_RL__.clear();
    if (globalThis.__AGRIOS_ACCT_RL__) globalThis.__AGRIOS_ACCT_RL__.clear();
    clearRevocations();
  }
  function mockRes() {
    return {
      statusCode: 0, headers: {}, body: undefined, ended: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
      getHeader(k) { return this.headers[String(k).toLowerCase()]; },
      end(payload) {
        this.ended = true;
        if (payload !== undefined) { try { this.body = JSON.parse(payload); } catch (_) { this.body = payload; } }
      },
    };
  }
  let ipSeq = 0;
  function acctReq({ method = 'POST', action, body, headers = {}, ip } = {}) {
    const h = { host: 'app.example.com', origin: 'https://app.example.com', ...headers };
    return {
      method, url: `/api/account?action=${action}`, query: { action },
      headers: h, body, socket: { remoteAddress: ip || ('10.9.0.' + (++ipSeq)) },
    };
  }
  async function call(opts) {
    const res = mockRes();
    await accountHandler(acctReq(opts), res);
    return res;
  }
  // HMAC re-signer so we can forge tokens with tampered claims for negative tests.
  function forge(payloadObj, secret = SECRET) {
    const pb = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
    const sig = createHmac('sha256', secret).update(pb).digest().toString('base64url');
    return pb + '.' + sig;
  }

  section('accounts: loadUsers parsing + validation');
  const users = loadUsers(goodEnv);
  ok('loads two records', Array.isArray(users) && users.length === 2);
  ok('emails normalized lowercase', users[0].email === 'ben@nirmata.example');
  ok('null when config absent', loadUsers({}) === null);
  ok('null on malformed JSON', loadUsers({ AGRIOS_AUTH_USERS_JSON: '{not json' }) === null);
  ok('accepts {users:[...]} wrapper', Array.isArray(loadUsers({ AGRIOS_AUTH_USERS_JSON: JSON.stringify({ users: [ownerRec] }) })));
  ok('null on bad role', loadUsers({ AGRIOS_AUTH_USERS_JSON: JSON.stringify([{ ...ownerRec, role: 'admin' }]) }) === null);
  ok('null on short hash', loadUsers({ AGRIOS_AUTH_USERS_JSON: JSON.stringify([{ ...ownerRec, hash: 'abcd' }]) }) === null);
  ok('null on bad salt', loadUsers({ AGRIOS_AUTH_USERS_JSON: JSON.stringify([{ ...ownerRec, salt: 'xyz' }]) }) === null);
  ok('null on duplicate email', loadUsers({ AGRIOS_AUTH_USERS_JSON: JSON.stringify([ownerRec, ownerRec]) }) === null);
  ok('no raw password anywhere in loaded record', JSON.stringify(users).indexOf(OWNER_PW) === -1);

  section('accounts: authenticate (constant-time verifier)');
  const aOwner = await authenticate('ben@nirmata.example', OWNER_PW, goodEnv);
  ok('correct owner password authenticates', !!aOwner.user && aOwner.user.role === 'owner');
  ok('authenticate returns no secret material', !('hash' in (aOwner.user || {})) && !('salt' in (aOwner.user || {})));
  const aCase = await authenticate('BEN@Nirmata.Example', OWNER_PW, goodEnv);
  ok('email is case-insensitive', !!aCase.user && aCase.user.email === 'ben@nirmata.example');
  const aWrong = await authenticate('ben@nirmata.example', 'wrong-password-000', goodEnv);
  ok('wrong password -> generic invalid', aWrong.error === 'invalid' && !aWrong.user);
  const aUnknown = await authenticate('nobody@nirmata.example', OWNER_PW, goodEnv);
  ok('unknown email -> same generic invalid', aUnknown.error === 'invalid' && !aUnknown.user);
  const aNoCfg = await authenticate('ben@nirmata.example', OWNER_PW, {});
  ok('missing config -> unavailable', aNoCfg.error === 'unavailable');
  ok('verifyPassword true for correct', await verifyPassword(OWNER_PW, ownerRec.hash, ownerRec.salt));
  ok('verifyPassword false for wrong', !(await verifyPassword('nope-nope-nope', ownerRec.hash, ownerRec.salt)));
  ok('verifyPassword false for malformed hash', !(await verifyPassword(OWNER_PW, 'zz', ownerRec.salt)));

  section('accounts: session token sign + verify');
  const signed = signSession(aOwner.user, { env: goodEnv });
  ok('sign yields a token', typeof signed.token === 'string' && signed.token.indexOf('.') > 0);
  ok('sign yields ISO expiresAt', typeof signed.expiresAt === 'string' && !Number.isNaN(Date.parse(signed.expiresAt)));
  ok('payload carries iss/aud/version', signed.payload.iss === 'agrios' && signed.payload.aud === 'agrios-web' && signed.payload.v === 1);
  ok('payload role preserved', signed.payload.role === 'owner');
  const v1 = verifySession(signed.token, { env: goodEnv });
  ok('valid token verifies', v1.valid && v1.payload.sub === 'ben@nirmata.example');
  // tamper the payload (keep original signature) -> bad signature
  const parts = signed.token.split('.');
  const tampPayload = Buffer.from(JSON.stringify({ ...signed.payload, role: 'owner', sub: 'evil@x.example' })).toString('base64url');
  ok('tampered payload rejected', verifySession(tampPayload + '.' + parts[1], { env: goodEnv }).reason === 'bad_signature');
  ok('tampered signature rejected', verifySession(parts[0] + '.' + Buffer.from('garbage').toString('base64url'), { env: goodEnv }).reason === 'bad_signature');
  ok('malformed token rejected', verifySession('nodot', { env: goodEnv }).reason === 'malformed');
  // forged tokens with correct secret but wrong claims
  const base = { sub: 'ben@nirmata.example', name: 'Ben', role: 'owner', iss: 'agrios', aud: 'agrios-web', v: 1, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  ok('wrong audience rejected', verifySession(forge({ ...base, aud: 'someone-else' }), { env: goodEnv }).reason === 'bad_audience');
  ok('wrong issuer rejected', verifySession(forge({ ...base, iss: 'evil' }), { env: goodEnv }).reason === 'bad_issuer');
  ok('wrong version rejected', verifySession(forge({ ...base, v: 99 }), { env: goodEnv }).reason === 'bad_version');
  ok('expired token rejected', verifySession(forge({ ...base, exp: Math.floor(Date.now() / 1000) - 10 }), { env: goodEnv }).reason === 'expired');
  ok('bad role in token rejected', verifySession(forge({ ...base, role: 'admin' }), { env: goodEnv }).reason === 'bad_role');
  ok('no signing secret -> sign unavailable', signSession(aOwner.user, { env: {} }).error === 'unavailable');
  ok('no signing secret -> verify invalid', verifySession(signed.token, { env: {} }).valid === false);
  // TTL is hard-capped at MAX_TTL_MS regardless of requested lifetime
  const longNow = 1_000_000_000_000;
  const capped = signSession(aOwner.user, { env: goodEnv, now: longNow, ttlMs: 999 * 60 * 60 * 1000 });
  ok('ttl hard-capped at max', (capped.payload.exp - capped.payload.iat) <= MAX_TTL_MS / 1000);

  section('accounts: roles + resolveAccount');
  ok('owner >= operator', accountRoleAtLeast('owner', 'operator'));
  ok('operator >= operator', accountRoleAtLeast('operator', 'operator'));
  ok('operator NOT >= owner', !accountRoleAtLeast('operator', 'owner'));
  ok('unknown role NOT >= operator', !accountRoleAtLeast('nope', 'operator'));
  const ownerTok = signSession(aOwner.user, { env: goodEnv }).token;
  const opAuth = await authenticate('joel@nirmata.example', OP_PW, goodEnv);
  const opTok = signSession(opAuth.user, { env: goodEnv }).token;
  ok('bearerToken parses header', bearerToken({ headers: { authorization: 'Bearer ' + ownerTok } }) === ownerTok);
  const rOwner = resolveAccount({ headers: { authorization: 'Bearer ' + ownerTok } }, { env: goodEnv, minRole: 'owner' });
  ok('owner resolves at owner minRole', !!rOwner && rOwner.role === 'owner');
  ok('operator denied at owner minRole', resolveAccount({ headers: { authorization: 'Bearer ' + opTok } }, { env: goodEnv, minRole: 'owner' }) === null);
  ok('operator allowed at operator minRole', !!resolveAccount({ headers: { authorization: 'Bearer ' + opTok } }, { env: goodEnv, minRole: 'operator' }));
  ok('no bearer -> null', resolveAccount({ headers: {} }, { env: goodEnv, minRole: 'operator' }) === null);
  revokeToken(ownerTok);
  ok('revoked token -> null', resolveAccount({ headers: { authorization: 'Bearer ' + ownerTok } }, { env: goodEnv, minRole: 'owner' }) === null);
  clearRevocations();

  section('accounts: login endpoint');
  setEnv(goodEnv.AGRIOS_AUTH_USERS_JSON, SECRET);
  resetLimiters();
  const okRes = await call({ action: 'login', body: { email: 'ben@nirmata.example', password: OWNER_PW } });
  eq('successful login -> 200', okRes.statusCode, 200);
  ok('login returns a token', okRes.body && okRes.body.authenticated === true && typeof okRes.body.token === 'string');
  ok('login returns identity {email,name,role}', okRes.body.user && okRes.body.user.email === 'ben@nirmata.example' && okRes.body.user.role === 'owner');
  ok('login never echoes password', JSON.stringify(okRes.body).indexOf(OWNER_PW) === -1);
  ok('login response is no-store', String(okRes.getHeader('cache-control')).indexOf('no-store') !== -1);
  const upRes = await call({ action: 'login', body: { email: 'BEN@Nirmata.Example', password: OWNER_PW } });
  ok('login normalizes email', upRes.statusCode === 200 && upRes.body.user.email === 'ben@nirmata.example');

  resetLimiters();
  const wrongRes = await call({ action: 'login', body: { email: 'ben@nirmata.example', password: 'bad-password-x' } });
  eq('wrong password -> 401', wrongRes.statusCode, 401);
  ok('wrong password generic error', wrongRes.body.error === 'invalid_credentials' && !wrongRes.body.token);
  const unkRes = await call({ action: 'login', body: { email: 'ghost@nirmata.example', password: OWNER_PW } });
  eq('unknown email -> 401 (same generic)', unkRes.statusCode, 401);
  ok('unknown email indistinguishable', unkRes.body.error === 'invalid_credentials');

  const getLogin = await call({ method: 'GET', action: 'login', body: {} });
  eq('login rejects non-POST', getLogin.statusCode, 405);
  const badOrigin = await call({ action: 'login', headers: { origin: 'https://evil.com' }, body: { email: 'ben@nirmata.example', password: OWNER_PW } });
  eq('login rejects cross-origin', badOrigin.statusCode, 403);
  const big = await call({ action: 'login', headers: { 'content-length': '5000' }, body: { email: 'ben@nirmata.example', password: OWNER_PW } });
  eq('login rejects oversized body', big.statusCode, 413);

  section('accounts: login with missing config (no leak)');
  setEnv(null, null);
  resetLimiters();
  const noCfg = await call({ action: 'login', body: { email: 'ben@nirmata.example', password: OWNER_PW } });
  eq('missing config -> 503', noCfg.statusCode, 503);
  ok('missing config generic unavailable', noCfg.body.error === 'unavailable');
  ok('missing config never names which var', JSON.stringify(noCfg.body).match(/AGRIOS_|SECRET|USERS_JSON|env/i) === null);
  setEnv(goodEnv.AGRIOS_AUTH_USERS_JSON, SECRET);

  section('accounts: rate limiting + backoff');
  resetLimiters();
  let acctLimited = null;
  for (let i = 0; i < 8; i++) {
    const r = await call({ action: 'login', ip: '10.5.5.5', body: { email: 'ben@nirmata.example', password: 'bad-pass-' + i } });
    if (r.statusCode === 429) { acctLimited = r; break; }
  }
  ok('per-account throttle trips to 429', !!acctLimited);
  ok('per-account 429 sets Retry-After', acctLimited && acctLimited.getHeader('retry-after') != null);
  resetLimiters();
  let ipLimited = null;
  for (let i = 0; i < 13; i++) {
    const r = await call({ action: 'login', ip: '10.6.6.6', body: { email: 'user' + i + '@nirmata.example', password: 'bad-pass' } });
    if (r.statusCode === 429) { ipLimited = r; break; }
  }
  ok('per-IP limiter trips to 429', !!ipLimited);

  section('accounts: session + logout endpoints');
  setEnv(goodEnv.AGRIOS_AUTH_USERS_JSON, SECRET);
  resetLimiters();
  const freshLogin = await call({ action: 'login', body: { email: 'joel@nirmata.example', password: OP_PW } });
  const sessTok = freshLogin.body.token;
  const sess = await call({ method: 'GET', action: 'session', headers: { authorization: 'Bearer ' + sessTok } });
  ok('session endpoint confirms auth', sess.statusCode === 200 && sess.body.authenticated === true && sess.body.user.role === 'operator');
  const sessNone = await call({ method: 'GET', action: 'session' });
  ok('session without bearer -> not authenticated', sessNone.body.authenticated === false);
  const out = await call({ method: 'POST', action: 'logout', headers: { authorization: 'Bearer ' + sessTok } });
  ok('logout returns authenticated:false', out.statusCode === 200 && out.body.authenticated === false);
  const sessAfter = await call({ method: 'GET', action: 'session', headers: { authorization: 'Bearer ' + sessTok } });
  ok('token revoked after logout', sessAfter.body.authenticated === false);
  clearRevocations();

  section('accounts: client asset has no secret leakage / persistence');
  const authJs = readFileSync(join(ROOT, 'assets', 'auth.js'), 'utf8');
  ok('assets/auth.js exists', authJs.length > 0);
  ok('no localStorage usage', !/localStorage\s*\./.test(authJs) && !/localStorage\s*\[/.test(authJs));
  ok('no sessionStorage usage', !/sessionStorage\s*\./.test(authJs));
  ok('no cookie usage', authJs.indexOf('document.cookie') === -1);
  ok('no IndexedDB usage', !/indexedDB\s*\./.test(authJs));
  ok('token replayed via Authorization/Bearer', authJs.indexOf('Authorization') !== -1 && authJs.indexOf('Bearer') !== -1);
  ok('no console logging in auth client', !/console\.(log|warn|error|info)/.test(authJs));
  ok('no fake test creds embedded in client', authJs.indexOf(OWNER_PW) === -1 && authJs.indexOf(OP_PW) === -1);
  ok('token not placed in a URL/query', !/token=/.test(authJs));

  section('accounts: sign-in UI accessibility + test ids');
  const idsNeeded = [
    'account-overlay', 'account-dialog', 'account-close', 'account-login-form',
    'account-email', 'account-password', 'account-pw-toggle', 'account-error',
    'account-submit', 'account-identity', 'account-role', 'account-signout',
  ];
  // Test ids appear either as literal attributes or via setAttribute(...).
  const hasTestId = (id) => authJs.indexOf('data-testid="' + id + '"') !== -1 || authJs.indexOf("'" + id + "'") !== -1;
  ok('all account test ids present', idsNeeded.every(hasTestId));
  ok('dialog has role=dialog + aria-modal', /role["'\s,]+dialog/.test(authJs) && authJs.indexOf('aria-modal') !== -1);
  ok('password input hidden by default (type=password)', /type="password"/.test(authJs));
  ok('generic error copy, no field disclosure', authJs.indexOf('Incorrect email or password') !== -1);

  // Restore any pre-existing env so later tests / process are unaffected.
  setEnv(savedUsers === undefined ? null : savedUsers, savedSecret === undefined ? null : savedSecret);
  resetLimiters();
}

/* ============================ run ============================ */
(async function main() {
  console.log('AgriOS · A Nirmata Holdings Company — test suite');
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
    testTheaterGlobe();
    testSeverity();
    testNormalize();
    testDedupe();
    testAggregateStatus();
    await testRetryConcurrency();
    await testAggregatePipeline();
    await testRealAdapters();
    await testSentinels();
    await testNass();
    testBrandingSecurity();
    await testAccounts();
  } catch (e) {
    console.error('\nFATAL: test harness threw:', e && e.message);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.error('Failing: ' + failures.join('; ')); process.exit(1); }
  process.exit(0);
})();
