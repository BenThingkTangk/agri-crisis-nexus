// Request/response helpers shared by every API function: JSON body parsing,
// cookie handling, security headers, origin/CSRF checks, a best-effort
// in-memory rate limiter, and small validation utilities.

const SESSION_COOKIE = 'agri_session';

// ---- responses ------------------------------------------------------------
export function sendJSON(res, status, body) {
  applySecurityHeaders(res);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

// Generic, non-leaky error. `detail` is only for known-safe client messages;
// never pass raw DB/stack text here.
export function sendError(res, status, code, detail) {
  const body = { ok: false, error: code };
  if (detail) body.message = detail;
  sendJSON(res, status, body);
}

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

// ---- body parsing ---------------------------------------------------------
export async function readJSON(req) {
  // Vercel may pre-parse req.body; handle both.
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.length) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    return {};
  }
}

// ---- cookies --------------------------------------------------------------
export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

export function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || '';
}

export function setSessionCookie(res, token, maxAgeSec) {
  const prod = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (prod) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

export function clearSessionCookie(res) {
  const prod = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (prod) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie]);
  else res.setHeader('Set-Cookie', [prev, cookie]);
}

// ---- origin / CSRF --------------------------------------------------------
// For state-changing requests, require the Origin (or Referer) host to match
// the request host. Combined with SameSite=Lax cookies this blocks CSRF.
export function isSameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return false;
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false; // require an origin for writes
  try {
    return new URL(src).host === host;
  } catch (_) {
    return false;
  }
}

// ---- rate limiting (best-effort, per warm container) ----------------------
// Not a substitute for a real distributed limiter, but throttles brute-force
// within a single serverless instance. Keyed by ip+bucket.
const BUCKETS = globalThis.__AGRI_RL__ || (globalThis.__AGRI_RL__ = new Map());

export function rateLimit(req, bucket, { limit = 10, windowMs = 60_000 } = {}) {
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const rec = BUCKETS.get(key);
  if (!rec || now > rec.reset) {
    BUCKETS.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  rec.count += 1;
  if (rec.count > limit) return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
  return { ok: true, remaining: limit - rec.count };
}

export { SESSION_COOKIE };
