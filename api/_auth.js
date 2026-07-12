// Session resolution, RBAC, and audit logging.
//
// requireAuth() resolves the session cookie -> live session row -> user, and
// determines the active team + the caller's role in it. Every write endpoint
// runs the result through requireRole() before mutating.

import { query, withTransaction } from './_db.js';
import { hashToken, generateToken } from './_crypto.js';
import { getSessionToken, sendError, isSameOrigin } from './_http.js';
import { resolveAccount } from './_accounts.js';

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

// ---------------------------------------------------------------------------
// Shared authentication bridge for collaboration surfaces
// ---------------------------------------------------------------------------
// Two identity layers exist: the DB-backed team session (cookie -> sessions
// row, this file) and the env-backed account layer (bearer token, _accounts.js
// — the production operator sign-in). Collaboration endpoints must honor BOTH,
// so an operator signed in via the account layer still gets a real, team-scoped
// context. resolveAnyAuth() prefers a live DB session and otherwise maps the
// account identity onto a durable per-account workspace team.

// Account roles (operator/owner) -> DB team roles. Owner keeps high-impact
// reach; operator maps to analyst so it clears the analyst write boundary.
const ACCOUNT_TO_TEAM_ROLE = { owner: 'owner', operator: 'analyst' };

// Placeholder credential columns for account-provisioned user rows. These rows
// exist ONLY for foreign-key/team scoping; the account layer never verifies a
// password against them (the signed bearer token is authoritative), so this
// marker can never authenticate through the DB login path.
const ACCOUNT_PROVISIONED = 'account-provisioned-no-db-login';

function accountTeamSlug(emailNorm) {
  const base = String(emailNorm).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return 'acct-' + (base || 'operator');
}

// Idempotently ensure a DB user + personal team + membership exist for an
// account identity, returning an auth context shaped like resolveAuth's output.
async function ensureAccountContext(acct) {
  const emailNorm = String(acct.email || '').trim().toLowerCase();
  const teamRole = ACCOUNT_TO_TEAM_ROLE[acct.role] || 'analyst';

  // Fast path: the workspace already exists — one SELECT in steady state.
  const existing = await query(
    `SELECT u.id AS user_id, u.email, u.display_name, tm.team_id, tm.role
       FROM users u JOIN team_members tm ON tm.user_id = u.id
      WHERE u.email_norm = $1 ORDER BY tm.created_at ASC LIMIT 1`,
    [emailNorm]
  );
  if (existing.rows.length) {
    const r = existing.rows[0];
    if (r.role !== teamRole) {
      await query('UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3', [
        teamRole, r.team_id, r.user_id,
      ]);
    }
    return accountCtx(r.user_id, r.email, r.display_name, r.team_id, teamRole);
  }

  // Provision the workspace once, atomically.
  const provisioned = await withTransaction(async (client) => {
    const u = await client.query(
      `INSERT INTO users (email, email_norm, display_name, password_hash, password_salt, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (email_norm) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, email, display_name`,
      [acct.email, emailNorm, acct.name || acct.email, ACCOUNT_PROVISIONED, ACCOUNT_PROVISIONED]
    );
    const userId = u.rows[0].id;
    const slug = accountTeamSlug(emailNorm);
    const teamName = (acct.name ? acct.name + '’s Workspace' : 'Command Team');
    const t = await client.query(
      `INSERT INTO teams (name, slug, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = teams.name
       RETURNING id`,
      [teamName, slug, userId]
    );
    const teamId = t.rows[0].id;
    await client.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, userId, teamRole]
    );
    return { userId, email: u.rows[0].email, displayName: u.rows[0].display_name, teamId };
  });
  return accountCtx(provisioned.userId, provisioned.email, provisioned.displayName, provisioned.teamId, teamRole);
}

function accountCtx(userId, email, displayName, teamId, role) {
  return {
    sessionId: null,
    csrfSecret: null,
    user: { id: userId, email, displayName },
    teamId,
    role,
    memberships: [{ teamId, role, name: null, slug: null }],
    rawToken: null,
    account: true,
  };
}

// Resolve an auth context from EITHER layer. A valid DB session wins (full team
// features); otherwise a valid account bearer is mapped to its workspace team.
export async function resolveAnyAuth(req) {
  const dbCtx = await resolveAuth(req);
  if (dbCtx) return dbCtx;
  const acct = resolveAccount(req);
  if (!acct) return null;
  return ensureAccountContext(acct);
}

// Guard used by collaboration endpoints: accepts either identity layer, or
// sends an honest 401 sign-in error.
export async function requireAnyAuth(req, res) {
  const ctx = await resolveAnyAuth(req);
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
