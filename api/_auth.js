// Session resolution, RBAC, and audit logging.
//
// requireAuth() resolves the session cookie -> live session row -> user, and
// determines the active team + the caller's role in it. Every write endpoint
// runs the result through requireRole() before mutating.

import { query, withTransaction } from './_db.js';
import { hashToken, generateToken } from './_crypto.js';
import { getSessionToken, sendError, isSameOrigin } from './_http.js';
import { resolveAccount, publicRoster } from './_accounts.js';

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
// account identity onto the SHARED canonical workspace team — every configured
// AGRIOS_AUTH operator (owner + operators) belongs to that one team so they
// share alerts, missions, messages, presence, scenarios, and assignments. It is
// NOT a per-account team (that split the operators into isolated silos).

// Account roles (operator/owner) -> DB team roles. Owner keeps high-impact
// reach; operator maps to analyst so it clears the analyst write boundary.
const ACCOUNT_TO_TEAM_ROLE = { owner: 'owner', operator: 'analyst' };

// Map an account-layer role onto its DB team role (defaults to analyst).
// Exported so display surfaces (e.g. the team roster) can label roster-only
// account entries consistently with how ensureAccountContext provisions them.
export function accountTeamRole(role) {
  return ACCOUNT_TO_TEAM_ROLE[role] || 'analyst';
}

// Placeholder credential columns for account-provisioned user rows. These rows
// exist ONLY for foreign-key/team scoping; the account layer never verifies a
// password against them (the signed bearer token is authoritative), so this
// marker can never authenticate through the DB login path.
const ACCOUNT_PROVISIONED = 'account-provisioned-no-db-login';

function normEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

// The shared workspace slug is derived from the configured OWNER's email, so the
// owner's already-existing team (which holds the production data) is reused as
// canonical rather than orphaned. Name is only set on first creation.
function accountTeamSlug(emailNorm) {
  const base = String(emailNorm).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return 'acct-' + (base || 'operator');
}
const CANONICAL_TEAM_NAME = 'AgriOS Command';

// Deterministic 32-bit key for pg advisory locks (djb2). Serializes concurrent
// provisioning so two simultaneous sign-ins can't race the canonical team into
// existence twice.
function advisoryKey(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// The full set of configured operator accounts (owner + operators), plus the
// currently signing-in account if it somehow isn't in the roster snapshot.
function rosterAccounts(current) {
  const list = [];
  const seen = new Set();
  for (const a of publicRoster()) {
    const en = normEmail(a.email);
    if (!en || seen.has(en)) continue;
    seen.add(en);
    list.push({ email: a.email, emailNorm: en, name: a.name || a.email, role: a.role });
  }
  if (current) {
    const en = normEmail(current.email);
    if (en && !seen.has(en)) list.push({ email: current.email, emailNorm: en, name: current.name || current.email, role: current.role });
  }
  return list;
}

function pickOwner(list) {
  return list.find((a) => a.role === 'owner') || list[0] || null;
}

// Non-destructively migrate one per-account team's Phase III rows into the
// canonical team. Only re-points team_id — never deletes history. UNIQUE and
// composite-PK collisions (alerts event_key, room_presence) are guarded so a
// migration can never violate a constraint; any genuinely conflicting rows are
// left in place rather than dropped.
async function migrateTeamData(client, oldId, teamId) {
  await client.query('UPDATE alert_rules       SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE missions          SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE scenarios         SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE mission_tasks     SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE mission_decisions SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE mission_events    SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE room_messages     SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE audit_log         SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  await client.query('UPDATE invitations       SET team_id = $2 WHERE team_id = $1', [oldId, teamId]);
  // Alerts carry UNIQUE (team_id, event_key): only move rows whose key is not
  // already present in the canonical team.
  await client.query(
    `UPDATE alerts a SET team_id = $2
      WHERE a.team_id = $1
        AND NOT EXISTS (SELECT 1 FROM alerts b WHERE b.team_id = $2 AND b.event_key = a.event_key)`,
    [oldId, teamId]
  );
  // Presence is keyed by (team_id, user_id) and is ephemeral heartbeat state;
  // move only non-colliding rows.
  await client.query(
    `UPDATE room_presence p SET team_id = $2
      WHERE p.team_id = $1
        AND NOT EXISTS (SELECT 1 FROM room_presence q WHERE q.team_id = $2 AND q.user_id = p.user_id)`,
    [oldId, teamId]
  );
}

// Idempotently ensure the ONE canonical workspace team exists, that every
// configured account has a real user row + membership in it, and that any legacy
// per-account team's data has been migrated in. Concurrency-safe via a
// transaction-scoped advisory lock. Cached per warm container (the reconcile is
// one-time; re-running is a harmless no-op on a cold container).
async function ensureCanonicalWorkspace(current) {
  const accounts = rosterAccounts(current);
  if (!accounts.length) return { teamId: null, slug: null };
  const owner = pickOwner(accounts);
  const slug = accountTeamSlug(owner.emailNorm);

  const cached = globalThis.__AGRI_CANONICAL_TEAM__;
  if (cached && cached.slug === slug && cached.teamId) return cached;

  const result = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey(slug)]);

    // 1. A DB user row for every configured account.
    const byEmail = new Map();
    for (const a of accounts) {
      const u = await client.query(
        `INSERT INTO users (email, email_norm, display_name, password_hash, password_salt, is_active)
         VALUES ($1,$2,$3,$4,$5,TRUE)
         ON CONFLICT (email_norm) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id, email, display_name`,
        [a.email, a.emailNorm, a.name, ACCOUNT_PROVISIONED, ACCOUNT_PROVISIONED]
      );
      byEmail.set(a.emailNorm, u.rows[0].id);
    }

    // 2. The canonical team (owner's existing team, matched by slug). Preserve
    //    an existing name; only name a freshly-created team.
    const t = await client.query(
      `INSERT INTO teams (name, slug, created_by) VALUES ($1,$2,$3)
       ON CONFLICT (slug) DO UPDATE SET name = teams.name
       RETURNING id`,
      [CANONICAL_TEAM_NAME, slug, byEmail.get(owner.emailNorm)]
    );
    const teamId = t.rows[0].id;

    // 3. A membership for every configured account, with its mapped role.
    for (const a of accounts) {
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [teamId, byEmail.get(a.emailNorm), accountTeamRole(a.role)]
      );
    }

    // 4. Migrate any legacy per-account team data into canonical (non-owner
    //    accounts that previously got their own team). Owner's slug == canonical
    //    slug, so the owner's data already lives in the canonical team.
    for (const a of accounts) {
      const oldSlug = accountTeamSlug(a.emailNorm);
      if (oldSlug === slug) continue;
      const old = await client.query('SELECT id FROM teams WHERE slug = $1', [oldSlug]);
      if (!old.rows.length || old.rows[0].id === teamId) continue;
      await migrateTeamData(client, old.rows[0].id, teamId);
    }

    return { teamId, slug };
  });

  globalThis.__AGRI_CANONICAL_TEAM__ = result;
  return result;
}

// Map an account identity onto the shared canonical workspace team, returning an
// auth context shaped like resolveAuth's output.
async function ensureAccountContext(acct) {
  const emailNorm = normEmail(acct.email);
  const teamRole = accountTeamRole(acct.role);
  const { teamId } = await ensureCanonicalWorkspace(acct);
  if (!teamId) return null; // no configured roster -> cannot provision

  // Steady state: the account is already a canonical-team member.
  const found = await query(
    `SELECT u.id AS user_id, u.email, u.display_name, tm.role
       FROM users u JOIN team_members tm ON tm.user_id = u.id
      WHERE u.email_norm = $1 AND tm.team_id = $2 LIMIT 1`,
    [emailNorm, teamId]
  );
  if (found.rows.length) {
    const r = found.rows[0];
    if (r.role !== teamRole) {
      await query('UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3', [teamRole, teamId, r.user_id]);
    }
    return accountCtx(r.user_id, r.email, r.display_name, teamId, teamRole);
  }

  // Fallback: attach this account to canonical (e.g. its token is valid but the
  // cached roster snapshot predates it). Idempotent + advisory-locked.
  const attached = await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [advisoryKey('attach:' + emailNorm)]);
    const u = await client.query(
      `INSERT INTO users (email, email_norm, display_name, password_hash, password_salt, is_active)
       VALUES ($1,$2,$3,$4,$5,TRUE)
       ON CONFLICT (email_norm) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, email, display_name`,
      [acct.email, emailNorm, acct.name || acct.email, ACCOUNT_PROVISIONED, ACCOUNT_PROVISIONED]
    );
    await client.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, u.rows[0].id, teamRole]
    );
    return { userId: u.rows[0].id, email: u.rows[0].email, displayName: u.rows[0].display_name };
  });
  return accountCtx(attached.userId, attached.email, attached.displayName, teamId, teamRole);
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
