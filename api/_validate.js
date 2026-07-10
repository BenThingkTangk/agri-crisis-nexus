// Small, dependency-free validation helpers. Every API validates request
// bodies/params through these before touching the database.

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const PILLARS = [
  'Secure Infrastructure',
  'Coordination Layer',
  'Regenerative Biology',
  'Clinical Intelligence',
];

export const MISSION_STATUS = ['proposed', 'active', 'blocked', 'complete', 'archived'];
export const MISSION_PRIORITY = ['low', 'medium', 'high', 'critical'];
export const ROLES = ['owner', 'admin', 'analyst', 'viewer'];
export const SEVERITIES = ['moderate', 'high', 'critical'];

export function str(value, field, { min = 0, max = 2000, required = true, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  const v = trim ? value.trim() : value;
  if (required && v.length < Math.max(min, 1)) throw new ValidationError(`${field} is required`);
  if (v.length < min) throw new ValidationError(`${field} is too short`);
  if (v.length > max) throw new ValidationError(`${field} is too long`);
  return v;
}

export function email(value, field = 'email') {
  const v = str(value, field, { max: 320 }).toLowerCase();
  // Deliberately permissive; final authority is delivery, which we don't do.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new ValidationError('Enter a valid email');
  return v;
}

export function password(value, field = 'password') {
  if (typeof value !== 'string') throw new ValidationError(`${field} is required`);
  if (value.length < 10) throw new ValidationError('Password must be at least 10 characters');
  if (value.length > 200) throw new ValidationError('Password is too long');
  return value;
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new ValidationError(`${field} is invalid`);
  return value;
}

export function optionalOneOf(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null;
  return oneOf(value, allowed, field);
}

export function uuid(value, field) {
  const v = str(value, field, { max: 64 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new ValidationError(`${field} is invalid`);
  }
  return v;
}

export function optionalUuid(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return uuid(value, field);
}

export function strArray(value, field, { max = 40, itemMax = 120 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > max) throw new ValidationError(`${field} has too many entries`);
  return value.map((v) => {
    if (typeof v !== 'string') throw new ValidationError(`${field} entries must be text`);
    const t = v.trim();
    if (t.length > itemMax) throw new ValidationError(`${field} entry is too long`);
    return t;
  }).filter(Boolean);
}

export function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a valid date`);
  return d.toISOString();
}

export function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  const s = JSON.stringify(value);
  if (s.length > 20_000) throw new ValidationError(`${field} is too large`);
  return value;
}
