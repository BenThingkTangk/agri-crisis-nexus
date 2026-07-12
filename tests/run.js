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
import { roleAtLeast, resolveAnyAuth, accountTeamRole } from '../api/_auth.js';
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
  ACCOUNT_ROLES, DEFAULT_TTL_MS, MAX_TTL_MS, SCRYPT_PARAMS, publicRoster,
} from '../api/_accounts.js';
import accountHandler from '../api/account.js';
import {
  SEVERITY_RANK, HORIZONS, ALERT_STATUS, TASK_STATUS, MISSION_STATUS as INTEL_MISSION_STATUS,
  alertStatusCanTransition, missionStatusCanTransition, taskStatusCanTransition, alertActionToStatus,
  computeConfidence, alertFromEvent, alertsFromCropRisk, deriveAlerts, explainAlert,
  slaClock, MISSION_TEMPLATES, templateByKey, instantiateTemplate,
  presenceFreshness, PRESENCE_ONLINE_MS, PRESENCE_AWAY_MS, parseMentions,
  buildAlertExplanation, buildMissionBrief, buildActionCards, buildAfterAction,
  agRelevanceScore, classifyEvent, deriveAlertsDetailed, alertRelevance,
  AG_PROMOTE_THRESHOLD, AG_MODEL_THRESHOLD,
} from '../api/_intel.js';
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

  // Account→team role mapping boundary (the production owner must clear the
  // analyst write gate on alerts/missions/collab). owner→owner, operator→analyst.
  ok('account owner (→owner) clears analyst write boundary', roleAtLeast('owner', 'analyst'));
  ok('account operator (→analyst) clears analyst write boundary', roleAtLeast('analyst', 'analyst'));
  ok('operator mapping does NOT reach owner-only actions', !roleAtLeast('analyst', 'owner'));
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

// Phase III: exercise the War Room presence/message paint path and the alert
// badge (open/unread) through the same node:vm technique. We register the War
// Room host elements directly and feed a server-backed collab state so the
// honest near-real-time render (roster + messages + sync label) is asserted.
function buildWarRoomSandbox() {
  const registry = {};
  const surfaces = ['#teamMissions', '#teamMissionsMeta', '#identityLabel', '#identityBtn',
    '#openAlerts', '#alertCount', '#newMissionBtn', '#scenarioHistorySection', '#scenarioHistory',
    '#simSave', '#warRoom', '#wrBody', '#wrSync'];
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
  const COLLAB_STATE = {
    ok: true,
    members: [
      { id: 'u1', name: 'Owner One', role: 'owner', presence: 'online', focus: 'War Room', isMe: true },
      { id: 'u2', name: 'Analyst Two', role: 'analyst', presence: 'away', focus: null, isMe: false },
    ],
    online: 1,
    messages: [
      { id: 'msg1', user_id: 'u1', user_name: 'Owner One', body: 'Watching the grain corridor.', kind: 'message', created_at: '2026-07-12T00:00:00Z' },
      { id: 'sys1', user_id: null, user_name: null, body: '@Analyst Two assigned to alert.', kind: 'system', created_at: '2026-07-12T00:01:00Z' },
    ],
    serverTime: '2026-07-12T00:02:00Z',
  };
  const ALERTS = {
    ok: true, unread: 2, open: 3,
    alerts: [
      { id: 'a1', title: 'Modeled wheat risk', severity: 'high', basis: 'modeled', confidence: 0.62, horizon: '30d', status: 'new', is_read: false, regions: ['Sahel'], commodities: ['wheat'] },
      { id: 'a2', title: 'Observed port closure', severity: 'critical', basis: 'observed', confidence: 0.8, horizon: '24h', status: 'acknowledged', is_read: true },
    ],
  };

  const fetchLog = [];
  function fetchStub(path, opts) {
    fetchLog.push({ path, method: (opts && opts.method) || 'GET' });
    let body = {};
    if (path.indexOf('/api/auth?action=session') === 0) body = { authenticated: true, session: SESSION };
    else if (path.indexOf('/api/missions') === 0) body = { missions: [] };
    else if (path.indexOf('/api/scenarios') === 0) body = { scenarios: [] };
    else if (path.indexOf('/api/collab') === 0) body = COLLAB_STATE;
    else if (path.indexOf('/api/alerts') === 0) body = ALERTS;
    return Promise.resolve({ ok: true, status: 200, json() { return Promise.resolve(body); } });
  }

  const A = {
    esc: (s) => String(s == null ? '' : s),
    icon: () => '',
    reduced: true,
    refreshIcons() {},
    getSimSnapshot() { return null; },
    applyScenario() {}, activateMode() {}, openDrawer() {}, closeDrawer() {},
    pillars: [], badge: () => '', el: () => makeEl(),
  };
  const windowStub = { AGRI_APP: A };
  const sandbox = {
    window: windowStub, document: documentStub, fetch: fetchStub,
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'test' },
    location: { href: 'https://app.example.com/', origin: 'https://app.example.com', search: '' },
    URLSearchParams, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, console,
  };
  return { sandbox, registry, fetchLog, windowStub };
}

async function testWarRoomCollab() {
  section('frontend: War Room presence/messages + alert badge (Phase III)');
  const src = readFileSync(join(ROOT, 'assets', 'collab.js'), 'utf8');
  const { sandbox, registry, fetchLog, windowStub } = buildWarRoomSandbox();
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'assets/collab.js' });
  const collab = windowStub.AGRI_COLLAB;

  await collab.refreshSession();
  await flush();
  // Signed-in: alert badge reflects unread count from the enriched payload.
  ok('alert badge shows unread count', registry['#alertCount'].textContent === '2');
  ok('alert badge visible when unread', registry['#alertCount'].hidden === false);
  ok('synced alerts on restore', fetchLog.some((c) => c.path.indexOf('/api/alerts') === 0));

  // Render the simulate panel — this mounts + paints the War Room.
  collab.onSimRendered();
  await flush();
  ok('fetched War Room collab state', fetchLog.some((c) => c.path.indexOf('/api/collab') === 0));
  ok('sent a heartbeat', fetchLog.some((c) => c.path.indexOf('/api/collab?action=heartbeat') === 0));

  const wr = registry['#wrBody'].innerHTML;
  ok('roster renders both members', wr.indexOf('Owner One') !== -1 && wr.indexOf('Analyst Two') !== -1);
  ok('presence dots reflect server status', wr.indexOf('wr-dot online') !== -1 && wr.indexOf('wr-dot away') !== -1);
  ok('renders a chat message', wr.indexOf('Watching the grain corridor.') !== -1);
  ok('renders a system event', wr.indexOf('wr-msg system') !== -1);
  ok('highlights @mentions', wr.indexOf('class="mention"') !== -1);
  ok('composer present for writer', wr.indexOf('wr-compose') !== -1);

  const sync = registry['#wrSync'].textContent;
  ok('sync label states online count + last sync (honest near-real-time)',
    /online/.test(sync) && /synced/.test(sync));
}

// ---------------------------------------------------------------------------
// Phase III shared-auth propagation (regression for the production QA failure:
// account-authenticated owner got 401s from alerts/rules/missions/collab and
// the surfaces showed a misleading "0 alerts" instead of an honest sign-in
// state). We drive the real assets/collab.js IIFE with a window.AGRIOS_AUTH
// (env-backed account layer) stub and a header-capturing fetch.
// ---------------------------------------------------------------------------
function buildAuthSandbox(opts) {
  opts = opts || {};
  const registry = {};
  const surfaces = ['#teamMissions', '#teamMissionsMeta', '#identityLabel', '#identityBtn',
    '#openAlerts', '#alertCount', '#newMissionBtn', '#scenarioHistorySection', '#scenarioHistory',
    '#simSave', '#warRoom', '#wrBody', '#wrSync'];
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
    user: { id: 'u1', email: 'owner@example.com', displayName: 'DB Owner' },
    activeTeamId: 't1', role: 'owner', memberships: [], csrfToken: 'csrf-1',
  };
  const MISSION = {
    id: 'm1', title: 'Bridged mission', objective: 'Reachable via account bearer',
    priority: 'high', status: 'active', pillar: 'Secure Infrastructure',
    geography: '', assignee_id: null, created_by_name: 'DB Owner',
    created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
  };

  const fetchLog = [];
  function fetchStub(path, fopts) {
    const headers = (fopts && fopts.headers) || {};
    fetchLog.push({ path, method: (fopts && fopts.method) || 'GET', headers });
    // Per-path status override lets a test force a 401 (session-expired) case.
    const status = (opts.status && opts.status(path)) || 200;
    let body = {};
    if (path.indexOf('/api/auth?action=session') === 0) {
      body = opts.dbAuthenticated
        ? { authenticated: true, session: SESSION }
        : { authenticated: false };
    } else if (path.indexOf('/api/missions') === 0) body = { missions: [MISSION] };
    else if (path.indexOf('/api/scenarios') === 0) body = { scenarios: [] };
    else if (path.indexOf('/api/collab') === 0) body = { ok: true, members: [], online: 0, messages: [], serverTime: '2026-07-12T00:00:00Z' };
    else if (path.indexOf('/api/alerts') === 0) body = { ok: status === 200, alerts: [], unread: 0, open: 0, message: status === 401 ? 'Sign in to continue.' : undefined };
    return Promise.resolve({ ok: status < 400, status, json() { return Promise.resolve(body); } });
  }

  const A = {
    esc: (s) => String(s == null ? '' : s),
    icon: () => '',
    reduced: true,
    refreshIcons() {},
    getSimSnapshot() { return null; },
    applyScenario() {}, activateMode() {}, openDrawer() {}, closeDrawer() {},
    pillars: [], badge: () => '', el: () => makeEl(),
  };
  const windowStub = { AGRI_APP: A };

  // Optional env-backed account layer (assets/auth.js surface). onChange stores
  // the callback AND fires it immediately, exactly like the real implementation,
  // so subscribing is equivalent to reacting to the current auth state.
  const authChangeCbs = [];
  if (opts.account) {
    windowStub.AGRIOS_AUTH = {
      isAuthed() { return true; },
      getRole() { return opts.account.role; },
      isOwner() { return opts.account.role === 'owner'; },
      getSession() { return { user: { email: opts.account.email, name: opts.account.name, role: opts.account.role }, expiresAt: '2026-12-31T00:00:00Z' }; },
      authHeader() { return { Authorization: 'Bearer ' + opts.account.token }; },
      onChange(cb) { authChangeCbs.push(cb); cb(); },
    };
  }

  const sandbox = {
    window: windowStub, document: documentStub, fetch: fetchStub,
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'test' },
    location: { href: 'https://app.example.com/', origin: 'https://app.example.com', search: '' },
    URLSearchParams, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {}, console,
  };
  return { sandbox, registry, fetchLog, windowStub, authChangeCbs };
}

async function testPhase3AccountAuth() {
  const src = readFileSync(join(ROOT, 'assets', 'collab.js'), 'utf8');

  // --- Case 1: account owner (no DB session) is bridged onto Phase III ---------
  section('frontend: account bearer bridges Phase III surfaces (regression)');
  {
    const { sandbox, registry, fetchLog, windowStub, authChangeCbs } = buildAuthSandbox({
      dbAuthenticated: false,
      account: { email: 'ben@nirmata.example', name: 'Ben', role: 'owner', token: 'ACCT-TOKEN-OWNER' },
    });
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'assets/collab.js' });
    const collab = windowStub.AGRI_COLLAB;

    collab.onCommandRendered();
    collab.init();
    await flush();

    ok('collab subscribed to AGRIOS_AUTH.onChange (login/logout broadcast)', authChangeCbs.length === 1);
    ok('DB session endpoint was consulted first', fetchLog.some((c) => c.path.indexOf('/api/auth?action=session') === 0));
    // Every authenticated request must carry the account bearer so the server
    // bridge (requireAnyAuth) can map it onto the workspace team.
    const authed = fetchLog.filter((c) => c.path.indexOf('/api/auth?action=session') !== 0);
    ok('made at least one Phase III request', authed.length > 0);
    ok('alerts/missions/collab requests carry the account bearer',
      authed.every((c) => c.headers && c.headers.Authorization === 'Bearer ACCT-TOKEN-OWNER'));
    ok('session-fetch itself carries the bearer',
      fetchLog.some((c) => c.path.indexOf('/api/auth?action=session') === 0 && c.headers.Authorization === 'Bearer ACCT-TOKEN-OWNER'));
    // Owner must clear the analyst write boundary and load real data — NOT a
    // signed-out "0 alerts" placeholder.
    ok('team missions fetched for account owner (not signed-out)',
      fetchLog.some((c) => c.path.indexOf('/api/missions') === 0));
    ok('placeholder replaced by real mission for account owner',
      registry['#teamMissions'].innerHTML.indexOf('Sign in to plan') === -1 &&
      registry['#teamMissions'].innerHTML.indexOf('Bridged mission') !== -1);
    ok('alert bell revealed for account owner', registry['#openAlerts'].hidden === false);
    ok('new-mission affordance revealed (owner ≥ analyst boundary)', registry['#newMissionBtn'].hidden === false);
  }

  // --- Case 2: a 401 mid-session yields an honest sign-in state, not "0 alerts" -
  section('frontend: 401 renders honest sign-in state, never "0 alerts" (regression)');
  {
    const { sandbox, registry, windowStub } = buildAuthSandbox({
      dbAuthenticated: true, // the session endpoint resolves once...
      // ...but the session has expired server-side: every scoped request 401s.
      status: (p) => (p.indexOf('/api/auth?action=session') === 0 ? 200 : 401),
    });
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'assets/collab.js' });
    const collab = windowStub.AGRI_COLLAB;

    collab.onCommandRendered();
    await collab.refreshSession();
    await flush();

    // handleAuthLost() must have dropped the session so the identity repaints to
    // a sign-in prompt (no AGRIOS_AUTH present here, so collab owns the label).
    ok('session dropped after 401 → identity shows sign-in', registry['#identityLabel'].textContent === 'Sign in');
    ok('alert bell hidden once signed out (not a 0-count all-clear)', registry['#openAlerts'].hidden === true);
    ok('team missions render a sign-in state, not real mission data',
      registry['#teamMissions'].innerHTML.indexOf('Sign in') !== -1 &&
      registry['#teamMissions'].innerHTML.indexOf('Bridged mission') === -1);
  }

  // --- Case 3: an auxiliary 401 must NOT poison a still-valid account session ---
  // BUG1 regression: the alert→mission composer's GET /api/teams was 401ing while
  // the account bearer was valid/owner, and that single 401 tore down the whole
  // session (Command + War Room fell back to "Sign in ..."). With the account
  // layer present, handleAuthLost() must recover to the account session instead
  // of dropping it — the bell stays visible and identity stays signed in.
  section('frontend: auxiliary 401 does not drop a valid account session (BUG1 regression)');
  {
    const { sandbox, registry, windowStub } = buildAuthSandbox({
      dbAuthenticated: false, // no DB session — account bearer is the only identity
      account: { email: 'ben@nirmata.example', name: 'Ben', role: 'owner', token: 'ACCT-TOKEN-OWNER' },
      // Every scoped request (teams/alerts/missions/collab) 401s, mimicking the
      // auxiliary-endpoint rejection that used to globally poison the session.
      status: (p) => (p.indexOf('/api/auth?action=session') === 0 ? 200 : 401),
    });
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'assets/collab.js' });
    const collab = windowStub.AGRI_COLLAB;

    collab.onCommandRendered();
    collab.init();
    await flush();
    // War Room activation must also recover from the account session, not the
    // misleading "Sign in to join your team's War Room" placeholder.
    collab.onSimRendered();
    await flush();

    ok('account session survives the auxiliary 401 (identity not "Sign in")',
      registry['#identityLabel'].textContent !== 'Sign in');
    ok('alert bell stays visible after auxiliary 401 (no global poison)',
      registry['#openAlerts'].hidden === false);
    ok('War Room not forced to signed-out placeholder',
      registry['#wrBody'].innerHTML.indexOf('Sign in to join') === -1);
  }
}

// Source-level guards for the shared-auth wiring and the mode-switch fix. These
// complement the functional tests above and pin the exact contract in code.
function testPhase3AuthWiringSource() {
  section('phase3: shared-auth wiring (source contract)');
  const collab = readFileSync(join(ROOT, 'assets', 'collab.js'), 'utf8');
  const app = readFileSync(join(ROOT, 'assets', 'app.js'), 'utf8');
  const authApi = readFileSync(join(ROOT, 'api', '_auth.js'), 'utf8');
  const alertsApi = readFileSync(join(ROOT, 'api', 'alerts.js'), 'utf8');
  const missionsApi = readFileSync(join(ROOT, 'api', 'missions.js'), 'utf8');
  const collabApi = readFileSync(join(ROOT, 'api', 'collab.js'), 'utf8');

  // Client: bearer attach + account fallback + honest 401.
  ok('api() merges AGRIOS_AUTH.authHeader() into request headers', /AGRIOS_AUTH[\s\S]{0,120}authHeader\(\)/.test(collab) && collab.indexOf('headers[hk] = ah[hk]') !== -1);
  ok('api() drops the session on HTTP 401 (handleAuthLost)', /status === 401[\s\S]{0,320}handleAuthLost\(\)/.test(collab));
  ok('init() subscribes to AGRIOS_AUTH.onChange', /AGRIOS_AUTH[\s\S]{0,80}onChange/.test(collab));
  ok('refreshSession() falls back to accountSession() when DB unauth', collab.indexOf('accountSession() || null') !== -1);
  ok('renderAlertsList() guards on !session with honest signed-out state', /function renderAlertsList\(\)\s*\{[\s\S]{0,600}?if \(!session\)[\s\S]{0,400}?alerts-signedout/.test(collab));
  ok('signed-out alerts never render a "0 alerts" summary', collab.indexOf('Sign in to load alerts') !== -1);
  ok('loadRules() guards on !session (rules-signedout)', /function loadRules\(\)\s*\{[\s\S]{0,400}?if \(!session\)[\s\S]{0,300}?rules-signedout/.test(collab));

  // Server: shared bridge + endpoint routing.
  ok('_auth exports resolveAnyAuth + requireAnyAuth', /export async function resolveAnyAuth/.test(authApi) && /export async function requireAnyAuth/.test(authApi));
  ok('bridge maps account owner→owner, operator→analyst', /owner:\s*'owner'[\s\S]{0,40}operator:\s*'analyst'/.test(authApi));
  ok('alerts endpoint uses requireAnyAuth', /requireAnyAuth/.test(alertsApi));
  ok('missions endpoint uses requireAnyAuth', /requireAnyAuth/.test(missionsApi));
  ok('collab endpoint uses requireAnyAuth', /requireAnyAuth/.test(collabApi));

  section('phase3: mode-switch scroll reset + transient overlay close (source contract)');
  const am = (app.match(/function activateMode\(id\)\{[\s\S]*?\n\}/) || [''])[0];
  ok('activateMode resets #workspace scrollTop to 0', /ws\.scrollTop\s*=\s*0/.test(am));
  ok('activateMode re-pins scrollTop on next animation frame (async hydration)', /requestAnimationFrame\([^)]*\)\s*=>\s*\{\s*ws\.scrollTop\s*=\s*0/.test(am));
  ok('activateMode closes the detail drawer on mode change', /activateMode[\s\S]*?closeDrawer\(\)/.test(am) || am.indexOf('closeDrawer()') !== -1);
  ok('activateMode closes the command palette on mode change', am.indexOf('closeCmdk()') !== -1);
  ok('activateMode closes the mobile nav on mode change', am.indexOf('closeMobileNav()') !== -1);
}

/* ============================ geospatial theater + Food War engine ============================ */
// Load the four pure, dependency-free UMD theater modules inside a node:vm
// context (same technique as the collab test) and assert dataset validity,
// filter/NL/URL semantics, simulation determinism/bounds, and the ATOM action
// allowlist. These modules attach to `window` and never touch the DOM.
function loadTheaterModules() {
  const files = ['theater-data.js', 'sim-engine.js', 'theater-filters.js', 'theater-actions.js', 'theater-globe.js', 'gibs.js', 'crop-risk.js'];
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

function testGibs() {
  section('theater: NASA GIBS satellite-context helper');
  const GIBS = loadTheaterModules().GIBS;
  const NOW = Date.parse('2026-07-12T00:00:00Z');
  ok('GIBS published', !!GIBS);
  ok('never labels imagery as live', GIBS.LIVE === false);
  ok('carries NASA GIBS attribution', /NASA|GIBS|EOSDIS/.test(GIBS.ATTRIBUTION));
  ok('source url is https', /^https:\/\//.test(GIBS.SOURCE_URL));
  ok('ships >=3 EPSG:3857 true-colour layers', GIBS.LAYERS.length >= 3 &&
    GIBS.LAYERS.every((l) => l.tileMatrixSet.indexOf('GoogleMapsCompatible') === 0 && l.cadence === 'daily'));

  // Default observation date is (now - latency), UTC ISO, i.e. yesterday.
  eq('defaultDate is now minus 1-day latency (UTC ISO)', GIBS.defaultDate(NOW, 'modis-terra'), '2026-07-11');
  const dates = GIBS.availableDates(NOW, 7, 'modis-terra');
  eq('availableDates count honored', dates.length, 7);
  eq('availableDates newest first', dates[0], '2026-07-11');
  ok('availableDates strictly descending ISO days', dates.every((d, i) => i === 0 || d < dates[i - 1]));
  ok('all dates are ISO YYYY-MM-DD', dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));

  const url = GIBS.tileUrlTemplate('modis-terra', '2026-07-11');
  ok('tile template targets EPSG:3857 best WMTS', url.indexOf('gibs.earthdata.nasa.gov/wmts/epsg3857/best') !== -1);
  ok('tile template embeds the WMTS layer id', url.indexOf('MODIS_Terra_CorrectedReflectance_TrueColor') !== -1);
  ok('tile template embeds the observation date', url.indexOf('/default/2026-07-11/') !== -1);
  ok('tile template uses GoogleMapsCompatible matrix set', url.indexOf('GoogleMapsCompatible_Level9') !== -1);
  ok('tile template keeps Leaflet {z}/{y}/{x} placeholders + jpg', /\{z\}\/\{y\}\/\{x\}\.jpg$/.test(url));
  ok('tile template carries NO api key / secret / token', !/(api_?key|token|secret|password)=/i.test(url));
  ok('unknown layer falls back to first layer (never throws)',
    (function () { try { return GIBS.tileUrlTemplate('nope').indexOf('MODIS_Terra') !== -1; } catch (e) { return false; } })());

  const label = GIBS.contextLabel('modis-terra', '2026-07-11');
  ok('context label names source-type + date + is explicit "not live"',
    /satellite context/i.test(label) && label.indexOf('2026-07-11') !== -1 && /not live/i.test(label));

  // Whole-world WMS GetMap snapshot (EPSG:4326 plate carrée) for the flat 2D canvas.
  const snap = GIBS.snapshotUrl('modis-terra', '2026-07-11', 2048, 1024);
  ok('snapshot uses public GIBS WMS EPSG:4326 endpoint', snap.indexOf('gibs.earthdata.nasa.gov/wms/epsg4326/best') !== -1);
  ok('snapshot is a WMS GetMap request', /SERVICE=WMS/.test(snap) && /REQUEST=GetMap/.test(snap));
  ok('snapshot embeds the WMTS layer id', snap.indexOf('MODIS_Terra_CorrectedReflectance_TrueColor') !== -1);
  ok('snapshot spans the whole globe (BBOX -90,-180,90,180)', snap.indexOf('BBOX=-90,-180,90,180') !== -1);
  ok('snapshot bakes the observation date into TIME', snap.indexOf('TIME=2026-07-11') !== -1);
  ok('snapshot returns jpeg', /FORMAT=image%2Fjpeg|FORMAT=image\/jpeg/.test(snap));
  ok('snapshot honors requested pixel dimensions', /WIDTH=2048/.test(snap) && /HEIGHT=1024/.test(snap));
  ok('snapshot carries NO api key / secret / token', !/(api_?key|token|secret|password)=/i.test(snap));
  ok('snapshotUrl never throws on unknown layer', (function () { try { GIBS.snapshotUrl('nope'); return true; } catch (e) { return false; } })());

  const fresh = GIBS.freshnessLabel('modis-terra', '2026-07-11');
  ok('freshness label states daily + observed date + not live',
    /daily/i.test(fresh) && fresh.indexOf('2026-07-11') !== -1 && /not live/i.test(fresh));

  // A whole-globe daily MODIS mosaic has real black orbit-gap gores; the preferred
  // visual underlay must be a gap-free (VIIRS) layer so the flat map renders clean.
  ok('MODIS layers are flagged as having daily swath gaps', GIBS.LAYER_BY_ID['modis-terra'].swathGaps === true && GIBS.LAYER_BY_ID['modis-aqua'].swathGaps === true);
  ok('ships a gap-free VIIRS layer', GIBS.LAYERS.some((l) => l.swathGaps === false && /VIIRS/i.test(l.wmtsId)));
  const vis = GIBS.defaultVisualLayerId();
  ok('defaultVisualLayerId picks a gap-free layer', GIBS.LAYER_BY_ID[vis].swathGaps === false);
  ok('default visual layer is not a gappy MODIS layer', vis.indexOf('modis') === -1);
}

function testCropRisk() {
  section('theater: animated crop-risk layer stack');
  const CR = loadTheaterModules().CROP_RISK;
  ok('CROP_RISK published', !!CR);
  ok('ships 8 risk layers', CR.LAYERS.length === 8);
  const ids = CR.LAYERS.map((l) => l.id).join(',');
  ok('layer roster covers required domains', ['crop-stress', 'drought', 'heat', 'flood', 'fertilizer', 'conflict', 'breadbasket-vuln', 'composite'].every((k) => ids.indexOf(k) !== -1));
  ok('every layer is labeled a modeled proxy (never fabricated observation)', CR.LAYERS.every((l) => l.evidence === 'modeled'));
  ok('every layer discloses methodology + limitations', CR.LAYERS.every((l) => l.methodology && l.limitations));
  ok('every layer cites observed structural inputs (https)', CR.LAYERS.every((l) => l.observedInputs.length > 0 && l.observedInputs.every((s) => /^https:\/\//.test(s.url))));

  // Bands never communicate by colour alone — each carries a pattern + marker.
  ok('4 risk bands with distinct non-colour channels', CR.BANDS.length === 4 &&
    new Set(CR.BANDS.map((b) => b.pattern)).size === 4 && CR.BANDS.every((b) => b.marker && b.label));
  eq('band(0) is low', CR.band(0).id, 'low');
  eq('band(0.3) is watch', CR.band(0.3).id, 'watch');
  eq('band(0.5) is elevated', CR.band(0.5).id, 'elevated');
  eq('band(0.9) is critical', CR.band(0.9).id, 'critical');

  // Deterministic intensity within [0,1].
  const a = CR.intensity('bb-blacksea', 'composite', 0.5, { severityBase: 0.9, commodityMatch: 1, shock: 0.6 });
  const b = CR.intensity('bb-blacksea', 'composite', 0.5, { severityBase: 0.9, commodityMatch: 1, shock: 0.6 });
  ok('intensity is deterministic', a === b);
  ok('intensity within [0,1]', a >= 0 && a <= 1);
  ok('envelope stays in [0,1] and rises over time', CR.envelope(0) >= 0 && CR.envelope(1) <= 1 && CR.envelope(0.8) > CR.envelope(0.1));

  const s = CR.series('bb-cerrado', 'drought', 12, (t) => ({ severityBase: 0.5, commodityMatch: 1, shock: t }));
  eq('series length is steps+1', s.length, 13);
  ok('series values all in [0,1]', s.every((v) => v >= 0 && v <= 1));

  const regions = [
    { id: 'bb-blacksea', name: 'Black Sea', seed: 'bb-blacksea', severityBase: 0.95, commodityMatch: 1 },
    { id: 'bb-france', name: 'France', seed: 'bb-france', severityBase: 0.2, commodityMatch: 1 },
    { id: 'ex-egypt', name: 'Egypt', seed: 'ex-egypt', severityBase: 0.7, commodityMatch: 1 },
  ];
  const ranked = CR.rankRegions('composite', 0.6, regions, { shock: 0.7 });
  eq('rankRegions returns all regions', ranked.length, 3);
  ok('rankRegions sorted by modeled intensity (desc)', ranked[0].value >= ranked[1].value && ranked[1].value >= ranked[2].value);
  ok('each ranked row carries band + pattern + marker', ranked.every((r) => r.band && r.pattern && r.marker));
  const summary = CR.summaryText('composite', 0.6, ranked);
  ok('accessible summary names the proxy nature + a marker glyph', /modeled proxy/i.test(summary) && summary.indexOf(ranked[0].marker) !== -1);
}

function testSimPhases() {
  section('theater: cinematic phased playback + causal ledger');
  const SIM = loadTheaterModules().SIM_ENGINE;
  ok('8 named playback phases', SIM.PHASES.length === 8);
  eq('phase order matches the cinematic arc',
    SIM.PHASES.map((p) => p.id).join(','),
    'trigger,chokepoint,rerouting,price,breadbasket,humanitarian,response,stabilization');

  const res = SIM.runSim({ preset: 'blacksea-blockade' });
  const phases = SIM.computePhases(res);
  eq('computePhases yields 8 segments', phases.length, 8);
  eq('first phase starts at day 0', phases[0].startDay, 0);
  ok('phase start days are monotonic non-decreasing', phases.every((p, i) => i === 0 || p.startDay >= phases[i - 1].startDay));
  ok('phase start days within horizon', phases.every((p) => p.startDay >= 0 && p.startDay <= res.horizon));
  eq('last phase ends at the horizon', phases[7].endDay, res.horizon);

  eq('phaseForDay(0) is trigger', SIM.phaseForDay(0, phases).id, 'trigger');
  eq('phaseForDay(horizon) is stabilization', SIM.phaseForDay(res.horizon, phases).id, 'stabilization');

  const ledger = SIM.phaseLedger(res);
  eq('ledger has one entry per phase', ledger.length, 8);
  ok('every ledger entry explains what/why/evidence/next', ledger.every((e) => e.changed && e.why && e.evidence && e.nextDecision));
  ok('every ledger entry discloses the modeled assumption', ledger.every((e) => /not a measured/i.test(e.assumption)));
  ok('ledger confidence stays within modeled bounds', ledger.every((e) => e.confidence == null || (e.confidence >= 30 && e.confidence <= 90)));
  ok('ledger is deterministic', JSON.stringify(SIM.phaseLedger(res)) === JSON.stringify(ledger));
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
  ok('arcColor near end is irrigation-blue', /^rgb\(70,150,190\)$/.test(GB.arcColor(0)));
  ok('arcColor far end is harvest-gold', /^rgb\(226,170,50\)$/.test(GB.arcColor(1)));
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

function testGibsWiring() {
  section('map: NASA GIBS satellite-context DOM wiring (assets/app.js source)');
  const src = readFileSync(join(ROOT, 'assets', 'app.js'), 'utf8');
  ok('consumes the GIBS helper', src.indexOf('window.GIBS') !== -1);
  ok('mounts a satellite-context control in Map mode', src.indexOf('data-testid="sat-control"') !== -1);
  ok('exposes an on/off toggle', src.indexOf('data-testid="sat-toggle"') !== -1);
  ok('exposes an imagery-layer selector', src.indexOf('data-testid="sat-layer"') !== -1);
  ok('exposes an observation-date selector', src.indexOf('data-testid="sat-date"') !== -1);
  ok('exposes an opacity control', src.indexOf('data-testid="sat-opacity"') !== -1);
  ok('renders NASA attribution + source link', src.indexOf('data-testid="sat-cite"') !== -1 && /G\.ATTRIBUTION|GIBS\.ATTRIBUTION/.test(src) && /SOURCE_URL/.test(src));
  ok('labels imagery as 2D-only / daily / not live', /2D only|not live/.test(src) && src.indexOf('data-testid="sat-label"') !== -1);
  ok('uses the GIBS Leaflet tile template', src.indexOf('tileUrlTemplate') !== -1 && src.indexOf('L.tileLayer') !== -1);
  ok('gracefully falls back to basemap on tile error', src.indexOf("'tileerror'") !== -1 || src.indexOf('tileerror') !== -1);
  const satBlock = src.slice(src.indexOf('NASA GIBS satellite context'), src.indexOf('function drawMarkers'));
  ok('carries NO api key / secret in imagery wiring', satBlock.length > 100 && !/(api_?key|token|secret)=/i.test(satBlock));
}

function testTheaterCinematicWiring() {
  section('theater: cinematic playback + crop-risk + ledger DOM wiring (source)');
  const src = readFileSync(join(ROOT, 'assets', 'theater.js'), 'utf8');
  // Phase timeline + readout driven by the pure SIM phase model.
  ok('computes phases + ledger from SIM_ENGINE', src.indexOf('SIM.computePhases') !== -1 && src.indexOf('SIM.phaseLedger') !== -1);
  ok('renders a phase timeline', src.indexOf('data-testid="sim-phasebar"') !== -1 && src.indexOf('pb-seg-') !== -1);
  ok('renders a live phase readout', src.indexOf('data-testid="sim-phase"') !== -1 && src.indexOf('phaseForDay') !== -1);
  // Causal ledger rail with what/why/evidence/assumption/next.
  ok('renders a causal ledger rail', src.indexOf('data-testid="sim-ledger"') !== -1 && src.indexOf('data-testid="ledger-entry"') !== -1);
  ok('ledger surfaces why + evidence + next decision', ['Why:', 'Evidence:', 'Next decision:'].every((k) => src.indexOf(k) !== -1));
  ok('selecting a phase/ledger entry flies to a node', src.indexOf('flyToPhase') !== -1);
  // Animated crop-risk overlay: layer select, legend (non-colour channels), ranking, a11y summary.
  ok('consumes CROP_RISK', src.indexOf('window.CROP_RISK') !== -1);
  ok('renders crop-risk layer selector', src.indexOf('data-testid="crop-layer"') !== -1);
  ok('renders crop-risk legend with pattern + marker (not colour alone)', src.indexOf('data-testid="crop-legend"') !== -1 && src.indexOf('data-pattern="') !== -1 && src.indexOf('.marker') !== -1);
  ok('renders region ranking linked to fly-to', src.indexOf('data-testid="crop-rank"') !== -1 && src.indexOf('data-testid="cr-row"') !== -1);
  ok('renders accessible crop-risk summary via summaryText', src.indexOf('data-testid="crop-summary"') !== -1 && src.indexOf('CR.summaryText') !== -1);
  ok('crop-risk phase fraction feeds the envelope', src.indexOf('phaseT()') !== -1);
  // ATOM deterministic mission card + strategic brief.
  ok('generates a deterministic ATOM mission brief', src.indexOf('data-testid="mission-brief"') !== -1 && src.indexOf('briefText') !== -1);
  ok('mission brief is explicitly modeled (not a forecast)', /modeled proxies for scenario exploration/.test(src));
  ok('offers create-mission + ask-ATOM actions', src.indexOf('data-testid="mission-card-btn"') !== -1 && src.indexOf('data-testid="mission-atom-btn"') !== -1);
  // Visibility pause + no runaway timers + reduced-motion safe.
  ok('pauses playback when tab/page hidden', src.indexOf('visibilitychange') !== -1 && src.indexOf('document.hidden') !== -1 && src.indexOf('onVisibility') !== -1);
  ok('guards the play timer against running while hidden', /document\.hidden[\s\S]*pause\(\)/.test(src));
  ok('reduced-motion uses a calmer single-day cadence', /REDUCED\s*\?\s*1\s*:\s*2/.test(src));
  // Keyboard transport + ARIA live announcements.
  ok('adds keyboard transport (space/arrows/home)', /k === ' '|Spacebar/.test(src) && src.indexOf('togglePlay()') !== -1);
  ok('announces phase changes to the SR live region', /theaterSr[\s\S]*phase/.test(src));
  ok('transport controls carry tooltips', src.indexOf('title="Play / pause (Space)"') !== -1);
}

function testTheaterSatelliteWiring() {
  section('theater: NASA GIBS satellite context + full-panel 2D map (source)');
  const src = readFileSync(join(ROOT, 'assets', 'theater.js'), 'utf8');
  const css = readFileSync(join(ROOT, 'index.html'), 'utf8');
  // Visible satellite-context control group with all required affordances.
  ok('renders a satellite control container', src.indexOf('data-testid="theater-sat-control"') !== -1);
  ok('has an on/off toggle', src.indexOf('data-testid="theater-sat-toggle"') !== -1 && src.indexOf('aria-pressed="') !== -1);
  ok('has a GIBS imagery-layer selector', src.indexOf('data-testid="theater-sat-layer"') !== -1);
  ok('has an observation-date selector', src.indexOf('data-testid="theater-sat-date"') !== -1);
  ok('has an opacity slider', src.indexOf('data-testid="theater-sat-opacity"') !== -1);
  ok('surfaces loading/error/fallback status', src.indexOf('data-testid="theater-sat-status"') !== -1);
  ok('surfaces a data-freshness label', src.indexOf('data-testid="theater-sat-fresh"') !== -1 && src.indexOf('G.freshnessLabel') !== -1);
  ok('shows NASA GIBS / Earthdata attribution + link', src.indexOf('data-testid="theater-sat-cite"') !== -1 && src.indexOf('G.SOURCE_URL') !== -1 && src.indexOf('G.ATTRIBUTION') !== -1);
  // Renders real NASA imagery via the pure GIBS helper, no fabricated tiles/secret.
  ok('consumes window.GIBS + snapshotUrl for imagery', src.indexOf('window.GIBS') !== -1 && src.indexOf('G.snapshotUrl') !== -1);
  ok('imagery path carries no api key / token / secret', !/(api_?key|token|secret|password)/i.test(src.slice(src.indexOf('function loadSatImage'), src.indexOf('function loadSatImage') + 500)));
  // Full-panel equirectangular 2D surface (not a tiny schematic rectangle).
  ok('2D map is a full-panel equirectangular surface', src.indexOf('function draw2DMap') !== -1 && src.indexOf('function flatMap') !== -1 && src.indexOf('W * st.zoom') !== -1);
  ok('2D ocean field fills the whole canvas', /fillRect\(0, 0, W, H\)/.test(src));
  ok('satellite control is shown only in 2D', src.indexOf('function updateSatVisibility') !== -1 && /st\.view === '2d'/.test(src));
  ok('toggling 2D/3D updates satellite visibility', /updateSatVisibility\(\);[\s\S]*?kick\(\); syncUrl\(\)/.test(src));
  // Graceful failure: keep the vector basemap, never a blank panel.
  ok('tracks an imagery-failed state', src.indexOf('st.sat.failed') !== -1);
  ok('image onerror falls back without blanking', /onerror[\s\S]*failed = true/.test(src) && src.indexOf('vector basemap') !== -1);
  ok('does not set crossOrigin (avoids needless CORS load failures)', src.indexOf('function loadSatImage') !== -1 && !/\.crossOrigin\s*=/.test(src));
  // Crop-risk overlay legible over imagery + its own visibility/opacity controls.
  ok('draws a crop-risk overlay on the map', src.indexOf('function drawCropOverlay') !== -1 && src.indexOf('drawCropOverlay()') !== -1);
  ok('crop overlay has a visibility toggle', src.indexOf('data-testid="theater-crop-overlay-toggle"') !== -1 && src.indexOf('st.cropOnMap') !== -1);
  ok('crop overlay has an opacity control', src.indexOf('data-testid="theater-crop-overlay-opacity"') !== -1 && src.indexOf('st.cropMapOpacity') !== -1);
  // Ledger density: a contained horizontally-navigable phase rail, not a wide grid.
  ok('ledger is a contained horizontal rail', src.indexOf('data-testid="ledger-rail"') !== -1);
  ok('ledger rail CSS scrolls horizontally within its region', /\.lg-rail\{[^}]*overflow-x:auto/.test(css));
  // Satellite overlay CSS: compact, 44px targets, mobile bottom-sheet, no overflow.
  ok('satellite overlay is positioned + compact', /\.th-sat\{[^}]*position:absolute/.test(css));
  ok('satellite toggle meets 44px touch target', /\.th-sat-toggle\{[^}]*min-height:44px/.test(css));
  ok('satellite overlay collapses on small viewports', /@media \(max-width:420px\)[\s\S]*\.th-sat\{/.test(css));

  // Regression: the imagery must composite as ONE clean rectangular destination,
  // never clipped into globe segments/arcs (that + MODIS gaps read as black wedges).
  const d2d = src.slice(src.indexOf('function draw2DMap'), src.indexOf('function drawLand'));
  ok('2D imagery draws a rectangular destination (drawImage w x h)', /drawImage\(satImg, ox, top, mw, mh\)/.test(d2d));
  ok('2D imagery branch does NOT clip to a globe disc/arc', d2d.indexOf('usingImagery') !== -1 && !/arc\(/.test(d2d.slice(d2d.indexOf('if (usingImagery'), d2d.indexOf('} else'))));
  ok('2D imagery branch performs no path clipping', !/\.clip\(\)/.test(d2d.slice(d2d.indexOf('if (usingImagery'), d2d.indexOf('} else'))));
  // Default underlay is the gap-free VIIRS layer, not a gap-streaked MODIS mosaic.
  ok('Theater 2D defaults to the gap-free visual layer', src.indexOf('G.defaultVisualLayerId()') !== -1 || src.indexOf('window.GIBS.defaultVisualLayerId()') !== -1);
  ok('warns when a MODIS (gappy) layer is selected', src.indexOf('swathGaps') !== -1);

  // Regression: mobile header cannot bleed past the root (body.scrollWidth<=375).
  // The variable-width identity + ATOM labels collapse to icons at <=1024, and the
  // brand is made the flex shrink-sink so no header child pins the row wider than
  // the viewport (Playwright measured .topbar-right right edge 381.59 > 375 before).
  const mq = css.slice(css.indexOf('@media (max-width:1024px)'), css.indexOf('@media (min-width:1025px)'));
  ok('identity label is hidden at <=1024 (no variable-width header bleed)', /\.identity-btn \.lbl\{display:none;?\}/.test(mq));
  ok('ATOM label is also hidden at <=1024', /\.btn-atom span\.lbl\{display:none;?\}/.test(mq));
  // Root-cause contract: the brand must be able to SHRINK (flex-shrink != 0), not
  // merely have min-width:0 — otherwise flex:0 0 auto pins the row to content width.
  ok('brand is the flex shrink-sink at <=1024 (flex:1 1 auto + min-width:0)', /\.brand\{flex:1 1 auto;min-width:0;?\}/.test(mq));
  ok('brand name ellipsizes when the row is tight', /\.brand \.name\{[^}]*text-overflow:ellipsis/.test(mq));

  // Exact sizing contract at the 375x812 phone: the FIXED-width chrome (both
  // gutters + hamburger + all three visible 44px topbar controls + their gaps +
  // the two header gaps + the brand logo, which is the brand's min content) must
  // sum to <= 375. If it does, the shrinkable brand guarantees body.scrollWidth<=375.
  const num = (re, s) => { const m = s.match(re); return m ? parseFloat(m[1]) : NaN; };
  const phone = css.slice(css.indexOf('@media (max-width:420px)'));
  const gutter = num(/header#topbar\{[^}]*padding:0 (\d+)px/, phone); // 12 at <=420
  const headerGap = num(/header#topbar\{[^}]*gap:(\d+)px/, phone);    // 10 at <=420
  const topbarGap = num(/\.topbar-right\{gap:(\d+)px;?\}/, mq);       // 10 at <=1024
  const touch = num(/min-height:44px;min-width:(\d+)px;/, css);      // 44px targets
  const logo = num(/\.brand \.logo\{width:(\d+)px/, css);            // 30px min brand
  const nCtrls = 3; // clock/openCmdk/openAlerts hidden -> theme + ATOM + identity
  ok('phone header gutter/gap/target values are present', [gutter, headerGap, topbarGap, touch, logo].every((n) => Number.isFinite(n)));
  const fixed = 2 * gutter + touch /* hamburger */ + 2 * headerGap +
                (nCtrls * touch + (nCtrls - 1) * topbarGap) /* topbar-right */ + logo;
  ok('fixed mobile header chrome fits within a 375px viewport (' + fixed + ' <= 375)', fixed <= 375);
  ok('root clips residual x-overflow at the viewport', /html\{overflow-x:clip;?\}/.test(css));
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

  // Isolate the ambient process.env: the adapter falls back to process.env when
  // the injected env lacks the key, so a developer with a real key exported must
  // not pollute the "missing env -> disabled" assertions. Restored in finally.
  const savedEnv = Object.prototype.hasOwnProperty.call(process.env, 'USDA_NASS_API_KEY')
    ? process.env.USDA_NASS_API_KEY : undefined;
  const hadEnv = savedEnv !== undefined;
  delete process.env.USDA_NASS_API_KEY;
  try {

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

  // ---- production regression: the real Vercel path -------------------------
  // In production, intel.js does not hand an explicit env down the chain — the
  // key is resolved from process.env. This guards THAT path (the one that broke
  // in prod), distinct from the explicit-env assertions above which always
  // passed. A present process.env.USDA_NASS_API_KEY must enable NASS through the
  // aggregate even when no `env` is passed; a missing one must disable it.
  section('nass: production-style process.env presence enables NASS through the aggregate');
  resetBreakers(); cacheClear();
  process.env.USDA_NASS_API_KEY = KEY;
  const aggProd = await aggregate({ adapters: [nassEntry], fetchImpl: fakeFetch({ 'quickstats.nass.usda.gov': { data } }), sleep: noSleep, now: Date.parse('2026-02-01T00:00:00Z') });
  const prodHealth = aggProd.sources.find((s) => s.id === 'nass');
  ok('present process.env.USDA_NASS_API_KEY enables NASS (no explicit env)', !!prodHealth && prodHealth.status === 'ok' && prodHealth.count === 4);
  ok('process.env key never leaks through the aggregate', JSON.stringify(aggProd).indexOf(KEY) === -1);

  resetBreakers(); cacheClear();
  delete process.env.USDA_NASS_API_KEY;
  const aggProdOff = await aggregate({ adapters: [nassEntry], fetchImpl: fakeFetch({}), sleep: noSleep, now: Date.parse('2026-02-01T00:00:00Z') });
  const prodOff = aggProdOff.sources.find((s) => s.id === 'nass');
  ok('absent process.env.USDA_NASS_API_KEY disables NASS (no explicit env)', !!prodOff && prodOff.status === 'disabled');
  ok('disabled reason distinguishes "not set" from blank', /not set/.test(prodOff.reason) && !/blank/.test(prodOff.reason));

  // blank/whitespace value is a distinct, diagnosable misconfig (not "not set")
  resetBreakers(); cacheClear();
  process.env.USDA_NASS_API_KEY = '   ';
  const aggBlank = await aggregate({ adapters: [nassEntry], fetchImpl: fakeFetch({}), sleep: noSleep, now: Date.parse('2026-02-01T00:00:00Z') });
  const blankRow = aggBlank.sources.find((s) => s.id === 'nass');
  ok('blank process.env value disables with a distinct reason', !!blankRow && blankRow.status === 'disabled' && /blank/.test(blankRow.reason));
  delete process.env.USDA_NASS_API_KEY;

  resetBreakers(); cacheClear();

  } finally {
    if (hadEnv) process.env.USDA_NASS_API_KEY = savedEnv;
    else delete process.env.USDA_NASS_API_KEY;
  }
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

/* ==================== design system (universal strategic portal) ==================== */
function testDesignSystem() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const app = readFileSync(join(ROOT, 'assets', 'app.js'), 'utf8');
  const rt = readFileSync(join(ROOT, 'assets', 'renderer-theme.js'), 'utf8');

  section('design-system: token files');
  const tokens = JSON.parse(readFileSync(join(ROOT, 'lib', 'tokens', 'design-tokens.json'), 'utf8'));
  const base = JSON.parse(readFileSync(join(ROOT, 'lib', 'tokens', 'brand-presets', 'base.json'), 'utf8'));
  const brand = JSON.parse(readFileSync(join(ROOT, 'lib', 'tokens', 'brand-presets', 'agrios.json'), 'utf8'));
  ok('design-tokens.json parses', !!tokens && typeof tokens === 'object');
  ok('accent-primary is agricultural crop-green', tokens.colorTokens.accentPrimary === '130 48% 46%');
  ok('nav height 81px desktop', tokens.layoutTokens.navHeight === '81px');
  ok('nav height 64px mobile', tokens.layoutTokens.navHeightMobile === '64px');
  ok('glass blur 20px', tokens.surfaceTokens.glassBlur === '20px');
  ok('card radius 1rem', tokens.radiusTokens.card === '1rem');
  ok('card pad 1.5rem / 2rem', tokens.spacingTokens.cardPad === '1.5rem' && tokens.spacingTokens.cardPadLarge === '2rem');
  ok('motion 180/300/700ms', tokens.motionTokens.durationInteraction === '180ms' && tokens.motionTokens.durationEntry === '300ms' && tokens.motionTokens.durationChart === '700ms');
  ok('max 5 chart series', tokens.chartTokens.maxSeriesPerChart === 5);

  section('design-system: brand-swap architecture');
  ok('base.json is content-free (no content payload)', !('content' in base) && !!base.structural);
  ok('base.json keeps structural constants', base.structural.layout.navHeightDesktop === '81px' && base.structural.surface.glassBlur === '20px');
  ok('base.json lists 16 content placeholders', Array.isArray(base.contentPlaceholders) && base.contentPlaceholders.length === 16);
  ok('agrios preset extends base', brand.extends === 'base.json');
  ok('agrios keeps crop-green accent override', brand.overrides.colorTokens.accentPrimary === '130 48% 46%');
  ok('agrios content: AgriOS / Nirmata / ATOM', brand.content.companyName === 'AgriOS' && brand.content.parentCompany === 'Nirmata Holdings' && brand.content.productName === 'ATOM');
  ok('agrios preset has no fabricated valuation/founder claims', brand.content.valuationOrOutcomeLanguage === '' && brand.content.founderStory === '');
  ok('agrios preset carries no forbidden sibling brands', ['clinixAI','antimatterai','rrg.bio','thingktangk','HumanOS'].every(b => JSON.stringify(brand).indexOf(b) === -1));

  section('design-system: CSS variable map + themes');
  ok('html defaults to dark theme', /<html[^>]*data-theme="dark"/.test(html));
  ok(':root light fallback defines semantic tokens', html.indexOf('--background:40 30% 88%') !== -1 && html.indexOf('--foreground:26 34% 11%') !== -1);
  ok('dark canonical block present', /\[data-theme="dark"\]\{[\s\S]*--background:30 20% 6%/.test(html));
  ok('accent-primary crop-green in dark block', html.indexOf('--accent-primary:130 48% 46%') !== -1);
  ok('chart tokens chart-1..5 present', ['--chart-1','--chart-2','--chart-3','--chart-4','--chart-5'].every(c => html.indexOf(c) !== -1));
  ok('legacy cyan alias maps to accent', /--cyan:hsl\(var\(--accent-primary\)\)/.test(html));
  ok('legacy red alias maps to danger (status only)', /--red:hsl\(var\(--danger\)\)/.test(html));
  ok('structural header height 81px + mobile 64px', html.indexOf('--header-h:81px') !== -1 && html.indexOf('--header-h:64px') !== -1);
  ok('body meets 16px floor', /font-size:16px;line-height:1\.5;/.test(html));

  section('design-system: primary accent migration (no red-as-primary)');
  ok('primary button uses accent, not red', /\.btn\.primary\{background:var\(--accent\)/.test(html) && html.indexOf('.btn.primary{background:var(--red)') === -1);
  ok('ATOM button uses accent', /\.btn-atom\{[\s\S]*background:var\(--accent\)/.test(html) && html.indexOf('.btn-atom{\n  background:var(--red)') === -1);
  ok('active tab marker uses accent', /\.mode-tab\.active \.ic\{color:var\(--accent\);?\}/.test(html));
  ok('two-tone headline accent clause uses accent', html.indexOf('.mode-head h2 em{font-style:normal;color:var(--accent);}') !== -1);

  section('design-system: agricultural redesign palette');
  const hueOf = (t) => parseInt(String(t).trim().split(/\s+/)[0], 10);
  // Crop-green primary, warm-clay danger, harvest-gold tertiary across the token cascade.
  ok('canonical accent hue in crop-green band (120-140)', hueOf(tokens.colorTokens.accentPrimary) >= 120 && hueOf(tokens.colorTokens.accentPrimary) <= 140);
  ok('canonical danger hue is warm clay-rust (<30)', hueOf(tokens.colorTokens.danger) < 30);
  ok('canonical tertiary hue is harvest gold (36-48)', hueOf(tokens.colorTokens.accentTertiary) >= 36 && hueOf(tokens.colorTokens.accentTertiary) <= 48);
  ok('dark surfaces are warm soil (hue 20-45)', hueOf(base.defaultColorTokens.dark.background) >= 20 && hueOf(base.defaultColorTokens.dark.background) <= 45);
  ok('light surfaces are warm parchment (hue 30-50)', hueOf(base.defaultColorTokens.light.background) >= 30 && hueOf(base.defaultColorTokens.light.background) <= 50);
  ok('no residual teal token (174 100% 45%) in design-tokens', JSON.stringify(tokens.colorTokens).indexOf('174 100% 45%') === -1);
  ok('agrios description drops teal/cyan wording', !/teal|cyan/i.test(brand.description));
  ok('no legacy cyan rgb (95,179,196) remains in stylesheet', html.indexOf('95,179,196') === -1);
  ok('no legacy red hex (#e2483d) remains in markup', html.toLowerCase().indexOf('#e2483d') === -1);
  ok('logo mark recolored to crop-green + harvest-gold', html.indexOf('stroke="#3ca85a"') !== -1 && html.indexOf('fill="#e6a92e"') !== -1);
  ok('renderer fallback accent is crop-green', rt.indexOf("accentPrimary: '130 48% 46%'") !== -1);
  const tdsrc = readFileSync(join(ROOT, 'assets', 'theater-data.js'), 'utf8');
  ok('theater severity neutral is warm soil (not cool grey)', /neutral:\s*'#8a7f6e'/.test(tdsrc) && tdsrc.indexOf('#7d8794') === -1);
  ok('commodities recolored off legacy palette', tdsrc.indexOf("'#e8b23a'") === -1 && tdsrc.indexOf("'#5fb3c4'") === -1);
  ok('field-furrow atmosphere layer present', /main#workspace::before\{[\s\S]*repeating-linear-gradient/.test(html));
  ok('nav active state carries accent glow', /\.mode-tab\.active\{[\s\S]*inset 3px 0 0 0 var\(--accent\)/.test(html));

  section('design-system: light parchment readability (WCAG AA regression)');
  // Parse the light :root block and compute real sRGB contrast ratios so the
  // parchment theme can never silently regress back to washed-out / near-white
  // foregrounds on cream again (the bd38adb visual-QA blocker).
  const lightBlock = (html.match(/:root\{\s*\/\* light fallback[\s\S]*?\n\}/) || [''])[0];
  const tok = (name) => { const m = lightBlock.match(new RegExp('--' + name + ':\\s*([0-9]+) ([0-9.]+)% ([0-9.]+)%')); return m ? { h:+m[1], s:+m[2], l:+m[3] } : null; };
  const lin = (c) => { c/=255; return c <= 0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const relLum = ({h,s,l}) => { s/=100; l/=100; const k=(n)=>{const a=s*Math.min(l,1-l);return l-a*Math.max(-1,Math.min(n-3,Math.min(9-n,1)));}; const f=(n)=>Math.round(255*k((n+h/30)%12)); return 0.2126*lin(f(0))+0.7152*lin(f(8))+0.0722*lin(f(4)); };
  const contrast = (a,b) => { const L1=relLum(a),L2=relLum(b); const hi=Math.max(L1,L2),lo=Math.min(L1,L2); return (hi+0.05)/(lo+0.05); };
  const Lbg = tok('background'), Lfg = tok('foreground'), Lmuted = tok('foreground-muted'), Lfaint = tok('foreground-faint'), Lsurf = tok('surface-c'), Lborder = tok('border-c'), Laccent = tok('accent-primary');
  ok('light tokens parsed from :root block', !!(Lbg && Lfg && Lmuted && Lsurf && Lborder && Laccent));
  ok('light body text vs background ≥ 7:1 (AA+)', contrast(Lfg, Lbg) >= 7);
  ok('light body text vs card surface ≥ 7:1 (AA+)', contrast(Lfg, Lsurf) >= 7);
  ok('light muted label vs surface ≥ 4.5:1 (AA)', contrast(Lmuted, Lsurf) >= 4.5);
  ok('light faint text vs surface ≥ 3:1 (AA large/non-text)', contrast(Lfaint, Lsurf) >= 3);
  ok('light green link/accent vs background ≥ 4.5:1 (AA)', contrast(Laccent, Lbg) >= 4.5);
  ok('light foreground is dark soil, not near-white (L ≤ 20)', Lfg.l <= 20);
  ok('light border visibly separates cards (surface↔border ΔL ≥ 18)', (Lsurf.l - Lborder.l) >= 18);
  ok('light card sits above ground (background darker than surface)', Lbg.l < Lsurf.l);
  // Structural washout guards.
  ok('topbar background is theme-driven, not hardcoded dark', /header#topbar\{[\s\S]*background:linear-gradient\(180deg, hsl\(var\(--surface-alt\)\), hsl\(var\(--background\)\)\)/.test(html) && html.indexOf('#1a1610') === -1 && html.indexOf('#12100a') === -1);
  ok('light atmosphere veil dialed down (no ≥0.07 radial wash)', /\[data-theme="light"\] main#workspace::before\{[\s\S]*accent-primary\) \/ 0\.04[\s\S]*accent-tertiary\) \/ 0\.03/.test(html));
  ok('light mode lifts cards with a soft shadow for separation', /\[data-theme="light"\] \.card,[\s\S]*box-shadow:0 1px 2px hsl\(var\(--overlay\)/.test(html));
  ok('no near-white body text token in light (foreground not 0% 9x%)', !/--foreground:\s*[0-9]+ [0-9.]+% (8[5-9]|9[0-9]|100)%/.test(lightBlock));

  section('design-system: agricultural amplification (depth + focal cues)');
  ok('workspace atmosphere layers a topographic cross-furrow set', (html.match(/main#workspace::before\{[\s\S]*?\}/) || [''])[0].match(/repeating-linear-gradient/g)?.length >= 2);
  ok('KPI cards carry lifted gradient surface + severity edge glow', /\.kpi\{background:linear-gradient\(180deg, var\(--surface-3\)/.test(html) && /\.kpi::before\{[\s\S]*box-shadow:1px 0 11px/.test(html));
  ok('mission cards carry green/gold state edge + severity wash', /\.mission\.sev-critical\{[\s\S]*linear-gradient\(90deg, hsl\(var\(--danger\) \/ 0\.07\)/.test(html));
  ok('map filters use decisive green active state', /\.mx-filters \.fbtn\.active\{background:linear-gradient\(180deg, hsl\(var\(--accent-primary\)/.test(html));
  ok('theater frame has a cinematic vignette (contrast/depth only)', /\.th-canvas-wrap::after\{[\s\S]*box-shadow:inset 0 0 130px/.test(html));
  ok('gate carries an agricultural-intelligence operational status cue', html.indexOf('class="gate-status"') !== -1 && html.indexOf('Global Agricultural Watch') !== -1 && html.indexOf('11 open-source feeds') !== -1);
  ok('gate status cue makes no fabricated live/real-time data claim', !/gate-status[\s\S]*?(live data|real-?time|updated \d|last updated)/i.test(html.slice(html.indexOf('class="gate-status"'), html.indexOf('class="gate-status"') + 400)));

  section('design-system: ATOM prompt-card legibility (no UA-black leak)');
  // The ATOM strategic prompt cards are <button class="card">; buttons don't
  // inherit the page color, so without an explicit token they render UA-black on
  // dark loam (the settled-QA blocker). Guard the explicit token + real contrast.
  const darkBlock = (html.match(/\[data-theme="dark"\]\{[\s\S]*?\n\}/) || [''])[0];
  const dtok = (name) => { const m = darkBlock.match(new RegExp('--' + name + ':\\s*([0-9]+) ([0-9.]+)% ([0-9.]+)%')); return m ? { h:+m[1], s:+m[2], l:+m[3] } : null; };
  const dFg = dtok('foreground'), dSurf = dtok('surface-c');
  ok('button-variant card pins explicit semantic foreground (no black leak)', /button\.card\{color:var\(--text\)/.test(html));
  ok('ATOM prompt card text pinned to foreground token', /#panel-atom \.cards \.card h4\{color:var\(--text\)/.test(html));
  ok('ATOM prompt card icon uses crop-green accent cue', /#panel-atom \.cards \.card \.ch \.ic:first-child\{color:var\(--accent\)/.test(html));
  ok('ATOM prompt card arrow uses muted (not black), greens on hover', /#panel-atom \.cards \.card \.ch \.ic:last-child\{color:var\(--muted\)/.test(html) && /#panel-atom \.cards \.card:hover \.ch \.ic:last-child\{color:var\(--accent\)/.test(html));
  ok('ATOM card focus state stays visible (accent outline)', /#panel-atom \.cards \.card:focus-visible\{outline:2px solid var\(--accent\)/.test(html));
  ok('dark ATOM card foreground is light bone, not near-black (L ≥ 80)', !!dFg && dFg.l >= 80);
  ok('dark ATOM prompt text vs card surface ≥ 7:1 (AA+)', contrast(dFg, dSurf) >= 7);
  ok('light ATOM prompt text vs card surface ≥ 7:1 (AA+)', contrast(Lfg, Lsurf) >= 7);
  ok('ATOM prompt cards are button.card in JS render', /ATOM_SUGGEST\.map\([\s\S]*?<button class="card"/.test(app));

  section('design-system: app shell + a11y');
  ok('skip-to-content link present and first', /<a href="#workspace" class="skip-link"/.test(html));
  ok('header scroll-progress element present', html.indexOf('id="scrollProgress"') !== -1);
  ok('scroll progress bound to #workspace in JS', app.indexOf('bindScrollProgress') !== -1 && /ws\.addEventListener\('scroll'/.test(app));
  ok('theme toggle control present', html.indexOf('data-testid="theme-toggle"') !== -1);
  ok('theme defaults to dark deterministically (no OS light override), memory-only, no storage',
     /function initTheme\(\)\{[\s\S]*applyTheme\('dark'\)/.test(app)
     && !/prefers-color-scheme:\s*light[\s\S]*initial\s*=\s*'light'/.test(app)
     && /applyTheme\(themeState==='dark'\?'light':'dark'\)/.test(app)
     && !/localStorage|sessionStorage|indexedDB/i.test(app));
  ok('nav is a tablist', /id="modes"[^>]*role="tablist"/.test(html));
  ok('tabs get role=tab + aria-selected + aria-controls', app.indexOf("setAttribute('role','tab')") !== -1 && app.indexOf("aria-selected") !== -1 && app.indexOf("aria-controls") !== -1);
  ok('panels get role=tabpanel', app.indexOf("setAttribute('role','tabpanel')") !== -1);
  ok('arrow-key roving nav implemented', app.indexOf('handleTabKeys') !== -1 && app.indexOf('ArrowRight') !== -1 && app.indexOf('ArrowLeft') !== -1);

  section('design-system: reduced motion');
  ok('reduced-motion media query present', html.indexOf('@media (prefers-reduced-motion: reduce)') !== -1);
  ok('reduced-motion disables animation, keeps short opacity/color', /prefers-reduced-motion: reduce\)\{[\s\S]*animation:none[\s\S]*transition-property:opacity/.test(html));
  ok('reduced-motion caps transition duration <120ms', /transition-duration:100ms !important/.test(html));

  section('design-system: transparency disclosure');
  ok('known-gaps disclosure rendered', html.indexOf('.known-gaps') !== -1 && app.indexOf('data-testid="known-gaps"') !== -1);
  ok('known-gaps derives from real source/summary metadata', /function knownGaps\(\)\{[\s\S]*intelData\.summary[\s\S]*intelData\.sources/.test(app));
  ok('known-gaps distinguishes down/stale/standby + modeled', app.indexOf("s.status==='down'") !== -1 && app.indexOf("s.status==='stale'") !== -1 && app.indexOf('Modeled proxies') !== -1);
  ok('known-gaps surfaces a confidence level', app.indexOf('confidence:') !== -1);

  section('design-system: renderer theme + charts');
  ok('renderer-theme.js loaded before app.js', html.indexOf('assets/renderer-theme.js') !== -1 && html.indexOf('assets/renderer-theme.js') < html.indexOf('assets/app.js'));
  ok('renderer theme exposes severity + series + grid', rt.indexOf('severityMap') !== -1 && rt.indexOf('series') !== -1 && rt.indexOf('grid') !== -1);
  ok('renderer theme reads CSS token variables at runtime', rt.indexOf('getComputedStyle') !== -1 && rt.indexOf('--accent-primary') !== -1);
  ok('charts bind grid/axis/series to renderer theme', app.indexOf('RT.grid()') !== -1 && app.indexOf('RT.axisLabel()') !== -1);
  ok('map markers use tokenized severity map', /RendererTheme\?RendererTheme\.severityMap\(\)/.test(app));

  section('design-system: globe fallback preserved');
  const globe = readFileSync(join(ROOT, 'assets', 'theater-globe.js'), 'utf8');
  ok('globe retains webgl capability + fallback path', globe.indexOf('getContext') !== -1 && (globe.indexOf('experimental-webgl') !== -1 || globe.indexOf('webgl') !== -1));

  section('design-system: mobile touch targets');
  ok('44px touch targets on mobile controls', /min-height:44px;min-width:44px;/.test(html));

  section('design-system: mobile drawer geometry + stacking');
  // Open rule cancels the slide transform so the panel sits fully on-screen.
  ok('open drawer cancels transform to translateX(0)', /nav#modes\.open\{[^}]*transform:translateX\(0\)/.test(html));
  ok('closed drawer slid off-screen by single transform', /nav#modes\{[^}]*transform:translateX\(-100%\)/.test(html));
  ok('drawer anchored at left:0 (no negative positional offset)', /nav#modes\{[^}]*left:0/.test(html));
  // Stacking topology. nav#modes is a DOM descendant of header#topbar, so the
  // header's z-index establishes the stacking context that traps the drawer;
  // the scrim is a root-level sibling of the header. The invariant that makes
  // tabs tappable is: scrim BELOW the header context (< header z-index) yet
  // above #workspace content (> 0). If the scrim ever rises above the header
  // again it repaints over the entire header subtree — including the drawer —
  // and intercepts every tab hit-test. This guards against that recurrence.
  const headerZ = Number((html.match(/header#topbar\{[^}]*z-index:(\d+)/) || [])[1]);
  const drawerZ = Number((html.match(/nav#modes\{[^}]*z-index:(\d+)/) || [])[1]);
  const scrimZ = Number((html.match(/\.nav-scrim\{[^}]*z-index:(\d+)/) || [])[1]);
  const headerBlock = (html.match(/<header id="topbar">[\s\S]*?<\/header>/) || [''])[0];
  ok('header z-index parsed', Number.isFinite(headerZ));
  ok('drawer (nav#modes) is nested inside the header stacking context', /id="modes"/.test(headerBlock));
  ok('scrim is a root-level sibling, not inside the header context', !/nav-scrim/.test(headerBlock));
  ok('scrim z-index below the header stacking context (cannot cover drawer)', scrimZ < headerZ);
  ok('scrim z-index above workspace content (still overlays for tap-close)', scrimZ > 0);
  ok('drawer z-index parsed (resolved within header context)', Number.isFinite(drawerZ));
  // Closed drawer must not expose focusable/clickable off-screen tabs.
  ok('closed drawer is visibility:hidden', /nav#modes\{[^}]*visibility:hidden/.test(html));
  ok('open drawer is visibility:visible', /nav#modes\.open\{[^}]*visibility:visible/.test(html));
  // No horizontal document overflow from the drawer.
  ok('drawer capped at viewport width', /nav#modes\{[^}]*max-width:100vw/.test(html));

  section('design-system: accessible drawer toggle behavior');
  // aria-expanded is driven from the same boolean that toggles the open class.
  ok('hamburger toggles open class + aria-expanded together',
    /const open=\$\('#modes'\)\.classList\.toggle\('open'\)/.test(app) &&
    /ham\.setAttribute\('aria-expanded',open\?'true':'false'\)/.test(app));
  ok('closeMobileNav clears open + resets aria-expanded=false',
    /function closeMobileNav\(\)\{[^}]*classList\.remove\('open'\)[^}]*aria-expanded'?,'?false/.test(app) ||
    /function closeMobileNav\(\)\{[\s\S]*?remove\('open'\)[\s\S]*?setAttribute\('aria-expanded','false'\)/.test(app));
  ok('Escape closes the mobile drawer', /e\.key==='Escape'[\s\S]*?closeMobileNav\(\)/.test(app));
  ok('selecting a mode closes the drawer', /activateMode\(m\.id\); closeMobileNav\(\)/.test(app));
  ok('scrim tap closes the drawer', /\$\('#navScrim'\)\.addEventListener\('click',closeMobileNav\)/.test(app));

  section('design-system: root horizontal containment (off-canvas panels)');
  // Closed off-canvas fixed panels (#atom, .drawer) slide off the right edge via
  // translateX(100%); their layout box overflows the viewport to the right and
  // would inflate documentElement.scrollWidth past clientWidth (measured 385>320
  // at 320px). The root must clip the x axis so scrollWidth<=clientWidth.
  ok('root clips horizontal overflow with overflow-x:clip', /html\{[^}]*overflow-x:clip/.test(html));
  // Must be `clip`, not `hidden`: clip does not create a scroll container, so it
  // neither forces overflow-y to auto nor adds a second vertical scroll region.
  ok('root does not use overflow:hidden (would create a scroll container)', !/html\{[^}]*overflow:hidden/.test(html));
  // Single vertical scroll region preserved: body never scrolls, #workspace does.
  ok('body stays overflow:hidden (no body scrolling)', /body\{[\s\S]*?overflow:hidden/.test(html));
  ok('#workspace remains the single vertical scroller', /main#workspace\{[^}]*overflow-y:auto/.test(html));
  // Off-canvas panels close by sliding right (this is what overflows without clip).
  ok('ATOM panel closes off-canvas via translateX(100%)', /#atom\{[^}]*transform:translateX\(100%\)/.test(html));
  ok('detail drawer closes off-canvas via translateX(100%)', /\.drawer\{[^}]*transform:translateX\(100%\)/.test(html));
  // Open panels are viewport-capped (vw) so the open state fits without overflow.
  ok('ATOM panel width capped to viewport (vw)', /#atom\{[^}]*width:min\([^)]*vw\)/.test(html));
  ok('detail drawer width capped to viewport (vw)', /\.drawer\{[^}]*width:min\([^)]*vw\)/.test(html));

  section('design-system: tablet/mobile nav breakpoint (no clipped-tab dead zone)');
  // The off-canvas drawer block is the one whose media query opens with the
  // 64px header override; capture its max-width threshold. At <=760 the desktop
  // tab strip collapsed at 768 (flexible nav shrank to 0 width, 8 tabs clipped
  // and unreachable, hamburger hidden) — a dead zone. The threshold must cover
  // tablet widths (>=1024, so 768 gets the drawer) yet stay below 1280 so the
  // 1280 desktop still shows the horizontal tab strip.
  const drawerBp = Number((html.match(/@media \(max-width:(\d+)px\)\{\s*:root\{--header-h:64px/) || [])[1]);
  ok('drawer breakpoint parsed', Number.isFinite(drawerBp));
  ok('drawer breakpoint covers 768 tablet (>=1024)', drawerBp >= 1024);
  ok('drawer breakpoint stays below 1280 (desktop keeps its tab strip)', drawerBp < 1280);
  ok('768 is inside the drawer range (hamburger pattern, not clipped tabs)', 768 <= drawerBp);
  ok('1280 is outside the drawer range (desktop nav)', 1280 > drawerBp);
  // Hamburger toggle exists within the drawer breakpoint and is hidden by default.
  ok('hamburger shown within drawer breakpoint', /\.hamburger\{display:inline-flex/.test(html));
  ok('hamburger hidden by default (desktop)', /\.hamburger\{display:none/.test(html));
  // Compact desktop chrome so all 8 in-header tabs fit within the viewport at the
  // tested desktop widths (1280 & 1600). Without trimming non-essential chrome the
  // ~804px tab strip scrolls off-screen at 1280 — this prevents that recurrence.
  const compactMq = html.match(/@media \(min-width:1025px\) and \(max-width:1600px\)\{[\s\S]*?\n\}/);
  const compact = compactMq ? compactMq[0] : '';
  ok('compact desktop chrome block present (1025–1600)', !!compactMq);
  ok('compact desktop hides clock to free tab space', /\.clock\{display:none/.test(compact));
  ok('compact desktop hides ATOM button label (icon retained)', /\.btn-atom span\.lbl\{display:none/.test(compact));
  ok('compact desktop hides brand tagline to free tab space', /\.brand \.div\{display:none/.test(compact));
  ok('compact desktop hides command-palette label', /#openCmdk \.lbl\{display:none/.test(compact));
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

/* ============================ Phase III: intel engine ============================ */
function testIntelEngine() {
  section('phase3: alert/mission/task state machines');
  ok('alert new->acknowledged', alertStatusCanTransition('new', 'acknowledged'));
  ok('alert new->escalated', alertStatusCanTransition('new', 'escalated'));
  ok('alert acknowledged->resolved', alertStatusCanTransition('acknowledged', 'resolved'));
  ok('alert resolved is terminal (no ->new)', !alertStatusCanTransition('resolved', 'new'));
  ok('alert idempotent same-status', alertStatusCanTransition('new', 'new'));
  ok('alert rejects unknown target', !alertStatusCanTransition('new', 'bogus'));
  eq('action acknowledge->acknowledged', alertActionToStatus('acknowledge'), 'acknowledged');
  eq('action escalate->escalated', alertActionToStatus('escalate'), 'escalated');
  eq('action resolve->resolved', alertActionToStatus('resolve'), 'resolved');
  eq('action unknown->null', alertActionToStatus('nope'), null);

  ok('mission proposed->active', missionStatusCanTransition('proposed', 'active'));
  ok('mission active->complete', missionStatusCanTransition('active', 'complete'));
  ok('mission blocked->active', missionStatusCanTransition('blocked', 'active'));
  ok('mission proposed->complete rejected', !missionStatusCanTransition('proposed', 'complete'));
  ok('mission archived terminal', !missionStatusCanTransition('archived', 'active'));

  ok('task todo->doing', taskStatusCanTransition('todo', 'doing'));
  ok('task doing->done', taskStatusCanTransition('doing', 'done'));
  ok('task done->todo (reopen)', taskStatusCanTransition('done', 'todo'));
  ok('task todo->bogus rejected', !taskStatusCanTransition('todo', 'bogus'));
  ok('ALERT_STATUS/TASK_STATUS/HORIZONS exported', ALERT_STATUS.length === 4 && TASK_STATUS.length === 4 && HORIZONS.length === 4);
  ok('intel MISSION_STATUS matches validate set', INTEL_MISSION_STATUS.join(',') === MISSION_STATUS.join(','));

  section('phase3: confidence never asserts certainty');
  ok('confidence in [0.2,0.9]', [
    computeConfidence({ basis: 'observed', severity: 'critical', sourceCount: 9, corroboration: 9 }),
    computeConfidence({ basis: 'modeled', severity: 'moderate', sourceCount: 0 }),
  ].every((c) => c >= 0.2 && c <= 0.9));
  ok('observed >= modeled at equal inputs',
    computeConfidence({ basis: 'observed', severity: 'high' }) >= computeConfidence({ basis: 'modeled', severity: 'high' }));
  ok('confidence strictly < 1 (no certainty)', computeConfidence({ basis: 'observed', severity: 'critical', sourceCount: 99, corroboration: 99 }) < 1);

  section('phase3: alert derivation (observed + modeled)');
  const ev = { id: 'e1', source: 'GDACS', title: 'Severe drought expands across Ethiopia wheat belt', severity: 'high', geography: 'Ethiopia', category: 'drought' };
  const a = alertFromEvent(ev);
  eq('observed alert basis', a.basis, 'observed');
  ok('observed alert not modeled', a.modeled === false);
  eq('observed alert horizon seasonal (drought)', a.horizon, 'seasonal');
  ok('observed alert detects wheat commodity', a.commodities.includes('wheat'));
  ok('observed alert carries causal chain', Array.isArray(a.causalChain) && a.causalChain.length >= 1);
  ok('observed alert has hedged assumption', a.assumptions.some((s) => /projection|not a certainty/i.test(s)));
  ok('alertFromEvent rejects titleless event', alertFromEvent({ source: 'x' }) === null);

  const modeled = alertsFromCropRisk([
    { region: 'Black Sea', commodity: 'wheat', score: 90, drivers: ['export ban', 'low rainfall'], sources: ['a', 'b'] },
    { region: 'South Asia', commodity: 'rice', score: 40 }, // below threshold -> ignored
  ]);
  eq('one modeled alert above threshold', modeled.length, 1);
  eq('modeled alert basis', modeled[0].basis, 'modeled');
  ok('modeled alert flagged modeled', modeled[0].modeled === true);
  ok('modeled alert severity critical (score>=85)', modeled[0].severity === 'critical');
  ok('modeled alert labels PROJECTION', modeled[0].assumptions.some((s) => /PROJECTION/.test(s)));

  const derived = deriveAlerts({ events: [ev, ev], cropRisk: [{ region: 'Black Sea', commodity: 'wheat', score: 90, drivers: [], sources: [] }] });
  ok('derive dedupes repeated events', derived.filter((x) => x.basis === 'observed').length === 1);
  ok('derive sorts critical first', SEVERITY_RANK[derived[0].severity] >= SEVERITY_RANK[derived[derived.length - 1].severity]);
  ok('every derived confidence < 1', derived.every((x) => x.confidence < 1));

  section('phase3: explainability panel');
  const x = explainAlert(modeled[0]);
  ok('explain marks modeled projection', x.modeled === true && /projection/i.test(x.label));
  ok('explain lists why-fired', Array.isArray(x.whyFired) && x.whyFired.length >= 1);
  ok('explain states uncertainty (no certainty)', /never implies certainty|uncertain|projection/i.test(x.uncertainty));
  ok('explain gives recommended decisions', x.recommendedDecisions.length >= 1);

  section('phase3: SLA clock');
  const noSla = slaClock({ status: 'active' });
  ok('no SLA when unset', noSla.hasSla === false);
  const breach = slaClock({ sla_minutes: 60, activated_at: new Date(Date.now() - 90 * 60000).toISOString(), status: 'active' });
  ok('SLA breached past budget', breach.breached === true && breach.remainingMs < 0);
  const atRisk = slaClock({ sla_minutes: 100, activated_at: new Date(Date.now() - 85 * 60000).toISOString(), status: 'active' });
  ok('SLA at-risk near budget', atRisk.atRisk === true && atRisk.breached === false);
  const done = slaClock({ sla_minutes: 60, activated_at: new Date(Date.now() - 999 * 60000).toISOString(), status: 'complete' });
  ok('completed mission not breached', done.breached === false);

  section('phase3: mission templates (five playbooks)');
  eq('exactly five templates', MISSION_TEMPLATES.length, 5);
  ['chokepoint-disruption', 'crop-failure', 'fertilizer-shock', 'humanitarian-surge', 'logistics-cyber']
    .forEach((k) => ok('template ' + k + ' present', !!templateByKey(k)));
  ok('all template pillars canonical', MISSION_TEMPLATES.every((t) => PILLARS.includes(t.pillar)));
  ok('all template priorities valid', MISSION_TEMPLATES.every((t) => MISSION_PRIORITY.includes(t.priority)));
  ok('templateByKey unknown -> null', templateByKey('nope') === null);
  const inst = instantiateTemplate('logistics-cyber', { geography: 'EU-27', sourceRef: 'alert:abc' });
  ok('instantiate seeds proposed mission', inst.mission.status === 'proposed' && inst.mission.templateKey === 'logistics-cyber');
  ok('instantiate carries overrides', inst.mission.geography === 'EU-27' && inst.mission.sourceRef === 'alert:abc');
  ok('instantiate seeds ordered tasks', inst.tasks.length >= 1 && inst.tasks[0].sort === 0 && inst.tasks[0].status === 'todo');
  ok('instantiate carries decision gates', Array.isArray(inst.gates) && inst.gates.length >= 1);
  ok('instantiate unknown -> null', instantiateTemplate('nope') === null);

  section('phase3: presence freshness (derived, never faked)');
  ok('online thresholds ordered', PRESENCE_ONLINE_MS < PRESENCE_AWAY_MS);
  eq('recent heartbeat -> online', presenceFreshness(new Date(Date.now() - 5000).toISOString()).status, 'online');
  eq('stale-ish -> away', presenceFreshness(new Date(Date.now() - 120000).toISOString()).status, 'away');
  eq('old -> offline', presenceFreshness(new Date(Date.now() - 999000).toISOString()).status, 'offline');
  eq('never seen -> offline', presenceFreshness(null).status, 'offline');

  section('phase3: @mention parsing');
  const rosterM = [{ id: 'u1', display_name: 'Ben Carter' }, { id: 'u2', display_name: 'Joel Smith' }];
  eq('matches first-name + dotted handle', JSON.stringify(parseMentions('ping @ben and @joel.smith now', rosterM)), JSON.stringify(['u1', 'u2']));
  eq('no mentions -> empty', JSON.stringify(parseMentions('no mentions here', rosterM)), '[]');
  eq('unknown handle ignored', JSON.stringify(parseMentions('@nobody here', rosterM)), '[]');

  section('phase3: deterministic ATOM builders (labeled AI-free fallback)');
  const ax = buildAlertExplanation(modeled[0]);
  ok('alert-explanation labeled deterministic', ax.generator === 'deterministic' && ax.kind === 'alert-explanation');
  ok('alert-explanation flags modeled', ax.modeled === true);
  const mb = buildMissionBrief({ title: 'Op X', objective: 'contain', priority: 'critical', geography: 'EU' }, { tasks: [{ title: 't1' }], alerts: [{}] });
  ok('mission-brief deterministic + fields', mb.generator === 'deterministic' && mb.objectives.includes('t1') && mb.title === 'Op X');
  const ac = buildActionCards({ severity: 'critical', basis: 'modeled' });
  ok('action-cards include escalate + corroborate', ac.cards.some((c) => c.action === 'escalate') && ac.cards.some((c) => c.action === 'corroborate'));
  const aa = buildAfterAction({ title: 'Op X', status: 'complete' }, { tasks: [{ status: 'done' }, { status: 'todo' }], decisions: [{ gate: 'g', decision: 'approve' }] });
  ok('after-action deterministic + tallies tasks', aa.generator === 'deterministic' && aa.tasksCompleted === '1/2');
  ok('after-action flags residual tasks', aa.lessons.some((l) => /residual|not all/i.test(l)));
}

/* ============================ Phase IV: agricultural relevance gating ============================ */
// BUG2 — the derive pass must stop mirroring every raw hazard (earthquakes,
// prescribed/wildfires) into the Alert Center. It scores each hazard for genuine
// agricultural exposure and only promotes high-relevance OBSERVED signals; severe
// borderline hazards become clearly MODELED projections; the rest stay in Intel.
function testAgRelevanceGating() {
  section('phase4: agricultural relevance scoring (pure engine)');

  // Ag-category + commodity + breadbasket region + severity ⇒ high relevance.
  const droughtScore = agRelevanceScore({ text: 'Severe drought expands across Ethiopia wheat belt', category: 'drought', severity: 'high' });
  ok('drought/wheat/Ethiopia scores at/above promotion bar', droughtScore >= AG_PROMOTE_THRESHOLD);
  // Generic hazard with no ag signal ⇒ near-zero, well below the modeled bar.
  const quakeScore = agRelevanceScore({ text: 'M6.2 earthquake near Fiji', category: 'earthquake', severity: 'high' });
  ok('bare earthquake scores below modeled threshold', quakeScore < AG_MODEL_THRESHOLD);
  ok('drought scores strictly higher than bare earthquake', droughtScore > quakeScore);
  // A team rule matching the hazard biases relevance upward (explicit intent).
  const withRule = agRelevanceScore({ text: 'flooding disrupts Mekong rice paddies', category: 'flood', severity: 'moderate', rules: [{ min_severity: 'moderate', categories: ['flood'], geographies: [] }] });
  const noRule = agRelevanceScore({ text: 'flooding disrupts Mekong rice paddies', category: 'flood', severity: 'moderate' });
  ok('matching team rule raises relevance', withRule > noRule);
  ok('score clamped to 0..100', agRelevanceScore({ text: 'wheat maize rice soy fertilizer drought flood cyclone', category: 'drought', severity: 'critical', rules: [{ min_severity: 'moderate', categories: ['drought'], geographies: [] }] }) <= 100);

  section('phase4: classifyEvent (observed / modeled / skip)');
  const droughtEv = { id: 'e1', source: 'GDACS', title: 'Severe drought expands across Ethiopia wheat belt', severity: 'high', geography: 'Ethiopia', category: 'drought' };
  const cObs = classifyEvent(droughtEv);
  eq('agriculturally-relevant hazard promoted to observed', cObs.kind, 'observed');
  ok('promoted observed carries ag-relevance', cObs.observed.agRelevance >= AG_PROMOTE_THRESHOLD);

  const quakeEv = { id: 'q1', source: 'USGS', title: 'M6.2 earthquake near Fiji', severity: 'high', geography: 'Fiji', category: 'earthquake' };
  eq('low-relevance raw earthquake skipped (stays in Intel)', classifyEvent(quakeEv).kind, 'skip');
  const fireEv = { id: 'f1', source: 'InciWeb', title: 'Prescribed fire in Oregon', severity: 'moderate', geography: 'Oregon', category: 'fire' };
  eq('low-relevance prescribed fire skipped', classifyEvent(fireEv).kind, 'skip');

  // Severe hazard at a grain chokepoint: borderline relevance + severe ⇒ MODELED.
  const chokeEv = { id: 'm1', source: 'USGS', title: 'Major earthquake strikes near Suez Canal', severity: 'critical', geography: 'Egypt', category: 'earthquake' };
  const cMod = classifyEvent(chokeEv);
  eq('severe borderline hazard becomes modeled projection', cMod.kind, 'modeled');
  eq('modeled projection basis is modeled', cMod.modeled.basis, 'modeled');
  ok('modeled projection flagged modeled', cMod.modeled.modeled === true);
  ok('modeled projection hedges severity one notch below observed', cMod.modeled.severity === 'high');
  ok('modeled projection confidence < 1 (never certainty)', cMod.modeled.confidence < 1);
  ok('modeled projection labels PROJECTION + links observed evidence',
    cMod.modeled.assumptions.some((s) => /PROJECTION/.test(s)) &&
    cMod.modeled.causalChain.some((c) => c.step === 'observed-evidence'));
  ok('modeled projection records ag-relevance in [MODEL,PROMOTE)',
    cMod.modeled.agRelevance >= AG_MODEL_THRESHOLD && cMod.modeled.agRelevance < AG_PROMOTE_THRESHOLD);

  section('phase4: deriveAlertsDetailed (gating + stats + dedupe)');
  const { alerts, stats } = deriveAlertsDetailed({
    events: [droughtEv, droughtEv, quakeEv, fireEv, chokeEv],
    cropRisk: [{ region: 'Black Sea', commodity: 'wheat', score: 90, drivers: [], sources: [] }],
  });
  eq('stats.considered counts every event', stats.considered, 5);
  eq('exactly one observed promoted (deduped)', stats.promotedObserved, 1);
  eq('two low-relevance hazards skipped', stats.skippedLowRelevance, 2);
  ok('modeled count includes projection + crop-risk', stats.modeled >= 2);
  ok('no duplicate keys emitted', new Set(alerts.map((a) => a.key)).size === alerts.length);
  ok('every derived alert confidence < 1', alerts.every((a) => a.confidence < 1));
  ok('raw earthquake/fire never reach the alert list',
    !alerts.some((a) => a.basis === 'observed' && /earthquake|prescribed fire/i.test(a.title)));

  section('phase4: alertRelevance drives suppression reconciliation');
  // A stored raw-hazard row (QA-era mirror) scores below the promotion bar →
  // reconciliation suppresses it; a genuine ag row stays.
  const rawRow = { title: 'M5.9 earthquake near Fiji', category: 'earthquake', geography: 'Fiji', severity: 'high', commodities: [], regions: [] };
  const agRow = { title: 'Drought devastates Ethiopia wheat harvest', category: 'drought', geography: 'Ethiopia', severity: 'high', commodities: ['wheat'], regions: ['Horn of Africa'] };
  ok('raw-hazard row falls below promotion bar (suppressible)', alertRelevance(rawRow) < AG_PROMOTE_THRESHOLD);
  ok('genuine ag row stays at/above promotion bar (preserved)', alertRelevance(agRow) >= AG_PROMOTE_THRESHOLD);
}

/* ============================ Phase III: migration 002 shape ============================ */
function testMigrationPhase3() {
  section('phase3 migration: lifecycle columns + new tables');
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  ok('has a 002 phase3 migration', files.some((f) => /002/.test(f)));
  const sql = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n').toLowerCase();

  ['alert_status', 'task_status', 'presence_status'].forEach((e) =>
    ok('creates enum ' + e, sql.includes("create type " + e)));

  // Alert lifecycle columns added idempotently.
  ['status', 'basis', 'confidence', 'horizon', 'regions', 'commodities', 'causal_chain', 'assumptions', 'owner_id', 'mission_id']
    .forEach((c) => ok('alerts adds column ' + c, sql.includes('add column if not exists ' + c) || new RegExp('add column if not exists\\s+' + c).test(sql)));
  ok('alter uses add column if not exists (idempotent)', !/add column (?!if not exists)/.test(sql));

  ['mission_tasks', 'mission_decisions', 'mission_events', 'room_presence', 'room_messages']
    .forEach((t) => ok('creates table ' + t, sql.includes('create table if not exists ' + t)));

  ok('mission sub-resources cascade on mission delete', /mission_tasks[\s\S]*references missions\(id\) on delete cascade/.test(sql));
  ok('presence keyed by team+user', /room_presence[\s\S]*primary key \(team_id, user_id\)/.test(sql));
  ok('messages store mentions array', /room_messages[\s\S]*mentions\s+text\[\]/.test(sql));
  ok('phase3 tenant-scoped by team_id', /mission_tasks[\s\S]*team_id/.test(sql) && /room_messages[\s\S]*team_id/.test(sql));
}

/* ============================ Phase III: API + client hygiene ============================ */
function testPhase3Hygiene() {
  section('phase3 hygiene: no secrets / forbidden brands / storage');
  const files = ['api/_intel.js', 'api/alerts.js', 'api/missions.js', 'api/collab.js'];
  const forbidden = ['clinixai', 'antimatterai', 'rrg.bio', 'thingktangk', 'humanos'];
  const secretEnv = ['DATABASE_URL', 'PPLX_KEY', 'AGRIOS_AUTH_SECRET', 'AGRIOS_SESSION_SECRET', 'MIGRATE_TOKEN'];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    const low = src.toLowerCase();
    forbidden.forEach((b) => ok(`${f} has no forbidden brand ${b}`, !low.includes(b)));
    // No hardcoded secret VALUES (referencing process.env.X by name is fine).
    secretEnv.forEach((k) => ok(`${f} does not hardcode ${k} value`, !new RegExp(k + "\\s*[:=]\\s*['\"]").test(src)));
  }
  const intel = readFileSync(join(ROOT, 'api/_intel.js'), 'utf8');
  ok('_intel.js is DB/DOM/network free', !/from '\.\/_db|require\(|\bfetch\(|document\.|localStorage/.test(intel));
  ok('_intel.js never emits confidence 1.0 literally in cap', intel.includes('Math.min(0.9'));

  section('phase3 hygiene: War Room client honesty');
  const collab = readFileSync(join(ROOT, 'assets/collab.js'), 'utf8');
  ok('collab client no localStorage', !/localStorage\s*[.[]/.test(collab));
  ok('collab client no sessionStorage', !/sessionStorage\s*[.[]/.test(collab));
  ok('collab client no document.cookie', collab.indexOf('document.cookie') === -1);
  ok('collab client no indexedDB', !/indexedDB\s*\./.test(collab));
}

/* ============================ Phase III: cold-start schema bootstrap ============================ */
// The production 500s (GET/POST /api/missions, /api/alerts) were caused by
// migration 002_phase3.sql never being applied on Vercel cold starts —
// migrations only run via the CLI or the token-gated endpoint, so production
// had 001 (auth works) but not 002, and every Phase III query hit a missing
// column/relation. api/_bootstrap.js closes that gap: each endpoint awaits
// ensureSchema(), which idempotently applies pending migrations under a Postgres
// advisory lock, recording each in a schema_migrations ledger.
//
// These tests drive the REAL bootstrap SQL through a fake pg pool installed on
// globalThis.__AGRI_PG_POOL__ (no DATABASE_URL, no network), asserting the exact
// statement sequence, the ledger contract, caching, concurrency de-duplication,
// failure-reset, and the endpoints' generic (non-leaky) 500 on bootstrap failure.

function makeFakePool(opts = {}) {
  const calls = [];
  const applied = new Set(opts.applied || []);
  let connects = 0;
  const client = {
    query(text, params) {
      const t = String(text);
      calls.push({ text: t, params });
      if (opts.failOn && opts.failOn.test(t)) {
        return Promise.reject(Object.assign(new Error('boom-from-db'), { code: '42P01' }));
      }
      if (/select\s+filename\s+from\s+schema_migrations/i.test(t)) {
        return Promise.resolve({ rows: [...applied].map((f) => ({ filename: f })) });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
  };
  const pool = {
    connect() { connects++; return Promise.resolve(client); },
    query(text, params) { return client.query(text, params); },
  };
  return { pool, calls, connects: () => connects };
}

function makeRes() {
  return {
    statusCode: 0,
    _payload: null,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(s) { this._payload = s; return this; },
  };
}

async function testBootstrapSchema() {
  section('phase3 bootstrap: cold-start schema application (integration)');

  const prevPool = globalThis.__AGRI_PG_POOL__;
  const resetReady = () => { globalThis.__AGRI_SCHEMA_READY__ = null; };

  const { ensureSchema } = await import('../api/_bootstrap.js');
  const migNames = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

  // --- Case 1: fresh DB, both migrations apply in order under a lock ---------
  {
    const fake = makeFakePool();
    globalThis.__AGRI_PG_POOL__ = fake.pool;
    resetReady();
    await ensureSchema();

    const texts = fake.calls.map((c) => c.text);
    const low = texts.join('\n').toLowerCase();
    const idxLock = texts.findIndex((t) => /pg_advisory_lock/.test(t));
    const idxUnlock = texts.findIndex((t) => /pg_advisory_unlock/.test(t));
    const idxLedger = texts.findIndex((t) => /create table if not exists schema_migrations/i.test(t));
    const idxRead = texts.findIndex((t) => /select\s+filename\s+from\s+schema_migrations/i.test(t));

    ok('acquires advisory lock first', idxLock === 0);
    ok('creates schema_migrations ledger after lock', idxLedger > idxLock);
    ok('reads applied ledger before running migrations', idxRead > idxLedger);
    ok('releases advisory lock at the end', idxUnlock === texts.length - 1);
    ok('lock is released after it is acquired', idxUnlock > idxLock);
    ok('runs migrations only once per bootstrap (single connect)', fake.connects() === 1);

    // Real migration SQL flowed through the client (001 + 002 content).
    ok('applies 001 schema (users table)', low.includes('create table if not exists users'));
    ok('applies 002 schema (mission_tasks table)', low.includes('create table if not exists mission_tasks'));
    ok('applies 002 alert lifecycle column', low.includes('add column if not exists status'));

    // Each migration file recorded in the ledger with its filename.
    const inserts = fake.calls.filter((c) => /insert into schema_migrations/i.test(c.text));
    ok('records every migration file in the ledger', inserts.length === migNames.length);
    ok('ledger insert is ON CONFLICT DO NOTHING (idempotent)',
      inserts.every((c) => /on conflict do nothing/i.test(c.text)));
    ok('ledger insert carries the filename param',
      migNames.every((n) => inserts.some((c) => c.params && c.params[0] === n)));
    // Migration SQL runs strictly between lock and unlock.
    const idx002 = texts.findIndex((t) => /mission_tasks/.test(t));
    ok('migration DDL runs inside the lock', idx002 > idxLock && idx002 < idxUnlock);
  }

  // --- Case 2: warm container — cached, no re-run --------------------------
  {
    const fake = makeFakePool();
    globalThis.__AGRI_PG_POOL__ = fake.pool;
    // Do NOT reset ready: the promise from Case 1 is still cached.
    await ensureSchema();
    ok('warm container does not re-run bootstrap (0 new connects)', fake.connects() === 0);
  }

  // --- Case 3: already-applied ledger — lock taken, no DDL re-applied -------
  {
    const fake = makeFakePool({ applied: migNames });
    globalThis.__AGRI_PG_POOL__ = fake.pool;
    resetReady();
    await ensureSchema();
    const low = fake.calls.map((c) => c.text).join('\n').toLowerCase();
    ok('skips already-applied migrations', !low.includes('create table if not exists mission_tasks'));
    ok('still acquires + releases the lock', /pg_advisory_lock/.test(low) && /pg_advisory_unlock/.test(low));
    ok('does not re-insert ledger rows', !/insert into schema_migrations/i.test(low));
  }

  // --- Case 4: concurrent cold starts share one bootstrap run --------------
  {
    const fake = makeFakePool();
    globalThis.__AGRI_PG_POOL__ = fake.pool;
    resetReady();
    await Promise.all([ensureSchema(), ensureSchema(), ensureSchema()]);
    ok('concurrent callers de-duplicate to a single run', fake.connects() === 1);
  }

  // --- Case 5: failure resets the cache so a later request retries ----------
  {
    const bad = makeFakePool({ failOn: /pg_advisory_lock/ });
    globalThis.__AGRI_PG_POOL__ = bad.pool;
    resetReady();
    let threw = false;
    try { await ensureSchema(); } catch (_) { threw = true; }
    ok('bootstrap failure propagates', threw);
    ok('failed bootstrap clears the cached promise (retryable)', globalThis.__AGRI_SCHEMA_READY__ == null);
    // A subsequent healthy call re-runs and succeeds.
    const good = makeFakePool();
    globalThis.__AGRI_PG_POOL__ = good.pool;
    await ensureSchema();
    ok('retry after failure runs the bootstrap again', good.connects() === 1);

    // If a migration statement itself fails, the advisory lock is still released
    // (finally), so a later container is never blocked by an orphaned lock.
    const midFail = makeFakePool({ failOn: /create table if not exists mission_tasks/i });
    globalThis.__AGRI_PG_POOL__ = midFail.pool;
    resetReady();
    let midThrew = false;
    try { await ensureSchema(); } catch (_) { midThrew = true; }
    ok('mid-migration failure propagates', midThrew);
    ok('advisory lock released even when a migration fails (finally)',
      midFail.calls.some((c) => /pg_advisory_unlock/.test(c.text)));
  }

  // --- Case 6: bootstrap failure surfaces as a generic, non-leaky 500 -------
  {
    const bad = makeFakePool({ failOn: /pg_advisory_lock/ });
    globalThis.__AGRI_PG_POOL__ = bad.pool;
    resetReady();
    const { default: missionsHandler } = await import('../api/missions.js');
    const res = makeRes();
    await missionsHandler({ method: 'GET', query: {}, headers: {} }, res);
    ok('missions returns 500 when schema bootstrap fails', res.statusCode === 500);
    const payload = String(res._payload || '');
    ok('500 body is generic server_error', /"error":"server_error"/.test(payload));
    ok('500 body never leaks raw SQL / DB error', !/advisory|schema_migrations|boom-from-db|42P01/i.test(payload));
    let parsed = {};
    try { parsed = JSON.parse(payload); } catch (_) {}
    ok('500 body invites a retry (starting up)', /starting up/i.test(parsed.message || ''));
  }

  // Restore global state so later tests are unaffected.
  resetReady();
  if (prevPool === undefined) delete globalThis.__AGRI_PG_POOL__;
  else globalThis.__AGRI_PG_POOL__ = prevPool;
}

/* ============================ Phase III: schema/endpoint contract ============================ */
// Cross-check that every Phase III relation/column the endpoints actually query
// exists in the migration SQL, that endpoints await the bootstrap before any DB
// work, and that migrations contain no destructive statements (so bootstrap can
// never drop or truncate production data).
function testBootstrapContract() {
  section('phase3 bootstrap: schema/endpoint contract + wiring + safety');

  const migSql = readdirSync(join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql')).sort()
    .map((f) => readFileSync(join(ROOT, 'migrations', f), 'utf8')).join('\n').toLowerCase();

  // Tables the Phase III endpoints read/write must exist in the migrations.
  ['missions', 'mission_tasks', 'mission_decisions', 'mission_events', 'alerts',
    'alert_reads', 'room_presence', 'room_messages']
    .forEach((t) => ok('migration provides table ' + t, migSql.includes('create table if not exists ' + t)));

  // Columns selected by missions.js / alerts.js must be provisioned by 002.
  ['sla_minutes', 'activated_at', 'template_key', 'outcome']
    .forEach((c) => ok('missions provisions column ' + c, migSql.includes(c)));
  ['basis', 'confidence', 'horizon', 'regions', 'commodities', 'causal_chain', 'assumptions', 'owner_id', 'mission_id']
    .forEach((c) => ok('alerts provisions column ' + c, migSql.includes(c)));

  // No destructive DDL/DML in the migrations — bootstrap must be non-destructive.
  ok('migrations contain no DROP TABLE', !/drop\s+table/i.test(migSql));
  ok('migrations contain no DROP COLUMN', !/drop\s+column/i.test(migSql));
  ok('migrations contain no TRUNCATE', !/truncate/i.test(migSql));
  ok('migrations contain no DELETE FROM', !/delete\s+from/i.test(migSql));

  // _bootstrap.js contract: advisory lock, ledger, idempotent record, unlock in finally.
  const boot = readFileSync(join(ROOT, 'api', '_bootstrap.js'), 'utf8');
  ok('_bootstrap uses pg_advisory_lock', boot.includes('pg_advisory_lock'));
  ok('_bootstrap releases pg_advisory_unlock', boot.includes('pg_advisory_unlock'));
  ok('_bootstrap unlocks in a finally block', /finally\s*\{[\s\S]*pg_advisory_unlock/.test(boot));
  ok('_bootstrap uses a schema_migrations ledger', boot.includes('schema_migrations'));
  ok('_bootstrap records via ON CONFLICT DO NOTHING', /on conflict do nothing/i.test(boot));
  ok('_bootstrap caches readiness on globalThis', boot.includes('__AGRI_SCHEMA_READY__'));
  ok('_bootstrap clears the cache on failure', /__AGRI_SCHEMA_READY__\s*=\s*null/.test(boot));
  ok('_bootstrap consumes loadMigrations()', boot.includes('loadMigrations'));

  // _migrate.js exposes the shared loader that bootstrap reuses.
  const mig = readFileSync(join(ROOT, 'api', '_migrate.js'), 'utf8');
  ok('_migrate exports loadMigrations', /export function loadMigrations/.test(mig));
  ok('runMigrations reuses loadMigrations', /runMigrations[\s\S]*loadMigrations\(\)/.test(mig));

  // _db.js exposes withClient for session-scoped (advisory-lock) work.
  const db = readFileSync(join(ROOT, 'api', '_db.js'), 'utf8');
  ok('_db exports withClient', /export async function withClient/.test(db));
  ok('withClient releases the client in finally', /withClient[\s\S]*finally\s*\{[\s\S]*release\(\)/.test(db));

  // Every Phase III endpoint awaits ensureSchema() before serving, and logs a
  // safe (secret-free) diagnostic rather than leaking SQL on failure.
  for (const f of ['api/alerts.js', 'api/missions.js', 'api/collab.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    ok(`${f} imports ensureSchema`, /from '\.\/_bootstrap\.js'/.test(src) && src.includes('ensureSchema'));
    ok(`${f} awaits schema before auth`, /await ensureReady\(res\)/.test(src));
    ok(`${f} ensureReady runs before requireAnyAuth`,
      src.indexOf('ensureReady(res)') < src.indexOf('requireAnyAuth(req'));
    ok(`${f} logs a safe diagnostic on bootstrap failure`, src.includes('schema_bootstrap_failed'));
    ok(`${f} returns a retryable startup message`, /starting up/i.test(src));
    // Diagnostics must not log secret values.
    ['DATABASE_URL', 'AGRIOS_AUTH_SECRET', 'AGRIOS_SESSION_SECRET', 'MIGRATE_TOKEN']
      .forEach((k) => ok(`${f} bootstrap diag does not reference ${k}`, !src.includes(k)));
  }
}

/* ============================ Phase IV: BUG1/BUG2/UX source contract ============================ */
// Pin the exact wiring for the Phase IV corrections in code, complementing the
// functional/engine tests: (1) auxiliary Phase III endpoints bridge the account
// bearer and never leak secrets; (2) the client recovers the account session on
// auxiliary 401 / mode activation instead of poisoning it; (3) alert derivation
// gates on ag-relevance and reconciles low-relevance rows non-destructively while
// preserving protected records; (4) the mission composer closes/refreshes and a
// closed drawer is inert/aria-hidden.
function testPhase4CorrectionContract() {
  section('phase4: auxiliary endpoints bridge account bearer (teams/scenarios)');
  for (const f of ['api/teams.js', 'api/scenarios.js']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    ok(`${f} imports ensureSchema`, /from '\.\/_bootstrap\.js'/.test(src) && src.includes('ensureSchema'));
    ok(`${f} authenticates via requireAnyAuth (account-bearer bridge)`, /requireAnyAuth/.test(src));
    // Strip line comments before checking that no *code* still calls the DB-only
    // requireAuth (prose may still explain the switch away from it).
    ok(`${f} no longer routes through DB-only requireAuth`, !/\brequireAuth\b/.test(src.replace(/\/\/.*$/gm, '')));
    ok(`${f} awaits ensureReady before auth`, /await ensureReady\(res\)/.test(src));
    ok(`${f} ensureReady runs before requireAnyAuth`,
      src.indexOf('ensureReady(res)') < src.indexOf('requireAnyAuth(req'));
    ok(`${f} logs a safe (secret-free) diagnostic on bootstrap failure`, src.includes('schema_bootstrap_failed'));
    ok(`${f} returns a retryable startup message`, /starting up/i.test(src));
    ['DATABASE_URL', 'AGRIOS_AUTH_SECRET', 'AGRIOS_SESSION_SECRET', 'MIGRATE_TOKEN', 'PPLX_KEY']
      .forEach((k) => ok(`${f} does not reference secret ${k}`, !src.includes(k)));
  }

  section('phase4: roster merge surfaces account operators without secrets');
  const accts = readFileSync(join(ROOT, 'api', '_accounts.js'), 'utf8');
  ok('_accounts exports publicRoster', /export function publicRoster/.test(accts));
  // Static guard: the roster map must project only email/name/role — never
  // salt/hash. (Runtime guard below asserts the same on real output.)
  const rosterBody = (accts.match(/export function publicRoster[\s\S]*?\n\}/) || [''])[0];
  ok('publicRoster never projects salt', !/\bsalt\b/.test(rosterBody.replace(/\/\/.*$/gm, '')));
  ok('publicRoster never projects hash', !/\bhash\b/.test(rosterBody.replace(/\/\/.*$/gm, '')));
  const teams = readFileSync(join(ROOT, 'api', 'teams.js'), 'utf8');
  ok('teams merges publicRoster into the member list', teams.includes('publicRoster') && /mergeRoster/.test(teams));
  ok('roster-only entries are flagged account:true (display-only, not assignable)', /account:\s*true/.test(teams));

  // Runtime guard on the real projection: seed a two-user roster and assert the
  // output carries email/name/role only.
  const roster = publicRoster({
    AGRIOS_AUTH_USERS_JSON: JSON.stringify([
      { email: 'ben@x.example', name: 'Ben', role: 'owner', salt: 'deadbeefdeadbeef', hash: 'a'.repeat(128) },
      { email: 'joel@x.example', name: 'Joel', role: 'operator', salt: 'feedfacefeedface', hash: 'b'.repeat(128) },
    ]),
  });
  ok('publicRoster returns the seeded operators', roster.length === 2 && roster[0].email === 'ben@x.example');
  ok('publicRoster output omits salt/hash entirely',
    roster.every((r) => !('salt' in r) && !('hash' in r) && r.role && r.name));

  section('phase4: client recovers account session (no global poison)');
  const collab = readFileSync(join(ROOT, 'assets', 'collab.js'), 'utf8');
  ok('handleAuthLost recovers to accountSession before dropping', /function handleAuthLost\(\)\s*\{[\s\S]{0,200}?accountSession\(\)/.test(collab));
  ok('handleAuthLost is loop-safe on the equivalent account session', /session\.user\.id === recovered\.user\.id\) return/.test(collab));
  ok('ensureAccountRecovery restores account session when session is null', /function ensureAccountRecovery\(\)\s*\{[\s\S]{0,160}?accountSession\(\)/.test(collab));
  ok('Command activation triggers account recovery', /function onCommandRendered\(\)\s*\{\s*ensureAccountRecovery\(\)/.test(collab));
  ok('War Room activation triggers account recovery', /function onSimRendered\(\)\s*\{\s*ensureAccountRecovery\(\)/.test(collab));
  ok('roster-only account entries excluded from role management', /canManage && !isMe && !m\.account/.test(collab));
  ok('roster-only account entries excluded from assignee picker', /if \(m\.account\) return;/.test(collab));

  section('phase4: alert derivation gates + non-destructive reconciliation');
  const alerts = readFileSync(join(ROOT, 'api', 'alerts.js'), 'utf8');
  ok('derive path uses relevance-gated deriveAlertsDetailed', alerts.includes('deriveAlertsDetailed'));
  ok('default alert query hides suppressed alerts', /metadata->>'suppressed'\)::boolean, false\) = false/.test(alerts));
  ok('reconciliation marks suppressed via resolved status (no DELETE)', /reconcileLowRelevance/.test(alerts) && /status\s*=\s*'resolved'/.test(alerts));
  ok('reconciliation records an audit trail (audit-preserving)', /audit\(ctx, 'alert\.suppress'/.test(alerts));
  ok('reconciliation records a suppress reason', /low_ag_relevance/.test(alerts));
  // Protected records must never be suppressed: the reconcile predicates guard
  // acknowledged/escalated/mission-linked/user-owned/already-suppressed rows.
  const reconcile = (alerts.match(/async function reconcileLowRelevance[\s\S]*?\n\}/) || [''])[0];
  ['acknowledged_at IS NULL', 'escalated_at IS NULL', 'mission_id IS NULL', 'owner_id IS NULL']
    .forEach((p) => ok('reconcile preserves protected rows via ' + p, reconcile.includes(p)));
  ok('reconcile only touches auto-generated observed NEW rows', /status = 'new'/.test(reconcile) && /basis = 'observed'/.test(reconcile));
  ok('reconcile UPDATE re-asserts predicates (no clobber of concurrent human action)',
    /UPDATE alerts[\s\S]*?SET status = 'resolved'[\s\S]*?acknowledged_at IS NULL AND escalated_at IS NULL/.test(reconcile));
  // Reconciliation is non-destructive: it never DELETEs/DROPs/TRUNCATEs alert
  // data. (A user-initiated rule-delete on alert_rules is a separate, allowed
  // action and is explicitly not alert-record data.)
  ok('reconcile never deletes alert data', !/\bdelete\b/i.test(reconcile));
  ok('alerts.js never DROPs/TRUNCATEs and never deletes from alerts',
    !/\bdrop\s+table\b/i.test(alerts) && !/\btruncate\b/i.test(alerts) && !/delete\s+from\s+alerts\b/i.test(alerts));

  section('phase4: mission composer close/refresh + drawer a11y (inert)');
  ok('mission create closes the composer drawer', /Mission created[\s\S]{0,80}?A\.closeDrawer\(\)/.test(collab) || /A\.closeDrawer\(\);\s*renderTeamMissions\(\)/.test(collab));
  ok('mission create refreshes the team mission list/count', /A\.closeDrawer\(\);\s*renderTeamMissions\(\)/.test(collab));
  const app = readFileSync(join(ROOT, 'assets', 'app.js'), 'utf8');
  ok('closeDrawer marks the drawer aria-hidden AND inert', /function closeDrawer\(\)\{[\s\S]*?aria-hidden','true'[\s\S]*?setAttribute\('inert'/.test(app));
  ok('openDrawer clears inert so the visible drawer is focusable', /function openDrawer\([\s\S]*?removeAttribute\('inert'\)/.test(app));
}

/* ======== canonical shared-workspace provisioning (functional) ======== */

// Replicates api/_auth.js accountTeamSlug so the test can predict the legacy
// per-account slug used for migration.
function testSlug(emailNorm) {
  const base = String(emailNorm).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return 'acct-' + (base || 'operator');
}

// Stateful in-memory Postgres stand-in that models exactly the queries the
// canonical-workspace provisioning path issues (users/teams/team_members
// upserts, membership lookup, role sync, and the team_id repointing migration).
// Both pool.query and the transaction client share ONE store, so upsert
// idempotency and ON CONFLICT semantics are honoured.
function makeCanonicalPool(seed = {}) {
  const store = {
    users: new Map(),   // email_norm -> { id, email, display_name }
    teams: new Map(),   // slug -> { id, name, created_by }
    members: new Map(), // `${team_id}|${user_id}` -> { team_id, user_id, role }
    migrations: [],     // recorded team_id repointing UPDATEs (non-destructive)
    nextUser: 1, nextTeam: 1,
  };
  for (const t of seed.legacyTeams || []) store.teams.set(t.slug, { id: t.id, name: t.name || 'Legacy', created_by: null });

  const calls = [];
  function run(text, params) {
    const t = String(text);
    const low = t.toLowerCase();
    calls.push({ text: t, params });
    if (/^\s*(begin|commit|rollback)/i.test(low)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/pg_advisory/i.test(low)) return Promise.resolve({ rows: [], rowCount: 0 });

    if (/insert into users/i.test(low) && /on conflict \(email_norm\)/i.test(low)) {
      const [email, emailNorm, name] = params;
      let u = store.users.get(emailNorm);
      if (!u) { u = { id: 'user-' + (store.nextUser++), email, display_name: name }; store.users.set(emailNorm, u); }
      else { u.display_name = name; }
      return Promise.resolve({ rows: [{ id: u.id, email: u.email, display_name: u.display_name }], rowCount: 1 });
    }
    if (/insert into teams/i.test(low)) {
      const [name, slug, createdBy] = params;
      let tm = store.teams.get(slug);
      // ON CONFLICT (slug) DO UPDATE SET name = teams.name -> keep existing name.
      if (!tm) { tm = { id: 'team-' + (store.nextTeam++), name, created_by: createdBy }; store.teams.set(slug, tm); }
      return Promise.resolve({ rows: [{ id: tm.id }], rowCount: 1 });
    }
    if (/insert into team_members/i.test(low)) {
      const [teamId, userId, role] = params;
      store.members.set(teamId + '|' + userId, { team_id: teamId, user_id: userId, role });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/select id from teams where slug/i.test(low)) {
      const tm = store.teams.get(params[0]);
      return Promise.resolve({ rows: tm ? [{ id: tm.id }] : [], rowCount: tm ? 1 : 0 });
    }
    if (/from users u join team_members tm/i.test(low) && /email_norm/i.test(low)) {
      const [emailNorm, teamId] = params;
      const u = store.users.get(emailNorm);
      const mem = u && store.members.get(teamId + '|' + u.id);
      if (!u || !mem) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [{ user_id: u.id, email: u.email, display_name: u.display_name, role: mem.role }], rowCount: 1 });
    }
    if (/update team_members set role/i.test(low)) {
      const [role, teamId, userId] = params;
      const mem = store.members.get(teamId + '|' + userId);
      if (mem) mem.role = role;
      return Promise.resolve({ rows: [], rowCount: mem ? 1 : 0 });
    }
    if (/set team_id/i.test(low)) { // migrateTeamData: repoint only, never delete
      store.migrations.push({ text: t, params });
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  const client = { query: run, release() {} };
  const pool = { connect() { return Promise.resolve(client); }, query: run };
  return { pool, store, calls };
}

async function testCanonicalWorkspaceProvisioning() {
  section('phase4b: account bearers provision ONE canonical shared workspace team');

  const prevPool = globalThis.__AGRI_PG_POOL__;
  const prevUsers = process.env.AGRIOS_AUTH_USERS_JSON;
  const prevSecret = process.env.AGRIOS_SESSION_SECRET;
  const resetCanon = () => { delete globalThis.__AGRI_CANONICAL_TEAM__; };

  process.env.AGRIOS_SESSION_SECRET = 'test-session-secret-0123456789';
  process.env.AGRIOS_AUTH_USERS_JSON = JSON.stringify([
    { email: 'ben@nirmata.example', name: 'Ben Kessler', role: 'owner', salt: 'a'.repeat(16), hash: 'b'.repeat(128) },
    { email: 'joel@nirmata.example', name: 'Joel Ramirez', role: 'operator', salt: 'c'.repeat(16), hash: 'd'.repeat(128) },
  ]);
  const tokBen = signSession({ email: 'ben@nirmata.example', name: 'Ben Kessler', role: 'owner' }).token;
  const tokJoel = signSession({ email: 'joel@nirmata.example', name: 'Joel Ramirez', role: 'operator' }).token;
  const reqBen = { headers: { authorization: 'Bearer ' + tokBen } };  // no cookie -> DB session skipped
  const reqJoel = { headers: { authorization: 'Bearer ' + tokJoel } };

  try {
    // --- Case 1: both configured accounts resolve the SAME team; roles mapped -
    {
      const fake = makeCanonicalPool();
      globalThis.__AGRI_PG_POOL__ = fake.pool;
      resetCanon();

      const ctxBen = await resolveAnyAuth(reqBen);
      const ctxJoel = await resolveAnyAuth(reqJoel);

      ok('account owner resolves an auth context', !!ctxBen && ctxBen.account === true);
      ok('account operator resolves an auth context', !!ctxJoel && ctxJoel.account === true);
      ok('both accounts land in the SAME canonical team', !!ctxBen.teamId && ctxBen.teamId === ctxJoel.teamId);
      ok('owner keeps the owner role', ctxBen.role === 'owner');
      ok('operator maps to analyst (clears the write boundary)', ctxJoel.role === 'analyst');
      // Real, assignable DB user ids — NOT synthetic display-only "account:" ids.
      ok('members carry real DB user ids (assignable)',
        /^user-/.test(ctxBen.user.id) && /^user-/.test(ctxJoel.user.id) && ctxBen.user.id !== ctxJoel.user.id);
      ok('exactly one canonical team was created', fake.store.teams.size === 1);
      ok('canonical team is named AgriOS Command', [...fake.store.teams.values()][0].name === 'AgriOS Command');
      ok('canonical slug is derived from the owner email', fake.store.teams.has(testSlug('ben@nirmata.example')));
      // Roster (= team_members) holds BOTH members regardless of presence/heartbeat.
      const canonId = ctxBen.teamId;
      ok('roster/membership includes both members (offline members still listed)',
        fake.store.members.has(canonId + '|' + ctxBen.user.id) && fake.store.members.has(canonId + '|' + ctxJoel.user.id));
      // No secrets leak into the resolved context.
      const blob = JSON.stringify(ctxBen) + JSON.stringify(ctxJoel);
      ok('resolved context never leaks provisioning placeholder / secrets',
        !/account-provisioned/.test(blob) && !blob.includes('b'.repeat(128)) && !/password/i.test(blob));
    }

    // --- Case 2: idempotent + concurrent provisioning (no dupes) --------------
    {
      const fake = makeCanonicalPool();
      globalThis.__AGRI_PG_POOL__ = fake.pool;
      resetCanon();
      const [a, b, c] = await Promise.all([resolveAnyAuth(reqBen), resolveAnyAuth(reqJoel), resolveAnyAuth(reqBen)]);
      ok('concurrent sign-ins all resolve the one canonical team',
        a.teamId === b.teamId && b.teamId === c.teamId);
      ok('concurrent provisioning creates no duplicate team', fake.store.teams.size === 1);
      ok('concurrent provisioning creates no duplicate memberships', fake.store.members.size === 2);
      // Re-resolving after the warm cache is populated is a stable no-op on identity.
      const again = await resolveAnyAuth(reqBen);
      ok('re-resolve is stable (idempotent)', again.teamId === a.teamId && again.role === 'owner');
    }

    // --- Case 3: legacy per-account team data migrates in non-destructively ---
    {
      const legacySlug = testSlug('joel@nirmata.example');
      const fake = makeCanonicalPool({ legacyTeams: [{ slug: legacySlug, id: 'legacy-joel' }] });
      globalThis.__AGRI_PG_POOL__ = fake.pool;
      resetCanon();
      const ctxBen = await resolveAnyAuth(reqBen); // first sign-in reconciles all accounts
      const canonId = ctxBen.teamId;

      ok('legacy per-account team data is migrated (team_id repointed)', fake.store.migrations.length > 0);
      ok('migration repoints FROM the legacy team INTO canonical',
        fake.store.migrations.every((m) => m.params[0] === 'legacy-joel' && m.params[1] === canonId));
      ok('migration covers Phase III collaboration tables (missions + messages)',
        fake.store.migrations.some((m) => /update missions/i.test(m.text)) &&
        fake.store.migrations.some((m) => /update room_messages/i.test(m.text)));
      ok('migration is non-destructive (only UPDATE ... SET team_id, never DELETE/DROP/TRUNCATE)',
        fake.store.migrations.every((m) => /^update/i.test(m.text.trim())) &&
        !fake.store.migrations.some((m) => /\b(delete|drop|truncate)\b/i.test(m.text)));
      ok('alerts/presence migration guards unique/PK collisions with NOT EXISTS',
        fake.store.migrations.some((m) => /update alerts/i.test(m.text) && /not exists/i.test(m.text)) &&
        fake.store.migrations.some((m) => /update room_presence/i.test(m.text) && /not exists/i.test(m.text)));
    }

    // --- Case 4: @mentions resolve to the real shared-team member ids ---------
    {
      const roster = [
        { id: 'user-1', display_name: 'Ben Kessler', email: 'ben@nirmata.example' },
        { id: 'user-2', display_name: 'Joel Ramirez', email: 'joel.smith@nirmata.example' },
      ];
      ok('@Joel resolves by display-name first token (case-insensitive)',
        parseMentions('[QA] channel verified @Joel', roster).join() === 'user-2');
      ok('@BEN resolves case-insensitively to the owner id',
        parseMentions('ack @BEN', roster).join() === 'user-1');
      ok('@joel.smith resolves by email local-part',
        parseMentions('ping @joel.smith please', roster).join() === 'user-2');
      const both = parseMentions('@ben and @joel together', roster).sort();
      ok('both members resolve, deduped, to real ids', both.length === 2 && both[0] === 'user-1' && both[1] === 'user-2');
      ok('an unknown @handle resolves to nobody', parseMentions('@nobody here', roster).length === 0);
    }
  } finally {
    if (prevPool === undefined) delete globalThis.__AGRI_PG_POOL__; else globalThis.__AGRI_PG_POOL__ = prevPool;
    if (prevUsers === undefined) delete process.env.AGRIOS_AUTH_USERS_JSON; else process.env.AGRIOS_AUTH_USERS_JSON = prevUsers;
    if (prevSecret === undefined) delete process.env.AGRIOS_SESSION_SECRET; else process.env.AGRIOS_SESSION_SECRET = prevSecret;
    resetCanon();
  }
}

// Source-contract guards on the canonical-workspace implementation in _auth.js.
function testCanonicalWorkspaceContract() {
  section('phase4b: canonical-workspace source contract (_auth.js)');
  const src = readFileSync(join(ROOT, 'api', '_auth.js'), 'utf8');
  ok('provisions ONE canonical workspace (not per-account)', /ensureCanonicalWorkspace/.test(src));
  ok('serializes provisioning with a transaction-scoped advisory lock',
    /pg_advisory_xact_lock/.test(src) && /withTransaction/.test(src));
  ok('team/user/membership upserts are idempotent (ON CONFLICT)',
    /on conflict \(email_norm\)/i.test(src) && /on conflict \(slug\)/i.test(src) && /on conflict \(team_id, user_id\)/i.test(src));
  ok('canonical team preserves an existing name on conflict', /do update set name = teams\.name/i.test(src));
  ok('migration repoints team_id and never deletes history',
    /migrateTeamData/.test(src) && /set team_id = \$2 where team_id = \$1/i.test(src));
  const migrate = (src.match(/async function migrateTeamData[\s\S]*?\n\}/) || [''])[0];
  ok('migration is non-destructive (no DELETE/DROP/TRUNCATE)', !/\b(delete|drop|truncate)\b/i.test(migrate));
  ok('alerts migration guards UNIQUE(team_id,event_key) via NOT EXISTS',
    /update alerts a set team_id[\s\S]*?not exists/i.test(migrate));
  ok('presence migration guards PK(team_id,user_id) via NOT EXISTS',
    /update room_presence p set team_id[\s\S]*?not exists/i.test(migrate));
  ok('account roles map owner->owner, operator->analyst',
    /owner:\s*'owner'/.test(src) && /operator:\s*'analyst'/.test(src));
  // Account-provisioned user rows can never authenticate through the DB login path.
  ok('account-provisioned rows are non-authenticating placeholders', /account-provisioned-no-db-login/.test(src));
  // No secret env names hardcoded/leaked in the auth bridge.
  ['DATABASE_URL', 'AGRIOS_AUTH_SECRET', 'AGRIOS_SESSION_SECRET', 'MIGRATE_TOKEN', 'PPLX_KEY']
    .forEach((k) => ok('_auth.js does not reference secret ' + k, !src.includes(k)));

  // Collab roster + mention wiring feed real emails into mention resolution.
  const collab = readFileSync(join(ROOT, 'api', 'collab.js'), 'utf8');
  ok('collab roster query selects u.email (for mention resolution)', /u\.email/.test(collab));
  ok('collab passes email into parseMentions roster', /parseMentions\([\s\S]*?email: m\.email/.test(collab));
  const intel = readFileSync(join(ROOT, 'api', '_intel.js'), 'utf8');
  ok('parseMentions matches the email local-part', /email[\s\S]*?split\('@'\)\[0\]/.test(intel));
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
    testIntelEngine();
    testAgRelevanceGating();
    testMigrationPhase3();
    testPhase3Hygiene();
    await testBootstrapSchema();
    testBootstrapContract();
    await testCollabRace();
    await testWarRoomCollab();
    await testPhase3AccountAuth();
    testPhase3AuthWiringSource();
    testPhase4CorrectionContract();
    await testCanonicalWorkspaceProvisioning();
    testCanonicalWorkspaceContract();
    testTheaterData();
    testTheaterFilters();
    testSimEngine();
    testTheaterActions();
    testGibs();
    testCropRisk();
    testSimPhases();
    testTheaterGlobe();
    testGibsWiring();
    testTheaterCinematicWiring();
    testTheaterSatelliteWiring();
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
    testDesignSystem();
    await testAccounts();
  } catch (e) {
    console.error('\nFATAL: test harness threw:', e && e.message);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.error('Failing: ' + failures.join('; ')); process.exit(1); }
  process.exit(0);
})();
