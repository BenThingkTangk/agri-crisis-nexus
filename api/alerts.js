// Alerts + alert rules + per-user read state.
//
//   GET  /api/alerts?action=list                  -> recent alerts + unread count
//   POST /api/alerts?action=sync                  -> pull live feed, materialize new alerts, return list
//   POST /api/alerts?action=mark-read   { id }    -> mark one read for the caller
//   POST /api/alerts?action=mark-all              -> mark all read for the caller
//   GET  /api/alerts?action=rules                 -> list rules
//   POST /api/alerts?action=rule-save { id?, name, enabled, minSeverity, categories, geographies } (analyst+)
//   POST /api/alerts?action=rule-delete { id }    (analyst+)
//
// Sync fetches the existing keyless live feed (/api/live), evaluates each event
// against the team's enabled rules, and inserts deduped alerts (unique on
// team_id+event_key). Read state is per user via alert_reads.

import { query, withTransaction } from './_db.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAuth, requireWrite, audit } from './_auth.js';
import { str, uuid, oneOf, strArray, SEVERITIES, ValidationError } from './_validate.js';

const SEV_RANK = { moderate: 1, high: 2, critical: 3 };

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listAlerts(req, res, ctx);
    if (action === 'sync') return await sync(req, res, ctx);
    if (action === 'mark-read') return await markRead(req, res, ctx);
    if (action === 'mark-all') return await markAll(req, res, ctx);
    if (action === 'rules') return await listRules(req, res, ctx);
    if (action === 'rule-save') return await saveRule(req, res, ctx);
    if (action === 'rule-delete') return await deleteRule(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function alertsPayload(ctx, limit = 60) {
  const { rows } = await query(
    `SELECT a.id, a.source, a.title, a.category, a.severity, a.geography, a.url,
            a.event_at, a.created_at, (r.user_id IS NOT NULL) AS is_read
       FROM alerts a
       LEFT JOIN alert_reads r ON r.alert_id = a.id AND r.user_id = $2
      WHERE a.team_id = $1
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [ctx.teamId, ctx.user.id, limit]
  );
  const unread = rows.filter((a) => !a.is_read).length;
  return { alerts: rows, unread };
}

async function listAlerts(req, res, ctx) {
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, ...payload });
}

async function listRules(req, res, ctx) {
  const { rows } = await query(
    `SELECT id, name, enabled, min_severity, categories, geographies, created_at
       FROM alert_rules WHERE team_id = $1 ORDER BY created_at ASC`,
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, rules: rows });
}

async function saveRule(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const name = str(body.name, 'name', { min: 2, max: 120 });
  const enabled = body.enabled !== false;
  const minSeverity = body.minSeverity ? oneOf(body.minSeverity, SEVERITIES, 'minSeverity') : 'moderate';
  const categories = strArray(body.categories, 'categories');
  const geographies = strArray(body.geographies, 'geographies');

  if (body.id) {
    const id = uuid(body.id, 'id');
    const { rows } = await query(
      `UPDATE alert_rules SET name=$1, enabled=$2, min_severity=$3, categories=$4, geographies=$5
        WHERE id=$6 AND team_id=$7 RETURNING id`,
      [name, enabled, minSeverity, categories, geographies, id, ctx.teamId]
    );
    if (!rows.length) return sendError(res, 404, 'not_found', 'Rule not found.');
    await audit(ctx, 'alert_rule.update', 'alert_rule', id);
    return sendJSON(res, 200, { ok: true, id });
  }
  const { rows } = await query(
    `INSERT INTO alert_rules (team_id, name, enabled, min_severity, categories, geographies, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.teamId, name, enabled, minSeverity, categories, geographies, ctx.user.id]
  );
  await audit(ctx, 'alert_rule.create', 'alert_rule', rows[0].id, { name });
  return sendJSON(res, 201, { ok: true, id: rows[0].id });
}

async function deleteRule(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const { rowCount } = await query('DELETE FROM alert_rules WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Rule not found.');
  await audit(ctx, 'alert_rule.delete', 'alert_rule', id);
  return sendJSON(res, 200, { ok: true, deleted: true });
}

async function markRead(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'viewer')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  // Only allow marking alerts that belong to the active team.
  const belongs = await query('SELECT 1 FROM alerts WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!belongs.rows.length) return sendError(res, 404, 'not_found', 'Alert not found.');
  await query(
    `INSERT INTO alert_reads (alert_id, user_id) VALUES ($1, $2)
     ON CONFLICT (alert_id, user_id) DO NOTHING`,
    [id, ctx.user.id]
  );
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, ...payload });
}

async function markAll(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'viewer')) return;
  await query(
    `INSERT INTO alert_reads (alert_id, user_id)
       SELECT a.id, $2 FROM alerts a
        WHERE a.team_id = $1
          AND NOT EXISTS (SELECT 1 FROM alert_reads r WHERE r.alert_id = a.id AND r.user_id = $2)`,
    [ctx.teamId, ctx.user.id]
  );
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, ...payload });
}

// Fetch the live feed and materialize new alerts for the active team.
async function sync(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'viewer')) return;

  const rulesRes = await query(
    `SELECT id, min_severity, categories, geographies FROM alert_rules WHERE team_id = $1 AND enabled = TRUE`,
    [ctx.teamId]
  );
  const rules = rulesRes.rows;

  let events = [];
  try {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const r = await fetch(`${proto}://${host}/api/live`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      events = Array.isArray(j.events) ? j.events : [];
    }
  } catch (_) {
    // Live feed unreachable — return whatever is already stored.
  }

  let inserted = 0;
  if (rules.length && events.length) {
    for (const ev of events) {
      const match = rules.find((rule) => eventMatchesRule(ev, rule));
      if (!match) continue;
      const eventKey = String(ev.id || `${ev.source}:${ev.title}`).slice(0, 300);
      const severity = SEVERITIES.includes(ev.severity) ? ev.severity : 'moderate';
      const eventAt = ev.published ? new Date(ev.published) : null;
      const { rowCount } = await query(
        `INSERT INTO alerts (team_id, rule_id, event_key, source, title, category, severity, geography, url, event_at, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (team_id, event_key) DO NOTHING`,
        [
          ctx.teamId, match.id, eventKey,
          str(ev.source, 's', { required: false, max: 80 }),
          str(ev.title, 't', { required: false, max: 400 }) || 'Alert',
          str(ev.category, 'c', { required: false, max: 120 }),
          severity,
          str(ev.geography, 'g', { required: false, max: 200 }),
          str(ev.url, 'u', { required: false, max: 500 }),
          eventAt && !Number.isNaN(eventAt.getTime()) ? eventAt.toISOString() : null,
          {},
        ]
      );
      inserted += rowCount;
    }
  }

  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, inserted, ...payload });
}

function eventMatchesRule(ev, rule) {
  const evRank = SEV_RANK[ev.severity] || 1;
  if (evRank < (SEV_RANK[rule.min_severity] || 1)) return false;
  if (rule.categories && rule.categories.length) {
    const cat = String(ev.category || '').toLowerCase();
    if (!rule.categories.some((c) => cat.includes(String(c).toLowerCase()))) return false;
  }
  if (rule.geographies && rule.geographies.length) {
    const geo = String(ev.geography || '').toLowerCase();
    if (!rule.geographies.some((g) => geo.includes(String(g).toLowerCase()))) return false;
  }
  return true;
}
