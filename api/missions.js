// Missions API — tenant-scoped operational work items.
//
//   GET  /api/missions[?status=&priority=&pillar=&assignee=]  -> list (any member)
//   POST /api/missions                { ...fields }           -> create (analyst+)
//   PATCH/POST /api/missions?id=UUID  { ...partial }          -> update/assign/status (analyst+)
//   DELETE /api/missions?id=UUID                              -> archive (analyst+) / delete (admin+ with ?hard=1)
//
// All rows are scoped to the caller's active team; cross-tenant ids simply
// return not-found.

import { query, withTransaction } from './_db.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, roleAtLeast, audit } from './_auth.js';
import {
  str, uuid, optionalUuid, oneOf, optionalOneOf, optionalDate, jsonObject,
  MISSION_STATUS, MISSION_PRIORITY, PILLARS, ValidationError,
} from './_validate.js';
import {
  MISSION_TEMPLATES, templateByKey, instantiateTemplate, missionStatusCanTransition,
  taskStatusCanTransition, TASK_STATUS, slaClock, buildMissionBrief, buildAfterAction,
} from './_intel.js';

const SELECT = `
  SELECT m.id, m.title, m.objective, m.status, m.priority, m.pillar, m.geography,
         m.assignee_id, m.source_ref, m.metadata, m.due_at, m.created_by,
         m.created_at, m.updated_at, m.sla_minutes, m.activated_at, m.template_key, m.outcome,
         a.display_name AS assignee_name,
         c.display_name AS created_by_name
    FROM missions m
    LEFT JOIN users a ON a.id = m.assignee_id
    LEFT JOIN users c ON c.id = m.created_by`;

export default async function handler(req, res) {
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    const action = (req.query && req.query.action) || '';
    if (action) return await dispatchAction(req, res, ctx, action);
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

  const cur = await byId(ctx.teamId, id);
  if (!cur) return sendError(res, 404, 'not_found', 'Mission not found.');

  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  let statusChange = null;
  if (body.title !== undefined) push('title', str(body.title, 'title', { min: 2, max: 200 }));
  if (body.objective !== undefined) push('objective', str(body.objective, 'objective', { required: false, max: 4000 }) || '');
  if (body.status !== undefined) {
    const next = oneOf(body.status, MISSION_STATUS, 'status');
    if (!missionStatusCanTransition(cur.status, next)) {
      return sendError(res, 409, 'invalid_transition', `Cannot move a mission from ${cur.status} to ${next}.`);
    }
    push('status', next);
    statusChange = next;
    // Start the SLA clock the first time a mission goes active.
    if (next === 'active' && !cur.activated_at) push('activated_at', new Date().toISOString());
  }
  if (body.priority !== undefined) push('priority', oneOf(body.priority, MISSION_PRIORITY, 'priority'));
  if (body.pillar !== undefined) push('pillar', optionalOneOf(body.pillar, PILLARS, 'pillar'));
  if (body.geography !== undefined) push('geography', str(body.geography, 'geography', { required: false, max: 160 }));
  if (body.dueAt !== undefined) push('due_at', optionalDate(body.dueAt, 'dueAt'));
  if (body.slaMinutes !== undefined) push('sla_minutes', body.slaMinutes == null ? null : Math.max(0, Math.min(100000, parseInt(body.slaMinutes, 10) || 0)));
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
  if (statusChange) await logEvent(ctx, id, 'status', { from: cur.status, to: statusChange });
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

// Append-only activity stream entry (never throws into the request path).
async function logEvent(ctx, missionId, kind, detail = {}) {
  try {
    await query(
      `INSERT INTO mission_events (mission_id, team_id, kind, detail, actor_id) VALUES ($1,$2,$3,$4,$5)`,
      [missionId, ctx.teamId, kind, detail, ctx.user.id]
    );
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Phase III sub-resources (action-dispatched)
// ---------------------------------------------------------------------------
async function dispatchAction(req, res, ctx, action) {
  if (action === 'templates') return await listTemplates(req, res, ctx);
  if (action === 'from-template') return await fromTemplate(req, res, ctx);
  if (action === 'detail') return await detail(req, res, ctx);
  if (action === 'export') return await exportSummary(req, res, ctx);
  if (action === 'brief') return await brief(req, res, ctx);
  if (action === 'task-create') return await taskCreate(req, res, ctx);
  if (action === 'task-update') return await taskUpdate(req, res, ctx);
  if (action === 'task-delete') return await taskDelete(req, res, ctx);
  if (action === 'decision') return await decision(req, res, ctx);
  if (action === 'after-action') return await afterAction(req, res, ctx);
  return sendError(res, 404, 'unknown_action');
}

function listTemplates(req, res) {
  return sendJSON(res, 200, {
    ok: true,
    templates: MISSION_TEMPLATES.map((t) => ({
      key: t.key, name: t.name, pillar: t.pillar, priority: t.priority,
      slaMinutes: t.slaMinutes, objective: t.objective, tasks: t.tasks, gates: t.gates,
    })),
  });
}

async function fromTemplate(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const key = str(body.key, 'key', { max: 60 });
  if (!templateByKey(key)) return sendError(res, 400, 'invalid', 'Unknown template.');
  const seed = instantiateTemplate(key, {
    title: body.title ? str(body.title, 'title', { max: 200 }) : undefined,
    geography: body.geography ? str(body.geography, 'geography', { required: false, max: 160 }) : undefined,
    sourceRef: body.sourceRef ? str(body.sourceRef, 'sourceRef', { required: false, max: 200 }) : undefined,
  });
  const m = seed.mission;
  const created = await withTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO missions (team_id, title, objective, status, priority, pillar, geography, source_ref, sla_minutes, template_key, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.teamId, m.title, m.objective, m.status, m.priority, m.pillar, m.geography, m.sourceRef, m.slaMinutes, m.templateKey, ctx.user.id]
    );
    const missionId = ins.rows[0].id;
    for (const t of seed.tasks) {
      await client.query(
        `INSERT INTO mission_tasks (mission_id, team_id, title, status, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [missionId, ctx.teamId, t.title, t.status, t.sort, ctx.user.id]
      );
    }
    return missionId;
  });
  await logEvent(ctx, created, 'created', { template: key, gates: seed.gates });
  await audit(ctx, 'mission.from_template', 'mission', created, { template: key });
  const full = await byId(ctx.teamId, created);
  return sendJSON(res, 201, { ok: true, mission: full, gates: seed.gates });
}

async function loadDetail(ctx, id) {
  const mission = await byId(ctx.teamId, id);
  if (!mission) return null;
  const [tasks, decisions, events, alerts] = await Promise.all([
    query(`SELECT t.id, t.title, t.status, t.sort, t.assignee_id, t.due_at, t.created_at, t.updated_at,
                  u.display_name AS assignee_name
             FROM mission_tasks t LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.mission_id = $1 AND t.team_id = $2 ORDER BY t.sort, t.created_at`, [id, ctx.teamId]),
    query(`SELECT d.id, d.gate, d.decision, d.rationale, d.created_at, u.display_name AS decided_by_name
             FROM mission_decisions d LEFT JOIN users u ON u.id = d.decided_by
            WHERE d.mission_id = $1 AND d.team_id = $2 ORDER BY d.created_at DESC`, [id, ctx.teamId]),
    query(`SELECT e.id, e.kind, e.detail, e.created_at, u.display_name AS actor_name
             FROM mission_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE e.mission_id = $1 AND e.team_id = $2 ORDER BY e.created_at DESC LIMIT 100`, [id, ctx.teamId]),
    query(`SELECT id, title, severity, status, basis, confidence FROM alerts
            WHERE mission_id = $1 AND team_id = $2 ORDER BY created_at DESC`, [id, ctx.teamId]),
  ]);
  return {
    mission,
    tasks: tasks.rows,
    decisions: decisions.rows,
    events: events.rows,
    alerts: alerts.rows,
    sla: slaClock(mission),
  };
}

async function detail(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const d = await loadDetail(ctx, id);
  if (!d) return sendError(res, 404, 'not_found', 'Mission not found.');
  return sendJSON(res, 200, { ok: true, ...d });
}

async function brief(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const d = await loadDetail(ctx, id);
  if (!d) return sendError(res, 404, 'not_found', 'Mission not found.');
  return sendJSON(res, 200, { ok: true, brief: buildMissionBrief(d.mission, { tasks: d.tasks, alerts: d.alerts }) });
}

// Safe, non-public export summary (private by default — returned to the caller
// only, never shared or made publicly reachable).
async function exportSummary(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const d = await loadDetail(ctx, id);
  if (!d) return sendError(res, 404, 'not_found', 'Mission not found.');
  const m = d.mission;
  const lines = [
    `# Mission: ${m.title}`,
    `Status: ${m.status} · Priority: ${m.priority}${m.pillar ? ` · Pillar: ${m.pillar}` : ''}`,
    m.geography ? `Geography: ${m.geography}` : null,
    '', '## Objective', m.objective || '(none)',
    '', '## Tasks',
    ...d.tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title} (${t.status})`),
    '', '## Decisions',
    ...d.decisions.map((x) => `- ${x.gate}: ${x.decision}${x.rationale ? ` — ${x.rationale}` : ''}`),
  ].filter((x) => x !== null);
  await audit(ctx, 'mission.export', 'mission', id);
  return sendJSON(res, 200, { ok: true, format: 'markdown', shared: false, summary: lines.join('\n') });
}

async function requireMission(ctx, missionId) {
  const { rows } = await query('SELECT id, status FROM missions WHERE id = $1 AND team_id = $2', [missionId, ctx.teamId]);
  return rows[0] || null;
}

async function taskCreate(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const missionId = uuid(body.missionId, 'missionId');
  if (!(await requireMission(ctx, missionId))) return sendError(res, 404, 'not_found', 'Mission not found.');
  const title = str(body.title, 'title', { min: 1, max: 300 });
  const assignee = optionalUuid(body.assigneeId, 'assigneeId');
  if (assignee) await assertMember(ctx.teamId, assignee);
  const dueAt = optionalDate(body.dueAt, 'dueAt');
  const sortRes = await query('SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM mission_tasks WHERE mission_id = $1', [missionId]);
  const { rows } = await query(
    `INSERT INTO mission_tasks (mission_id, team_id, title, sort, assignee_id, due_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [missionId, ctx.teamId, title, sortRes.rows[0].next, assignee, dueAt, ctx.user.id]
  );
  await logEvent(ctx, missionId, 'task', { op: 'create', taskId: rows[0].id, title });
  return sendJSON(res, 201, { ok: true, ...(await loadDetail(ctx, missionId)) });
}

async function taskUpdate(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const taskId = uuid(body.taskId, 'taskId');
  const cur = await query('SELECT id, mission_id, status FROM mission_tasks WHERE id = $1 AND team_id = $2', [taskId, ctx.teamId]);
  if (!cur.rows.length) return sendError(res, 404, 'not_found', 'Task not found.');
  const t = cur.rows[0];
  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (body.title !== undefined) push('title', str(body.title, 'title', { min: 1, max: 300 }));
  if (body.status !== undefined) {
    const next = oneOf(body.status, TASK_STATUS, 'status');
    if (!taskStatusCanTransition(t.status, next)) {
      return sendError(res, 409, 'invalid_transition', `Cannot move a task from ${t.status} to ${next}.`);
    }
    push('status', next);
  }
  if (body.assigneeId !== undefined) {
    const assignee = optionalUuid(body.assigneeId, 'assigneeId');
    if (assignee) await assertMember(ctx.teamId, assignee);
    push('assignee_id', assignee);
  }
  if (body.dueAt !== undefined) push('due_at', optionalDate(body.dueAt, 'dueAt'));
  if (!sets.length) return sendError(res, 400, 'invalid', 'No changes supplied.');
  params.push(taskId, ctx.teamId);
  await query(`UPDATE mission_tasks SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND team_id = $${params.length}`, params);
  await logEvent(ctx, t.mission_id, 'task', { op: 'update', taskId, fields: sets.length });
  return sendJSON(res, 200, { ok: true, ...(await loadDetail(ctx, t.mission_id)) });
}

async function taskDelete(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const taskId = uuid(body.taskId, 'taskId');
  const cur = await query('SELECT mission_id FROM mission_tasks WHERE id = $1 AND team_id = $2', [taskId, ctx.teamId]);
  if (!cur.rows.length) return sendError(res, 404, 'not_found', 'Task not found.');
  const missionId = cur.rows[0].mission_id;
  await query('DELETE FROM mission_tasks WHERE id = $1 AND team_id = $2', [taskId, ctx.teamId]);
  await logEvent(ctx, missionId, 'task', { op: 'delete', taskId });
  return sendJSON(res, 200, { ok: true, ...(await loadDetail(ctx, missionId)) });
}

async function decision(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const missionId = uuid(body.missionId, 'missionId');
  if (!(await requireMission(ctx, missionId))) return sendError(res, 404, 'not_found', 'Mission not found.');
  const gate = str(body.gate, 'gate', { min: 1, max: 200 });
  const dec = oneOf(body.decision, ['approve', 'reject', 'hold', 'note'], 'decision');
  const rationale = str(body.rationale, 'rationale', { required: false, max: 2000 }) || '';
  const { rows } = await query(
    `INSERT INTO mission_decisions (mission_id, team_id, gate, decision, rationale, decided_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [missionId, ctx.teamId, gate, dec, rationale, ctx.user.id]
  );
  await logEvent(ctx, missionId, 'decision', { decisionId: rows[0].id, gate, decision: dec });
  await audit(ctx, 'mission.decision', 'mission', missionId, { gate, decision: dec });
  return sendJSON(res, 201, { ok: true, ...(await loadDetail(ctx, missionId)) });
}

async function afterAction(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const missionId = uuid(body.missionId, 'missionId');
  const d = await loadDetail(ctx, missionId);
  if (!d) return sendError(res, 404, 'not_found', 'Mission not found.');
  const summary = buildAfterAction(d.mission, { tasks: d.tasks, decisions: d.decisions });
  const outcome = { ...summary, note: str(body.note, 'note', { required: false, max: 2000 }) || summary.note };
  await query('UPDATE missions SET outcome = $1 WHERE id = $2 AND team_id = $3', [outcome, missionId, ctx.teamId]);
  await logEvent(ctx, missionId, 'note', { op: 'after-action' });
  await audit(ctx, 'mission.after_action', 'mission', missionId);
  return sendJSON(res, 200, { ok: true, outcome, ...(await loadDetail(ctx, missionId)) });
}
