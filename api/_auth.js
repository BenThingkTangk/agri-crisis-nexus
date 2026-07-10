// Session resolution, RBAC, and audit logging.
//
// requireAuth() resolves the session cookie -> live session row -> user, and
// determines the active team + the caller's role in it. Every write endpoint
// runs the result through requireRole() before mutating.

import { query } from './_db.js';
import { hashToken, generateToken } from './_crypto.js';
import { getSessionToken, sendError, isSameOrigin } from './_http.js';

const SESSION_TTL_DAYS = 30;

// Role hierarchy for RBAC comparisons.
const ROLE_RANK = { viewer: 1, analyst: 2, admin: 3, owner: 4 };

export function roleAtLeast(role, min) {
  return (ROLE_RANK[role] || 0) >= (ROLE_RANK[min] || 99);
}

export function sessionExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_TTL_DAYS);
  return d.toISOString();
}

export const SESSION_MAX_AGE_SEC = SESSION_TTL_DAYS * 24 * 60 * 60;

// Create a session row and return the raw token to set as a cookie.
export async function createSession(userId, activeTeamId, userAgent) {
  const raw = generateToken(32);
  const csrf = generateToken(18);
  await query(
    `INSERT INTO sessions (user_id, token_hash, active_team_id, csrf_secret, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, hashToken(raw), activeTeamId, csrf, (userAgent || '').slice(0, 300), sessionExpiry()]
  );
  return raw;
}

export async function revokeSession(rawToken) {
  if (!rawToken) return;
  await query(`UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    hashToken(rawToken),
  ]);
}

// Resolve the current authenticated context, or null if unauthenticated.
export async function resolveAuth(req) {
  const raw = getSessionToken(req);
  if (!raw) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.active_team_id, s.expires_at, s.csrf_secret,
            u.id AS user_id, u.email, u.display_name, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(raw)]
  );
  const s = rows[0];
  if (!s || !s.is_active) return null;

  // Load memberships (a user may belong to multiple teams).
  const { rows: memberships } = await query(
    `SELECT tm.team_id, tm.role, t.name, t.slug
       FROM team_members tm JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = $1 ORDER BY t.name ASC`,
    [s.user_id]
  );

  // Pick the active team: the session's active_team_id if still a member, else
  // the first membership.
  let activeTeam = memberships.find((m) => m.team_id === s.active_team_id) || memberships[0] || null;

  // Keep the session's active team pointer in sync (touch last_seen too).
  if (activeTeam && activeTeam.team_id !== s.active_team_id) {
    await query(`UPDATE sessions SET active_team_id = $1, last_seen_at = now() WHERE id = $2`, [
      activeTeam.team_id,
      s.session_id,
    ]);
  } else {
    await query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [s.session_id]);
  }

  return {
    sessionId: s.session_id,
    csrfSecret: s.csrf_secret,
    user: { id: s.user_id, email: s.email, displayName: s.display_name },
    teamId: activeTeam ? activeTeam.team_id : null,
    role: activeTeam ? activeTeam.role : null,
    memberships: memberships.map((m) => ({ teamId: m.team_id, role: m.role, name: m.name, slug: m.slug })),
    rawToken: raw,
  };
}

// Guard for endpoints that need an authenticated user. Returns the auth context
// or sends a 401 and returns null.
export async function requireAuth(req, res) {
  const ctx = await resolveAuth(req);
  if (!ctx) {
    sendError(res, 401, 'unauthenticated', 'Sign in to continue.');
    return null;
  }
  return ctx;
}

// Guard for state-changing requests: same-origin + minimum role. Returns true
// if allowed; otherwise sends the appropriate error and returns false.
export function requireWrite(req, res, ctx, minRole) {
  if (!isSameOrigin(req)) {
    sendError(res, 403, 'bad_origin', 'Request blocked for security.');
    return false;
  }
  if (!ctx.teamId) {
    sendError(res, 403, 'no_team', 'No active team.');
    return false;
  }
  if (minRole && !roleAtLeast(ctx.role, minRole)) {
    sendError(res, 403, 'forbidden', 'You do not have permission for this action.');
    return false;
  }
  return true;
}

// Append-only audit entry. Never throws into the request path.
export async function audit(ctx, action, entityType, entityId, detail = {}) {
  try {
    await query(
      `INSERT INTO audit_log (team_id, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.teamId || null, ctx.user.id, action, entityType || null, entityId || null, detail]
    );
  } catch (_) {
    /* audit is best-effort */
  }
}
