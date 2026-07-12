// War Room scenarios — saved simulations, team-scoped, with history/replay.
//
//   GET  /api/scenarios[?limit=]     -> recent scenarios for the active team
//   GET  /api/scenarios?id=UUID      -> one scenario (for replay)
//   POST /api/scenarios              { title, threat, pillar, params, result } (analyst+)
//   DELETE /api/scenarios?id=UUID    -> delete own (analyst+) / any (admin+)

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, roleAtLeast, audit } from './_auth.js';
import { str, uuid, oneOf, jsonObject, PILLARS, ValidationError } from './_validate.js';

const SELECT = `
  SELECT s.id, s.title, s.threat, s.pillar, s.params, s.result, s.created_by,
         s.created_at, u.display_name AS created_by_name
    FROM scenarios s LEFT JOIN users u ON u.id = s.created_by`;

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  // Honor both identity layers so an account-bearer operator is not falsely
  // rejected on this auxiliary surface (see teams.js for the same bridge).
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (req.method === 'GET') return (req.query && req.query.id) ? await getOne(req, res, ctx) : await list(req, res, ctx);
    if (req.method === 'POST') return await create(req, res, ctx);
    if (req.method === 'DELETE') return await remove(req, res, ctx);
    return sendError(res, 405, 'method_not_allowed');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[scenarios] server_error', err && (err.code || err.message));
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

// Apply any pending Phase III schema before serving. On failure, log a safe
// diagnostic (code/message only — never secrets or the DSN) and return a
// generic retryable error rather than a raw SQL fault.
async function ensureReady(res) {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('[scenarios] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

async function list(req, res, ctx) {
  const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '25', 10) || 25, 1), 100);
  const { rows } = await query(
    `${SELECT} WHERE s.team_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [ctx.teamId, limit]
  );
  return sendJSON(res, 200, { ok: true, scenarios: rows });
}

async function getOne(req, res, ctx) {
  const id = uuid(req.query.id, 'id');
  const { rows } = await query(`${SELECT} WHERE s.id = $1 AND s.team_id = $2`, [id, ctx.teamId]);
  if (!rows.length) return sendError(res, 404, 'not_found', 'Scenario not found.');
  return sendJSON(res, 200, { ok: true, scenario: rows[0] });
}

async function create(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const title = str(body.title, 'title', { min: 2, max: 160 });
  const threat = str(body.threat, 'threat', { min: 1, max: 160 });
  const pillar = oneOf(body.pillar, PILLARS, 'pillar');
  const params = jsonObject(body.params, 'params');
  const result = jsonObject(body.result, 'result');
  const { rows } = await query(
    `INSERT INTO scenarios (team_id, title, threat, pillar, params, result, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [ctx.teamId, title, threat, pillar, params, result, ctx.user.id]
  );
  await audit(ctx, 'scenario.save', 'scenario', rows[0].id, { title, threat });
  return sendJSON(res, 201, { ok: true, scenario: { id: rows[0].id, title, threat, pillar, params, result, created_at: rows[0].created_at, created_by: ctx.user.id, created_by_name: ctx.user.displayName } });
}

async function remove(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const id = uuid(req.query.id, 'id');
  const owned = await query('SELECT created_by FROM scenarios WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!owned.rows.length) return sendError(res, 404, 'not_found', 'Scenario not found.');
  if (owned.rows[0].created_by !== ctx.user.id && !roleAtLeast(ctx.role, 'admin')) {
    return sendError(res, 403, 'forbidden', 'You can only delete scenarios you created.');
  }
  await query('DELETE FROM scenarios WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  await audit(ctx, 'scenario.delete', 'scenario', id);
  return sendJSON(res, 200, { ok: true, deleted: true });
}
