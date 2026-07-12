// AgriOS account authentication — env-backed, DB-free, stateless bearer sessions.
//
// This is the *account* sign-in layer for the two initial Nirmata Holdings
// operators (distinct from the outer access gate, and distinct from the
// DB-backed team/collaboration sessions in _auth.js). It exists so the app can
// enforce real, server-validated identity + role WITHOUT provisioning a
// database and WITHOUT any browser persistence.
//
// Design:
//   - User records come ONLY from process.env.AGRIOS_AUTH_USERS_JSON. No raw
//     passwords or hashes ever live in client files, the repo, tests, fixtures,
//     logs, URLs, errors, telemetry, or API responses.
//   - Passwords are verified with Node scrypt + constant-time comparison.
//   - Sessions are short-lived, signed (HMAC-SHA256 over the payload with
//     AGRIOS_SESSION_SECRET), tamper-evident tokens carrying issuer / audience /
//     version / expiry. The client holds the token only in JS memory and sends
//     it via the Authorization: Bearer header; there is no cookie and nothing on
//     disk, so a page reload requires signing in again.
//   - If the env config is missing or malformed we surface a single generic
//     "unavailable" signal; we never reveal which piece of config is absent.

import {
  scrypt as _scrypt,
  timingSafeEqual,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

// scrypt cost parameters. Kept in one place so the hashing helper
// (scripts/hash-user.mjs) and this verifier stay in lock-step.
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export const ISSUER = 'agrios';
export const AUDIENCE = 'agrios-web';
export const TOKEN_VERSION = 1;

// Session lifetime: default 8h, hard-capped at 12h.
export const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_TTL_MS = 12 * 60 * 60 * 1000;

// Role hierarchy. `owner` may run high-impact actions (e.g. manual live-feed
// refresh); `operator` has standard mission/intelligence access.
export const ACCOUNT_ROLES = ['operator', 'owner'];
const ROLE_RANK = { operator: 1, owner: 2 };

export function accountRoleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 99);
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecodeToString(s) {
  return Buffer.from(String(s), 'base64url').toString('utf8');
}

function normEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// Parse and validate AGRIOS_AUTH_USERS_JSON. Returns an array of user records
// or null when config is absent/invalid. Never throws to the caller and never
// echoes the offending value. Each record: { email, name, role, salt, hash }.
export function loadUsers(env = process.env) {
  const raw = env && env.AGRIOS_AUTH_USERS_JSON;
  if (!raw || typeof raw !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.users) ? parsed.users : null);
  if (!list || !list.length) return null;

  const out = [];
  const seen = new Set();
  for (const rec of list) {
    if (!rec || typeof rec !== 'object') return null;
    const email = normEmail(rec.email);
    const name = String(rec.name == null ? '' : rec.name).trim();
    const role = String(rec.role == null ? '' : rec.role).trim().toLowerCase();
    const salt = String(rec.salt == null ? '' : rec.salt).trim();
    const hash = String(rec.hash == null ? '' : rec.hash).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    if (!name || name.length > 80) return null;
    if (ACCOUNT_ROLES.indexOf(role) === -1) return null;
    if (!/^[0-9a-f]{16,}$/i.test(salt)) return null;
    if (!/^[0-9a-f]{128}$/i.test(hash)) return null; // 64-byte scrypt output
    if (seen.has(email)) return null;
    seen.add(email);
    out.push({ email, name, role, salt, hash });
  }
  return out;
}

// Public-safe roster of configured accounts: email, name, and role only.
// NEVER exposes salt/hash. Used to surface the known operator roster (e.g. Ben,
// Joel) in the team member list for account-layer contexts without a DB row.
// Returns [] when config is absent/invalid.
export function publicRoster(env = process.env) {
  const users = loadUsers(env);
  if (!users) return [];
  return users.map((u) => ({ email: u.email, name: u.name, role: u.role }));
}

// Constant-time scrypt verification of a candidate password against a stored
// {salt, hash}. Returns a boolean and never leaks timing about which field
// failed.
export async function verifyPassword(password, hashHex, salt) {
  let stored;
  try {
    stored = Buffer.from(String(hashHex), 'hex');
  } catch (_) {
    return false;
  }
  if (stored.length !== SCRYPT_PARAMS.keylen) return false;
  const derived = await scrypt(String(password == null ? '' : password), String(salt), SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  if (derived.length !== stored.length) return false;
  return timingSafeEqual(derived, stored);
}

// A fixed decoy salt so that authenticating a non-existent email still spends
// roughly the same time hashing (defeats a user-enumeration timing oracle).
const DECOY_SALT = 'agrios-decoy-salt-constant';

// Authenticate an email + password against the env user set.
// Returns { user } on success or { error: 'invalid' | 'unavailable' }.
// The same generic 'invalid' is returned for unknown email and wrong password.
export async function authenticate(email, password, env = process.env) {
  const users = loadUsers(env);
  if (!users) return { error: 'unavailable' };
  const norm = normEmail(email);
  const user = users.find((u) => u.email === norm) || null;
  if (!user) {
    // Spend comparable time so presence/absence of the account is not timeable.
    await scrypt(String(password == null ? '' : password), DECOY_SALT, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
    });
    return { error: 'invalid' };
  }
  const ok = await verifyPassword(password, user.hash, user.salt);
  if (!ok) return { error: 'invalid' };
  return { user: { email: user.email, name: user.name, role: user.role } };
}

function getSecret(env) {
  const s = env && env.AGRIOS_SESSION_SECRET;
  return (typeof s === 'string' && s.length >= 16) ? s : null;
}

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest();
}

// Mint a signed session token for an authenticated user. Returns
// { token, expiresAt } or { error: 'unavailable' } when no signing secret.
export function signSession(user, { env = process.env, now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const secret = getSecret(env);
  if (!secret) return { error: 'unavailable' };
  const life = Math.max(1, Math.min(ttlMs, MAX_TTL_MS));
  const iat = Math.floor(now / 1000);
  const exp = Math.floor((now + life) / 1000);
  const payload = {
    sub: normEmail(user.email),
    name: user.name,
    role: user.role,
    iss: ISSUER,
    aud: AUDIENCE,
    v: TOKEN_VERSION,
    iat,
    exp,
    jti: b64urlEncode(randomBytes(9)),
  };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sigB64 = b64urlEncode(sign(payloadB64, secret));
  return { token: payloadB64 + '.' + sigB64, expiresAt: new Date(exp * 1000).toISOString(), payload };
}

// Verify a session token's signature and claims. Returns
// { valid:true, payload } or { valid:false, reason }. `reason` is for internal
// use/telemetry only — callers must return a generic message to clients.
export function verifySession(token, { env = process.env, now = Date.now() } = {}) {
  const secret = getSecret(env);
  if (!secret) return { valid: false, reason: 'unavailable' };
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    return { valid: false, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { valid: false, reason: 'malformed' };
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let expected, got;
  try {
    expected = sign(payloadB64, secret);
    got = Buffer.from(sigB64, 'base64url');
  } catch (_) {
    return { valid: false, reason: 'malformed' };
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { valid: false, reason: 'bad_signature' };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch (_) {
    return { valid: false, reason: 'malformed' };
  }
  if (!payload || typeof payload !== 'object') return { valid: false, reason: 'malformed' };
  if (payload.iss !== ISSUER) return { valid: false, reason: 'bad_issuer' };
  if (payload.aud !== AUDIENCE) return { valid: false, reason: 'bad_audience' };
  if (payload.v !== TOKEN_VERSION) return { valid: false, reason: 'bad_version' };
  if (ACCOUNT_ROLES.indexOf(payload.role) === -1) return { valid: false, reason: 'bad_role' };
  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== 'number' || nowSec >= payload.exp) return { valid: false, reason: 'expired' };
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 60) return { valid: false, reason: 'bad_iat' };
  return { valid: true, payload };
}

// Extract a bearer token from the Authorization header.
export function bearerToken(req) {
  const h = (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : '';
}

// Resolve an authenticated account from a request's bearer token, or null.
// Optionally enforce a minimum role. Never throws.
export function resolveAccount(req, { env = process.env, now = Date.now(), minRole = null } = {}) {
  const token = bearerToken(req);
  if (!token) return null;
  if (isRevoked(token)) return null;
  const res = verifySession(token, { env, now });
  if (!res.valid) return null;
  const p = res.payload;
  if (minRole && !accountRoleAtLeast(p.role, minRole)) return null;
  return { email: p.sub, name: p.name, role: p.role, expiresAt: new Date(p.exp * 1000).toISOString() };
}

// Best-effort per-warm-container revocation set so an explicit logout can
// invalidate a still-valid token server-side too (client memory clear is the
// primary mechanism; tokens are short-lived regardless).
const REVOKED = globalThis.__AGRIOS_REVOKED__ || (globalThis.__AGRIOS_REVOKED__ = new Map());
const REVOKED_MAX = 512;

export function revokeToken(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token) return;
  if (REVOKED.size >= REVOKED_MAX) {
    const oldest = REVOKED.keys().next().value;
    if (oldest !== undefined) REVOKED.delete(oldest);
  }
  REVOKED.set(token, now);
}

export function isRevoked(token) {
  return REVOKED.has(token);
}

export function clearRevocations() { REVOKED.clear(); }
