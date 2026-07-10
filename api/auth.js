// Authentication + account API. One function, action-dispatched, to keep the
// serverless surface small.
//
//   POST /api/auth?action=register   { email, password, displayName, inviteToken?, teamName? }
//   POST /api/auth?action=login      { email, password }
//   POST /api/auth?action=logout
//   GET  /api/auth?action=session
//   POST /api/auth?action=switch-team { teamId }
//
// Bootstrap: the very first registered user becomes owner of a new team.
// Afterwards, registration requires a valid single-use invite token.

import { withTransaction, query } from './_db.js';
import { hashPassword, verifyPassword, hashToken } from './_crypto.js';
import {
  readJSON, sendJSON, sendError, rateLimit,
  setSessionCookie, clearSessionCookie, isSameOrigin,
} from './_http.js';
import {
  createSession, revokeSession, resolveAuth, requireAuth,
  SESSION_MAX_AGE_SEC, audit,
} from './_auth.js';
import { email as vEmail, password as vPassword, str, uuid, ValidationError } from './_validate.js';

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (base || 'team') + '-' + Math.random().toString(36).slice(2, 7);
}

function publicSession(ctx) {
  return {
    user: ctx.user,
    activeTeamId: ctx.teamId,
    role: ctx.role,
    memberships: ctx.memberships,
    csrfToken: ctx.csrfSecret,
  };
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  try {
    if (action === 'session') return await getSession(req, res);
    if (action === 'register') return await register(req, res);
    if (action === 'login') return await login(req, res);
    if (action === 'logout') return await logout(req, res);
    if (action === 'switch-team') return await switchTeam(req, res);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function getSession(req, res) {
  const ctx = await resolveAuth(req);
  if (!ctx) return sendJSON(res, 200, { ok: true, authenticated: false });
  return sendJSON(res, 200, { ok: true, authenticated: true, session: publicSession(ctx) });
}

async function register(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!isSameOrigin(req)) return sendError(res, 403, 'bad_origin', 'Request blocked for security.');
  const rl = rateLimit(req, 'register', { limit: 6, windowMs: 60_000 });
  if (!rl.ok) return sendError(res, 429, 'rate_limited', 'Too many attempts. Try again shortly.');

  const body = await readJSON(req);
  const email = vEmail(body.email);
  const password = vPassword(body.password);
  const displayName = str(body.displayName, 'displayName', { min: 2, max: 80 });
  const inviteToken = body.inviteToken ? str(body.inviteToken, 'inviteToken', { max: 200 }) : null;

  const { hash, salt } = await hashPassword(password);

  let result;
  try {
    result = await withTransaction(async (client) => {
      const existing = await client.query('SELECT COUNT(*)::int AS n FROM users');
      const isFirstUser = existing.rows[0].n === 0;

      // Enforce invite-only after bootstrap.
      let inviteRow = null;
      if (!isFirstUser) {
        if (!inviteToken) throw new ValidationError('An invite is required to register.');
        const inv = await client.query(
          `SELECT * FROM invitations
             WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
          [hashToken(inviteToken)]
        );
        inviteRow = inv.rows[0];
        if (!inviteRow) throw new ValidationError('This invite is invalid or has expired.');
        if (inviteRow.email_norm && inviteRow.email_norm !== email) {
          throw new ValidationError('This invite was issued for a different email.');
        }
      }

      // Unique email.
      const dup = await client.query('SELECT 1 FROM users WHERE email_norm = $1', [email]);
      if (dup.rows.length) throw new ValidationError('An account with that email already exists.');

      const userRes = await client.query(
        `INSERT INTO users (email, email_norm, display_name, password_hash, password_salt)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.email.trim(), email, displayName, hash, salt]
      );
      const userId = userRes.rows[0].id;

      let teamId;
      let role;
      if (isFirstUser) {
        const teamName = body.teamName && String(body.teamName).trim() ? String(body.teamName).trim().slice(0, 80) : 'Command Team';
        const teamRes = await client.query(
          `INSERT INTO teams (name, slug, created_by) VALUES ($1, $2, $3) RETURNING id`,
          [teamName, slugify(teamName), userId]
        );
        teamId = teamRes.rows[0].id;
        role = 'owner';
      } else {
        teamId = inviteRow.team_id;
        role = inviteRow.role;
        await client.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $1 WHERE id = $2`, [
          userId, inviteRow.id,
        ]);
      }

      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`,
        [teamId, userId, role]
      );
      return { userId, teamId };
    });
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    throw err;
  }

  const raw = await createSession(result.userId, result.teamId, req.headers['user-agent']);
  setSessionCookie(res, raw, SESSION_MAX_AGE_SEC);
  const ctx = await resolveAuth(req.__withCookie ? req : { ...req, headers: { ...req.headers, cookie: `agri_session=${raw}` } });
  return sendJSON(res, 201, { ok: true, authenticated: true, session: publicSession(ctx) });
}

async function login(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!isSameOrigin(req)) return sendError(res, 403, 'bad_origin', 'Request blocked for security.');
  const rl = rateLimit(req, 'login', { limit: 8, windowMs: 60_000 });
  if (!rl.ok) return sendError(res, 429, 'rate_limited', 'Too many attempts. Try again shortly.');

  const body = await readJSON(req);
  // Generic failure message regardless of which part is wrong.
  const generic = () => sendError(res, 401, 'invalid_credentials', 'Incorrect email or password.');
  let email;
  try {
    email = vEmail(body.email);
    vPassword(body.password);
  } catch (_) {
    return generic();
  }

  const { rows } = await query(
    `SELECT id, password_hash, password_salt, is_active FROM users WHERE email_norm = $1`,
    [email]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    // Still spend time hashing to reduce timing oracle.
    await verifyPassword(body.password, 'x'.repeat(128), 'salt');
    return generic();
  }
  const ok = await verifyPassword(body.password, user.password_hash, user.password_salt);
  if (!ok) return generic();

  const membership = await query('SELECT team_id FROM team_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1', [user.id]);
  const teamId = membership.rows[0] ? membership.rows[0].team_id : null;

  const raw = await createSession(user.id, teamId, req.headers['user-agent']);
  setSessionCookie(res, raw, SESSION_MAX_AGE_SEC);
  const ctx = await resolveAuth({ ...req, headers: { ...req.headers, cookie: `agri_session=${raw}` } });
  await audit(ctx, 'auth.login', 'user', user.id);
  return sendJSON(res, 200, { ok: true, authenticated: true, session: publicSession(ctx) });
}

async function logout(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  const ctx = await resolveAuth(req);
  if (ctx) {
    await revokeSession(ctx.rawToken);
    await audit(ctx, 'auth.logout', 'user', ctx.user.id);
  }
  clearSessionCookie(res);
  return sendJSON(res, 200, { ok: true, authenticated: false });
}

async function switchTeam(req, res) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  if (!isSameOrigin(req)) return sendError(res, 403, 'bad_origin', 'Request blocked for security.');
  const body = await readJSON(req);
  const teamId = uuid(body.teamId, 'teamId');
  const member = ctx.memberships.find((m) => m.teamId === teamId);
  if (!member) return sendError(res, 403, 'forbidden', 'You are not a member of that team.');
  await query('UPDATE sessions SET active_team_id = $1 WHERE id = $2', [teamId, ctx.sessionId]);
  const next = await resolveAuth(req);
  return sendJSON(res, 200, { ok: true, session: publicSession(next) });
}
