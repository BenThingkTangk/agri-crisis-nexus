// Alert policies (Phase IV) — team-scoped rules matched against fresh zone
// snapshots during evaluation.
//
//   GET  /api/policies?action=list                -> policies
//   POST /api/policies?action=save   (analyst+)   -> create/update a policy
//   POST /api/policies?action=toggle (analyst+)   -> enable/disable
//   POST /api/policies?action=delete (analyst+)   -> delete
//
// A policy selects zones (empty = all), a minimum watch band, optional threat
// dimensions, quiet hours, cooldown/repeat, and an optional escalation channel.

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { str, uuid, optionalUuid, oneOf, jsonObject, ValidationError } from './_validate.js';
import { WATCH_BANDS, ZONE_DIMENSIONS } from './_intel.js';

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listPolicies(req, res, ctx);
    if (action === 'save') return await savePolicy(req, res, ctx);
    if (action === 'toggle') return await togglePolicy(req, res, ctx);
    if (action === 'delete') return await deletePolicy(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[policies] server_error', err && (err.code || err.message));
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function ensureReady(res) {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('[policies] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

async function listPolicies(req, res, ctx) {
  const { rows } = await query(
    `SELECT id, name, enabled, min_band, geofence_ids, threats, quiet_hours,
            cooldown_minutes, repeat, escalation_target, created_at, updated_at
       FROM alert_policies WHERE team_id = $1 ORDER BY created_at ASC`,
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, policies: rows, bands: WATCH_BANDS, dimensions: ZONE_DIMENSIONS });
}

function parseQuietHours(raw) {
  const q = jsonObject(raw, 'quietHours');
  if (q.start == null && q.end == null) return {};
  const start = Number(q.start);
  const end = Number(q.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 0 || end > 23) {
    throw new ValidationError('quietHours start/end must be integers 0-23');
  }
  const tzOffsetMinutes = Number.isFinite(Number(q.tzOffsetMinutes)) ? Number(q.tzOffsetMinutes) : 0;
  return { start, end, tzOffsetMinutes };
}

async function savePolicy(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const name = str(body.name, 'name', { min: 2, max: 120 });
  const enabled = body.enabled !== false;
  const minBand = body.minBand ? oneOf(body.minBand, WATCH_BANDS, 'minBand') : 'elevated';
  const geofenceIds = Array.isArray(body.geofenceIds)
    ? body.geofenceIds.slice(0, 100).map((v) => uuid(v, 'geofenceIds'))
    : [];
  const threats = Array.isArray(body.threats)
    ? body.threats.slice(0, 8).map((v) => oneOf(v, ZONE_DIMENSIONS, 'threats'))
    : [];
  const quietHours = parseQuietHours(body.quietHours);
  const cooldown = Math.max(0, Math.min(10080, Number(body.cooldownMinutes) || 360));
  const repeat = body.repeat === true;
  const escalation = body.escalationTarget ? str(body.escalationTarget, 'escalationTarget', { required: false, max: 200 }) : null;

  // Only allow selecting zones that belong to this team.
  if (geofenceIds.length) {
    const chk = await query('SELECT COUNT(*)::int AS n FROM geofences WHERE team_id = $1 AND id = ANY($2::uuid[])', [ctx.teamId, geofenceIds]);
    if (chk.rows[0].n !== geofenceIds.length) return sendError(res, 400, 'invalid', 'One or more zones are not in this team.');
  }

  if (body.id) {
    const id = uuid(body.id, 'id');
    const { rows } = await query(
      `UPDATE alert_policies
          SET name=$1, enabled=$2, min_band=$3, geofence_ids=$4, threats=$5,
              quiet_hours=$6, cooldown_minutes=$7, repeat=$8, escalation_target=$9
        WHERE id=$10 AND team_id=$11 RETURNING id`,
      [name, enabled, minBand, geofenceIds, threats, JSON.stringify(quietHours), cooldown, repeat, escalation, id, ctx.teamId]
    );
    if (!rows.length) return sendError(res, 404, 'not_found', 'Policy not found.');
    await audit(ctx, 'policy.update', 'alert_policy', id);
    return sendJSON(res, 200, { ok: true, id });
  }
  const { rows } = await query(
    `INSERT INTO alert_policies
       (team_id, name, enabled, min_band, geofence_ids, threats, quiet_hours, cooldown_minutes, repeat, escalation_target, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.teamId, name, enabled, minBand, geofenceIds, threats, JSON.stringify(quietHours), cooldown, repeat, escalation, ctx.user.id]
  );
  await audit(ctx, 'policy.create', 'alert_policy', rows[0].id, { name });
  return sendJSON(res, 201, { ok: true, id: rows[0].id });
}

async function togglePolicy(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const enabled = body.enabled !== false;
  const { rowCount } = await query('UPDATE alert_policies SET enabled = $1 WHERE id = $2 AND team_id = $3', [enabled, id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Policy not found.');
  await audit(ctx, 'policy.toggle', 'alert_policy', id, { enabled });
  return sendJSON(res, 200, { ok: true, id, enabled });
}

async function deletePolicy(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const { rowCount } = await query('DELETE FROM alert_policies WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Policy not found.');
  await audit(ctx, 'policy.delete', 'alert_policy', id);
  return sendJSON(res, 200, { ok: true, deleted: true });
}
