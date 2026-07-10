// Missions API — tenant-scoped operational work items.
//
//   GET  /api/missions[?status=&priority=&pillar=&assignee=]  -> list (any member)
//   POST /api/missions                { ...fields }           -> create (analyst+)
//   PATCH/POST /api/missions?id=UUID  { ...partial }          -> update/assign/status (analyst+)
//   DELETE /api/missions?id=UUID                              -> archive (analyst+) / delete (admin+ with ?hard=1)
//
// All rows are scoped to the caller's active team; cross-tenant ids simply
// return not-found.

import { query } from './_db.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAuth, requireWrite, roleAtLeast, audit } from './_auth.js';
import {
  str, uuid, optionalUuid, oneOf, optionalOneOf, optionalDate, jsonObject,
  MISSION_STATUS, MISSION_PRIORITY, PILLARS, ValidationError,
} from './_validate.js';

const SELECT = `
  SELECT m.id, m.title, m.objective, m.status, m.priority, m.pillar, m.geography,
         m.assignee_id, m.source_ref, m.metadata, m.due_at, m.created_by,
         m.created_at, m.updated_at,
         a.display_name AS assignee_name,
         c.display_name AS created_by_name
    FROM missions m
    LEFT JOIN users a ON a.id = m.assignee_id
    LEFT JOIN users c ON c.id = m.created_by`;

export default async function handler(req, res) {
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (req.method === 'GET') return await list(req, res, ctx);
    if (req.method === 'POST' && !(req.query && req.query.id)) return await create(req, res, ctx);
    if (req.method === 'PATCH' || (req.method === 'POST' && req.query && req.query.id)) return await update(req, res, ctx);
    if (req.method === 'DELETE') return await remove(req, res, ctx);
    return sendError(res, 405, 'method_not_allowed');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function list(req, res, ctx) {
  const q = req.query || {};
  const params = [ctx.teamId];
  const where = ['m.team_id = $1'];
  if (q.status) { params.push(oneOf(q.status, MISSION_STATUS, 'status')); where.push(`m.status = $${params.length}`); }
  else where.push(`m.status <> 'archived'`);
  if (q.priority) { params.push(oneOf(q.priority, MISSION_PRIORITY, 'priority')); where.push(`m.priority = $${params.length}`); }
  if (q.pillar) { params.push(oneOf(q.pillar, PILLARS, 'pillar')); where.push(`m.pillar = $${params.length}`); }
  if (q.assignee) { params.push(uuid(q.assignee, 'assignee')); where.push(`m.assignee_id = $${params.length}`); }
  const { rows } = await query(
    `${SELECT} WHERE ${where.join(' AND ')}
      ORDER BY CASE m.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               m.updated_at DESC
      LIMIT 200`,
    params
  );
  return sendJSON(res, 200, { ok: true, missions: rows });
}

async function create(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const title = str(body.title, 'title', { min: 2, max: 200 });
  const objective = str(body.objective, 'objective', { required: false, max: 4000 }) || '';
  const status = optionalOneOf(body.status, MISSION_STATUS, 'status') || 'proposed';
  const priority = optionalOneOf(body.priority, MISSION_PRIORITY, 'priority') || 'medium';
  const pillar = optionalOneOf(body.pillar, PILLARS, 'pillar');
  const geography = str(body.geography, 'geography', { required: false, max: 160 });
  const assignee = optionalUuid(body.assigneeId, 'assigneeId');
  const sourceRef = str(body.sourceRef, 'sourceRef', { required: false, max: 200 });
  const dueAt = optionalDate(body.dueAt, 'dueAt');
  const metadata = jsonObject(body.metadata, 'metadata');

  if (assignee) await assertMember(ctx.teamId, assignee);

  const { rows } = await query(
    `INSERT INTO missions (team_id, title, objective, status, priority, pillar, geography, assignee_id, source_ref, metadata, due_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [ctx.teamId, title, objective, status, priority, pillar, geography, assignee, sourceRef, metadata, dueAt, ctx.user.id]
  );
  await audit(ctx, 'mission.create', 'mission', rows[0].id, { title });
  const full = await byId(ctx.teamId, rows[0].id);
  return sendJSON(res, 201, { ok: true, mission: full });
}

async function update(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const id = uuid(req.query.id, 'id');
  const body = await readJSON(req);
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (body.title !== undefined) push('title', str(body.title, 'title', { min: 2, max: 200 }));
  if (body.objective !== undefined) push('objective', str(body.objective, 'objective', { required: false, max: 4000 }) || '');
  if (body.status !== undefined) push('status', oneOf(body.status, MISSION_STATUS, 'status'));
  if (body.priority !== undefined) push('priority', oneOf(body.priority, MISSION_PRIORITY, 'priority'));
  if (body.pillar !== undefined) push('pillar', optionalOneOf(body.pillar, PILLARS, 'pillar'));
  if (body.geography !== undefined) push('geography', str(body.geography, 'geography', { required: false, max: 160 }));
  if (body.dueAt !== undefined) push('due_at', optionalDate(body.dueAt, 'dueAt'));
  if (body.metadata !== undefined) push('metadata', jsonObject(body.metadata, 'metadata'));
  if (body.assigneeId !== undefined) {
    const assignee = optionalUuid(body.assigneeId, 'assigneeId');
    if (assignee) await assertMember(ctx.teamId, assignee);
    push('assignee_id', assignee);
  }
  if (!sets.length) return sendError(res, 400, 'invalid', 'No changes supplied.');

  params.push(id, ctx.teamId);
  const { rows } = await query(
    `UPDATE missions SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND team_id = $${params.length} RETURNING id`,
    params
  );
  if (!rows.length) return sendError(res, 404, 'not_found', 'Mission not found.');
  await audit(ctx, 'mission.update', 'mission', id, { fields: sets.length });
  const full = await byId(ctx.teamId, id);
  return sendJSON(res, 200, { ok: true, mission: full });
}

async function remove(req, res, ctx) {
  const id = uuid(req.query.id, 'id');
  const hard = req.query.hard === '1' || req.query.hard === 'true';
  if (hard) {
    if (!requireWrite(req, res, ctx, 'admin')) return;
    const { rowCount } = await query('DELETE FROM missions WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
    if (!rowCount) return sendError(res, 404, 'not_found', 'Mission not found.');
    await audit(ctx, 'mission.delete', 'mission', id);
    return sendJSON(res, 200, { ok: true, deleted: true });
  }
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const { rows } = await query(
    `UPDATE missions SET status = 'archived' WHERE id = $1 AND team_id = $2 RETURNING id`,
    [id, ctx.teamId]
  );
  if (!rows.length) return sendError(res, 404, 'not_found', 'Mission not found.');
  await audit(ctx, 'mission.archive', 'mission', id);
  return sendJSON(res, 200, { ok: true, archived: true });
}

async function assertMember(teamId, userId) {
  const { rows } = await query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  if (!rows.length) throw new ValidationError('Assignee must be a member of this team.');
}

async function byId(teamId, id) {
  const { rows } = await query(`${SELECT} WHERE m.id = $1 AND m.team_id = $2`, [id, teamId]);
  return rows[0];
}
