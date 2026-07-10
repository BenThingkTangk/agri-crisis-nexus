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

/* ============================ run ============================ */
(async function main() {
  console.log('AGRI-NEXUS collaboration test suite');
  try {
    await testCrypto();
    testRbac();
    await testValidation();
    testHttp();
    testMigration();
  } catch (e) {
    console.error('\nFATAL: test harness threw:', e && e.message);
    process.exit(1);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.error('Failing: ' + failures.join('; ')); process.exit(1); }
  process.exit(0);
})();
