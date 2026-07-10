// Team + membership + invitation management. Action-dispatched.
//
//   GET  /api/teams?action=members                 -> members of active team
//   POST /api/teams?action=invite   { role, email? }-> create single-use invite (admin+)
//   GET  /api/teams?action=invites                 -> pending invites (admin+)
//   POST /api/teams?action=revoke-invite { id }     -> cancel a pending invite (admin+)
//   POST /api/teams?action=set-role  { userId, role }-> change a member's role (owner/admin)
//   POST /api/teams?action=remove-member { userId }  -> remove a member (owner/admin)
//   POST /api/teams?action=rename    { name }        -> rename active team (owner/admin)

import { query, withTransaction } from './_db.js';
import { generateToken, hashToken } from './_crypto.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAuth, requireWrite, roleAtLeast, audit } from './_auth.js';
import { str, uuid, email as vEmail, oneOf, ROLES, ValidationError } from './_validate.js';

const INVITE_TTL_DAYS = 14;

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || '';
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'members') return await listMembers(req, res, ctx);
    if (action === 'invites') return await listInvites(req, res, ctx);
    if (action === 'invite') return await createInvite(req, res, ctx);
    if (action === 'revoke-invite') return await revokeInvite(req, res, ctx);
    if (action === 'set-role') return await setRole(req, res, ctx);
    if (action === 'remove-member') return await removeMember(req, res, ctx);
    if (action === 'rename') return await rename(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function listMembers(req, res, ctx) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.display_name, u.email, tm.role, tm.created_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 ORDER BY tm.role, u.display_name`,
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, members: rows, me: ctx.user.id, myRole: ctx.role });
}

async function listInvites(req, res, ctx) {
  if (!roleAtLeast(ctx.role, 'admin')) return sendError(res, 403, 'forbidden');
  const { rows } = await query(
    `SELECT id, email_norm, role, created_at, expires_at
       FROM invitations
      WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, invites: rows });
}

async function createInvite(req, res, ctx) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!requireWrite(req, res, ctx, 'admin')) return;
  const body = await readJSON(req);
  const role = oneOf(body.role || 'viewer', ROLES.filter((r) => r !== 'owner'), 'role');
  const email = body.email ? vEmail(body.email) : null;

  const raw = generateToken(24);
  const expires = new Date();
  expires.setDate(expires.getDate() + INVITE_TTL_DAYS);

  const { rows } = await query(
    `INSERT INTO invitations (team_id, email_norm, role, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, expires_at`,
    [ctx.teamId, email, role, hashToken(raw), ctx.user.id, expires.toISOString()]
  );
  await audit(ctx, 'invite.create', 'invitation', rows[0].id, { role, email });
  // Raw token returned once so the admin can copy the invite link.
  return sendJSON(res, 201, { ok: true, invite: { id: rows[0].id, token: raw, role, email, expiresAt: rows[0].expires_at } });
}

async function revokeInvite(req, res, ctx) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!requireWrite(req, res, ctx, 'admin')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const { rowCount } = await query(
    `DELETE FROM invitations WHERE id = $1 AND team_id = $2 AND accepted_at IS NULL`,
    [id, ctx.teamId]
  );
  if (!rowCount) return sendError(res, 404, 'not_found', 'Invite not found.');
  await audit(ctx, 'invite.revoke', 'invitation', id);
  return sendJSON(res, 200, { ok: true });
}

async function setRole(req, res, ctx) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!requireWrite(req, res, ctx, 'admin')) return;
  const body = await readJSON(req);
  const userId = uuid(body.userId, 'userId');
  const role = oneOf(body.role, ROLES, 'role');
  if (userId === ctx.user.id) return sendError(res, 400, 'invalid', 'You cannot change your own role.');
  // Only an owner may grant or revoke the owner role.
  if (role === 'owner' && ctx.role !== 'owner') return sendError(res, 403, 'forbidden', 'Only an owner can assign the owner role.');

  await withTransaction(async (client) => {
    const target = await client.query('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [ctx.teamId, userId]);
    if (!target.rows.length) throw new ValidationError('That person is not a member of this team.');
    if (target.rows[0].role === 'owner' && ctx.role !== 'owner') throw new ValidationError('Only an owner can modify another owner.');
    // Prevent demoting the last owner.
    if (target.rows[0].role === 'owner' && role !== 'owner') {
      const owners = await client.query(`SELECT COUNT(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'owner'`, [ctx.teamId]);
      if (owners.rows[0].n <= 1) throw new ValidationError('A team must keep at least one owner.');
    }
    await client.query('UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3', [role, ctx.teamId, userId]);
  });
  await audit(ctx, 'member.set_role', 'user', userId, { role });
  return sendJSON(res, 200, { ok: true });
}

async function removeMember(req, res, ctx) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!requireWrite(req, res, ctx, 'admin')) return;
  const body = await readJSON(req);
  const userId = uuid(body.userId, 'userId');
  if (userId === ctx.user.id) return sendError(res, 400, 'invalid', 'Use account controls to leave a team.');
  await withTransaction(async (client) => {
    const target = await client.query('SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2', [ctx.teamId, userId]);
    if (!target.rows.length) throw new ValidationError('That person is not a member of this team.');
    if (target.rows[0].role === 'owner' && ctx.role !== 'owner') throw new ValidationError('Only an owner can remove an owner.');
    if (target.rows[0].role === 'owner') {
      const owners = await client.query(`SELECT COUNT(*)::int AS n FROM team_members WHERE team_id = $1 AND role = 'owner'`, [ctx.teamId]);
      if (owners.rows[0].n <= 1) throw new ValidationError('A team must keep at least one owner.');
    }
    await client.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [ctx.teamId, userId]);
  });
  await audit(ctx, 'member.remove', 'user', userId);
  return sendJSON(res, 200, { ok: true });
}

async function rename(req, res, ctx) {
  if (req.method !== 'POST') return sendError(res, 405, 'method_not_allowed');
  if (!requireWrite(req, res, ctx, 'admin')) return;
  const body = await readJSON(req);
  const name = str(body.name, 'name', { min: 2, max: 80 });
  await query('UPDATE teams SET name = $1 WHERE id = $2', [name, ctx.teamId]);
  await audit(ctx, 'team.rename', 'team', ctx.teamId, { name });
  return sendJSON(res, 200, { ok: true, name });
}
