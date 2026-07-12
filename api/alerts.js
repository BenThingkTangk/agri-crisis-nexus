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
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { str, uuid, optionalUuid, oneOf, strArray, SEVERITIES, ValidationError } from './_validate.js';
import {
  deriveAlertsDetailed, alertActionToStatus, alertStatusCanTransition, explainAlert, buildAlertExplanation,
  alertRelevance, AG_PROMOTE_THRESHOLD,
} from './_intel.js';

const SEV_RANK = { moderate: 1, high: 2, critical: 3 };

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listAlerts(req, res, ctx);
    if (action === 'sync') return await sync(req, res, ctx);
    if (action === 'derive') return await derive(req, res, ctx);
    if (action === 'explain') return await explain(req, res, ctx);
    if (action === 'acknowledge' || action === 'escalate' || action === 'resolve') return await lifecycle(req, res, ctx, action);
    if (action === 'assign') return await assign(req, res, ctx);
    if (action === 'link-mission') return await linkMission(req, res, ctx);
    if (action === 'mark-read') return await markRead(req, res, ctx);
    if (action === 'mark-all') return await markAll(req, res, ctx);
    if (action === 'rules') return await listRules(req, res, ctx);
    if (action === 'rule-save') return await saveRule(req, res, ctx);
    if (action === 'rule-delete') return await deleteRule(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[alerts] server_error', err && (err.code || err.message));
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
    console.error('[alerts] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

async function alertsPayload(ctx, limit = 60) {
  const { rows } = await query(
    `SELECT a.id, a.source, a.title, a.category, a.severity, a.geography, a.url,
            a.event_at, a.created_at, a.updated_at,
            a.status, a.basis, a.confidence, a.horizon, a.regions, a.commodities,
            a.causal_chain, a.assumptions, a.owner_id, a.mission_id,
            a.acknowledged_at, a.escalated_at, a.resolved_at,
            o.display_name AS owner_name,
            (r.user_id IS NOT NULL) AS is_read
       FROM alerts a
       LEFT JOIN alert_reads r ON r.alert_id = a.id AND r.user_id = $2
       LEFT JOIN users o ON o.id = a.owner_id
      WHERE a.team_id = $1
        AND COALESCE((a.metadata->>'suppressed')::boolean, false) = false
      ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               a.created_at DESC
      LIMIT $3`,
    [ctx.teamId, ctx.user.id, limit]
  );
  const unread = rows.filter((a) => !a.is_read).length;
  const open = rows.filter((a) => a.status !== 'resolved').length;
  return { alerts: rows, unread, open };
}

async function alertRow(ctx, id) {
  const { rows } = await query(
    `SELECT id, source, title, category, severity, geography, url, status, basis,
            confidence, horizon, regions, commodities, causal_chain, assumptions,
            owner_id, mission_id
       FROM alerts WHERE id = $1 AND team_id = $2`,
    [id, ctx.teamId]
  );
  return rows[0] || null;
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

  // Same idempotent reconciliation as derive: retire stale low-relevance
  // auto-generated observed alerts while preserving any human-touched record.
  const suppressed = await reconcileLowRelevance(ctx, rules);

  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, inserted, suppressed, ...payload });
}

// Fetch the live feed for the derive pass (same source as sync).
async function fetchLiveEvents(req) {
  try {
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const r = await fetch(`${proto}://${host}/api/live`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      return Array.isArray(j.events) ? j.events : [];
    }
  } catch (_) { /* live feed unreachable */ }
  return [];
}

// Predictive derivation: build observed + modeled alerts and materialize any
// that are new (deduped on team_id+event_key). Modeled projections are stored
// with basis='modeled' + confidence + assumptions so the UI can label them.
async function derive(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  // Optional analyst-supplied crop-risk state (labeled modeled downstream).
  const cropRisk = Array.isArray(body.cropRisk) ? body.cropRisk.slice(0, 100) : [];
  const events = await fetchLiveEvents(req);

  // The team's enabled rules bias relevance toward what analysts care about, so
  // derivation is grounded in this team's stated agricultural exposure — not a
  // generic hazard mirror.
  const rules = await enabledRules(ctx);
  const { alerts: derived, stats } = deriveAlertsDetailed({ events, cropRisk, now: Date.now(), rules });

  let inserted = 0;
  for (const a of derived) {
    const eventAt = a.eventAt ? new Date(a.eventAt) : null;
    const { rowCount } = await query(
      `INSERT INTO alerts
         (team_id, event_key, source, title, category, severity, geography, url, event_at,
          status, basis, confidence, horizon, regions, commodities, causal_chain, assumptions, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (team_id, event_key) DO NOTHING`,
      [
        ctx.teamId, a.key,
        str(a.source, 's', { required: false, max: 80 }),
        str(a.title, 't', { required: false, max: 400 }) || 'Alert',
        str(a.category, 'c', { required: false, max: 120 }),
        a.severity,
        str(a.geography, 'g', { required: false, max: 200 }),
        str(a.url, 'u', { required: false, max: 500 }),
        eventAt && !Number.isNaN(eventAt.getTime()) ? eventAt.toISOString() : null,
        a.basis, a.confidence, a.horizon,
        a.regions || [], a.commodities || [],
        JSON.stringify(a.causalChain || []), JSON.stringify(a.assumptions || []),
        { modeled: !!a.modeled, ag_relevance: a.agRelevance != null ? a.agRelevance : null },
      ]
    );
    inserted += rowCount;
  }

  // Idempotently reconcile previously auto-generated low-relevance observed
  // alerts (e.g. the QA-era raw hazard mirror) into a suppressed/resolved state
  // WITHOUT destroying data or touching human-touched records.
  const suppressed = await reconcileLowRelevance(ctx, rules);

  await audit(ctx, 'alert.derive', 'alert', null, { inserted, considered: stats.considered, ...stats, suppressed });
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, inserted, considered: stats.considered, stats, suppressed, ...payload });
}

// Load the active team's enabled alert rules (relevance-scoring inputs).
async function enabledRules(ctx) {
  const { rows } = await query(
    `SELECT id, min_severity, categories, geographies FROM alert_rules WHERE team_id = $1 AND enabled = TRUE`,
    [ctx.teamId]
  );
  return rows;
}

// Non-destructive, auditable reconciliation. Recompute agricultural relevance
// for auto-generated OBSERVED alerts still in the 'new' state and, when they
// fall below the promotion threshold, mark them suppressed + resolved with a
// reason. The UPDATE re-asserts every protection predicate so a concurrent
// acknowledge/escalate/assign/mission-link can never be clobbered. Records that
// are acknowledged, escalated, owned, mission-linked, analyst/modeled, or
// already suppressed are left untouched.
async function reconcileLowRelevance(ctx, rules) {
  const { rows } = await query(
    `SELECT id, title, category, geography, severity, commodities, regions
       FROM alerts
      WHERE team_id = $1 AND status = 'new' AND basis = 'observed'
        AND mission_id IS NULL AND owner_id IS NULL
        AND acknowledged_at IS NULL AND escalated_at IS NULL
        AND COALESCE((metadata->>'suppressed')::boolean, false) = false
      LIMIT 500`,
    [ctx.teamId]
  );
  let suppressed = 0;
  for (const r of rows) {
    const relevance = alertRelevance(r, rules);
    if (relevance >= AG_PROMOTE_THRESHOLD) continue;
    const patch = {
      suppressed: true,
      suppress_reason: 'low_ag_relevance',
      ag_relevance: relevance,
      suppressed_at: new Date().toISOString(),
    };
    const { rowCount } = await query(
      `UPDATE alerts
          SET status = 'resolved', resolved_at = now(),
              metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
        WHERE id = $1 AND team_id = $3
          AND status = 'new' AND basis = 'observed'
          AND mission_id IS NULL AND owner_id IS NULL
          AND acknowledged_at IS NULL AND escalated_at IS NULL`,
      [r.id, JSON.stringify(patch), ctx.teamId]
    );
    if (rowCount) {
      suppressed += 1;
      await audit(ctx, 'alert.suppress', 'alert', r.id, { reason: 'low_ag_relevance', ag_relevance: relevance });
    }
  }
  return suppressed;
}

// Explainability panel for a single alert.
async function explain(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const a = await alertRow(ctx, id);
  if (!a) return sendError(res, 404, 'not_found', 'Alert not found.');
  return sendJSON(res, 200, { ok: true, explanation: explainAlert(a), atom: buildAlertExplanation(a) });
}

// Status transitions: acknowledge / escalate / resolve. Validated against the
// alert state machine so illegal jumps (e.g. resolved -> new) are rejected.
async function lifecycle(req, res, ctx, action) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const next = alertActionToStatus(action);
  const a = await alertRow(ctx, id);
  if (!a) return sendError(res, 404, 'not_found', 'Alert not found.');
  if (!alertStatusCanTransition(a.status, next)) {
    return sendError(res, 409, 'invalid_transition', `Cannot ${action} an alert that is ${a.status}.`);
  }
  const stamp = { acknowledged: 'acknowledged_at', escalated: 'escalated_at', resolved: 'resolved_at' }[next];
  await query(
    `UPDATE alerts SET status = $1, ${stamp} = now() WHERE id = $2 AND team_id = $3`,
    [next, id, ctx.teamId]
  );
  await audit(ctx, `alert.${action}`, 'alert', id, { from: a.status, to: next });
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, id, status: next, ...payload });
}

async function assign(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const ownerId = optionalUuid(body.ownerId, 'ownerId');
  if (ownerId) {
    const m = await query('SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2', [ctx.teamId, ownerId]);
    if (!m.rows.length) return sendError(res, 400, 'invalid', 'Owner must be a member of this team.');
  }
  const { rowCount } = await query(
    'UPDATE alerts SET owner_id = $1 WHERE id = $2 AND team_id = $3',
    [ownerId, id, ctx.teamId]
  );
  if (!rowCount) return sendError(res, 404, 'not_found', 'Alert not found.');
  await audit(ctx, 'alert.assign', 'alert', id, { ownerId });
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, id, ...payload });
}

// Link an alert to a mission (the persisted side of "escalate to mission").
async function linkMission(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const missionId = optionalUuid(body.missionId, 'missionId');
  if (missionId) {
    const m = await query('SELECT 1 FROM missions WHERE id = $1 AND team_id = $2', [missionId, ctx.teamId]);
    if (!m.rows.length) return sendError(res, 400, 'invalid', 'Mission not found for this team.');
  }
  const { rowCount } = await query(
    'UPDATE alerts SET mission_id = $1 WHERE id = $2 AND team_id = $3',
    [missionId, id, ctx.teamId]
  );
  if (!rowCount) return sendError(res, 404, 'not_found', 'Alert not found.');
  await audit(ctx, 'alert.link_mission', 'alert', id, { missionId });
  const payload = await alertsPayload(ctx);
  return sendJSON(res, 200, { ok: true, id, missionId, ...payload });
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
