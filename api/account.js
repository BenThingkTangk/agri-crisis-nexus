// AgriOS account authentication API (env-backed, bearer-token sessions).
//
//   POST /api/account?action=login    { email, password } -> { token, user, expiresAt }
//   GET  /api/account?action=session  (Authorization: Bearer <token>)
//   POST /api/account?action=logout   (Authorization: Bearer <token>)
//
// The token is returned in the JSON body for the client to hold in memory and
// replay via the Authorization header. It is never set as a cookie and never
// placed in a URL. All responses are no-store. Errors are generic: we never
// reveal whether an email exists, nor whether server config is missing.

import {
  readJSON, sendJSON, sendError, rateLimit, isSameOrigin, applySecurityHeaders,
} from './_http.js';
import {
  authenticate, signSession, verifySession, bearerToken, revokeToken, isRevoked,
} from './_accounts.js';

// Bounded per-account attempt tracking (per warm container) layered on top of
// the per-IP limiter in _http.js, so a single account cannot be brute-forced
// from rotating IPs. Best-effort; resets on cold start.
const ACCT = globalThis.__AGRIOS_ACCT_RL__ || (globalThis.__AGRIOS_ACCT_RL__ = new Map());
const ACCT_MAX = 2048;

function accountThrottle(emailKey, { limit = 6, windowMs = 300_000, now = Date.now() } = {}) {
  if (!emailKey) return { ok: true };
  if (ACCT.size >= ACCT_MAX) {
    const oldest = ACCT.keys().next().value;
    if (oldest !== undefined) ACCT.delete(oldest);
  }
  const rec = ACCT.get(emailKey);
  if (!rec || now > rec.reset) {
    ACCT.set(emailKey, { count: 1, reset: now + windowMs });
    return { ok: true };
  }
  rec.count += 1;
  if (rec.count > limit) return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
  return { ok: true };
}

function accountThrottleReset(emailKey) { if (emailKey) ACCT.delete(emailKey); }

// Strict body-size cap for this route (login bodies are tiny). Rejects oversized
// payloads before parsing.
function tooLarge(req) {
  const len = Number(req.headers && req.headers['content-length']);
  return Number.isFinite(len) && len > 4096;
}

export default async function handler(req, res) {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store');
  const action = (req.query && req.query.action) || (new URL(req.url, 'http://localhost')).searchParams.get('action') || '';
  try {
    if (action === 'session') return await getSession(req, res);
    if (action === 'login') return await login(req, res);
    if (action === 'logout') return await logout(req, res);
    return sendError(res, 404, 'unknown_action');
  } catch (_) {
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function login(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!isSameOrigin(req)) return sendError(res, 403, 'bad_origin', 'Request blocked for security.');
  if (tooLarge(req)) return sendError(res, 413, 'too_large', 'Request too large.');

  const generic = () => sendError(res, 401, 'invalid_credentials', 'Incorrect email or password.');

  // Per-IP limiter first.
  const ipRl = rateLimit(req, 'account_login', { limit: 10, windowMs: 300_000 });
  if (!ipRl.ok) {
    if (ipRl.retryAfter) res.setHeader('Retry-After', String(ipRl.retryAfter));
    return sendError(res, 429, 'rate_limited', 'Too many attempts. Try again shortly.');
  }

  let body;
  try { body = await readJSON(req); } catch (_) { return sendError(res, 413, 'too_large', 'Request too large.'); }

  // Minimal, strict input validation. Normalize email (lowercase/trim).
  const emailRaw = body && typeof body.email === 'string' ? body.email : '';
  const password = body && typeof body.password === 'string' ? body.password : '';
  const email = emailRaw.trim().toLowerCase();
  if (!email || email.length > 320 || !password || password.length > 400) return generic();

  // Per-account limiter (keyed by normalized email).
  const acctRl = accountThrottle(email);
  if (!acctRl.ok) {
    if (acctRl.retryAfter) res.setHeader('Retry-After', String(acctRl.retryAfter));
    return sendError(res, 429, 'rate_limited', 'Too many attempts for this account. Try again later.');
  }

  const result = await authenticate(email, password);
  if (result.error === 'unavailable') {
    // Never disclose that config is missing/malformed.
    return sendError(res, 503, 'unavailable', 'Sign-in is temporarily unavailable.');
  }
  if (result.error || !result.user) return generic();

  const signed = signSession(result.user);
  if (signed.error || !signed.token) {
    return sendError(res, 503, 'unavailable', 'Sign-in is temporarily unavailable.');
  }

  accountThrottleReset(email);
  return sendJSON(res, 200, {
    ok: true,
    authenticated: true,
    token: signed.token,
    expiresAt: signed.expiresAt,
    user: result.user, // { email, name, role } — email only in the account context
  });
}

async function getSession(req, res) {
  if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed');
  const token = bearerToken(req);
  if (!token || isRevoked(token)) return sendJSON(res, 200, { ok: true, authenticated: false });
  const v = verifySession(token);
  if (!v.valid) return sendJSON(res, 200, { ok: true, authenticated: false });
  const p = v.payload;
  return sendJSON(res, 200, {
    ok: true,
    authenticated: true,
    user: { email: p.sub, name: p.name, role: p.role },
    expiresAt: new Date(p.exp * 1000).toISOString(),
  });
}

async function logout(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  const token = bearerToken(req);
  if (token) revokeToken(token);
  // The authoritative logout is the client discarding its in-memory token.
  return sendJSON(res, 200, { ok: true, authenticated: false });
}
