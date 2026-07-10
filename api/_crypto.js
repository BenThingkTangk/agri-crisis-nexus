// Auth primitives: password hashing, opaque token generation, constant-time
// comparison. Pure Node crypto — no external deps, no plaintext storage.

import {
  randomBytes,
  scrypt as _scrypt,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const KEYLEN = 64;

// Hash a password with a fresh per-user salt. Returns { hash, salt } as hex.
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(String(password), salt, KEYLEN);
  return { hash: derived.toString('hex'), salt };
}

// Verify a candidate password against a stored hash+salt in constant time.
export async function verifyPassword(password, hashHex, salt) {
  if (!hashHex || !salt) return false;
  let stored;
  try {
    stored = Buffer.from(hashHex, 'hex');
  } catch (_) {
    return false;
  }
  if (stored.length !== KEYLEN) return false;
  const derived = await scrypt(String(password), salt, KEYLEN);
  return timingSafeEqual(stored, derived);
}

// A high-entropy opaque token (raw value handed to the client once).
export function generateToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// Deterministic hash used to store tokens (sessions, invites) at rest.
export function hashToken(raw) {
  return createHash('sha256').update(String(raw)).digest('hex');
}

// Constant-time string comparison for CSRF tokens etc.
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
