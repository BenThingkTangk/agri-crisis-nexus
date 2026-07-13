// Notification center + evaluation pass (Phase IV).
//
//   GET  /api/notifications?action=list              -> inbox (+ unread count)
//   GET  /api/notifications?action=summary           -> command summary
//   POST /api/notifications?action=read      { id }   -> mark read
//   POST /api/notifications?action=unread    { id }   -> mark unread
//   POST /api/notifications?action=acknowledge { id } -> acknowledge
//   POST /api/notifications?action=convert-mission { id } (analyst+) -> spin up a mission
//   POST /api/notifications?action=evaluate   (analyst+) -> score zones, match policies,
//                                                           create deduplicated notifications
//
// Evaluation is an explicit, job-safe action (no background scheduler is claimed).
// It re-scores enabled zones, persists snapshots, then matches enabled policies
// and creates deduplicated notification events. External fan-out is NOT performed
// here — it is an explicit, owner-driven action via /api/integrations.

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { uuid, str, ValidationError } from './_validate.js';
import {
  shouldNotify, notificationDedupeKey, notificationStateCanTransition, notificationActionToState,
} from './_intel.js';
import { fetchLiveEvents, latestScenario, scoreAndPersist } from './geofences.js';

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listNotifications(req, res, ctx);
    if (action === 'summary') return await summary(req, res, ctx);
    if (action === 'read' || action === 'unread' || action === 'acknowledge') return await transition(req, res, ctx, action);
    if (action === 'convert-mission') return await convertMission(req, res, ctx);
    if (action === 'evaluate') return await evaluate(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[notifications] server_error', err && (err.code || err.message));
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function ensureReady(res) {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('[notifications] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

async function inboxPayload(ctx, limit = 100) {
  const { rows } = await query(
    `SELECT n.id, n.title, n.body, n.band, n.score, n.state, n.payload,
            n.delivery_state, n.delivery_attempts, n.next_retry_at, n.last_error,
            n.geofence_id, n.policy_id, n.mission_id, n.alert_id,
            n.read_at, n.acknowledged_at, n.created_at,
            g.name AS zone_name
       FROM notifications n
       LEFT JOIN geofences g ON g.id = n.geofence_id
      WHERE n.team_id = $1
      ORDER BY n.created_at DESC LIMIT $2`,
    [ctx.teamId, limit]
  );
  const unread = rows.filter((n) => n.state === 'unread').length;
  return { notifications: rows, unread };
}

async function listNotifications(req, res, ctx) {
  const payload = await inboxPayload(ctx);
  return sendJSON(res, 200, { ok: true, ...payload });
}

async function notificationRow(ctx, id) {
  const { rows } = await query('SELECT * FROM notifications WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  return rows[0] || null;
}

// Command summary: zones under watch, rising scores, stale feeds, delivery
// health, and next recommended actions. All derived from persisted state.
async function summary(req, res, ctx) {
  const zonesRes = await query(
    `SELECT g.id, g.name, g.kind,
            s.score, s.band, s.trend, s.delta, s.stale, s.created_at AS scored_at
       FROM geofences g
       LEFT JOIN LATERAL (
         SELECT * FROM zone_scores z WHERE z.geofence_id = g.id ORDER BY z.created_at DESC LIMIT 1
       ) s ON TRUE
      WHERE g.team_id = $1 AND g.enabled = TRUE`,
    [ctx.teamId]
  );
  const zones = zonesRes.rows;
  const underWatch = zones.filter((z) => z.band && ['elevated', 'high', 'critical'].includes(z.band));
  const rising = zones.filter((z) => z.trend === 'rising');
  const stale = zones.filter((z) => z.stale);
  const unscored = zones.filter((z) => z.score == null);

  const inbox = await query(
    `SELECT state, COUNT(*)::int AS n FROM notifications WHERE team_id = $1 GROUP BY state`,
    [ctx.teamId]
  );
  const delivery = await query(
    `SELECT delivery_state, COUNT(*)::int AS n FROM notifications WHERE team_id = $1 GROUP BY delivery_state`,
    [ctx.teamId]
  );

  const nextActions = [];
  if (unscored.length) nextActions.push(`Run an evaluation — ${unscored.length} enabled zone(s) have no score yet.`);
  if (underWatch.length) nextActions.push(`Review ${underWatch.length} zone(s) at elevated+ watch band.`);
  if (rising.length) nextActions.push(`Investigate ${rising.length} zone(s) with a rising trend.`);
  if (stale.length) nextActions.push(`Refresh feeds — ${stale.length} zone(s) rely on stale data.`);
  if (!zones.length) nextActions.push('Seed the starter catalog or create a custom zone to begin monitoring.');

  return sendJSON(res, 200, {
    ok: true,
    counts: {
      zones: zones.length,
      underWatch: underWatch.length,
      rising: rising.length,
      stale: stale.length,
      unscored: unscored.length,
    },
    topZones: [...zones].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5),
    inboxByState: Object.fromEntries(inbox.rows.map((r) => [r.state, r.n])),
    deliveryByState: Object.fromEntries(delivery.rows.map((r) => [r.delivery_state, r.n])),
    nextActions,
  });
}

// State transitions validated by the notification state machine.
async function transition(req, res, ctx, action) {
  if (!requireWrite(req, res, ctx, 'viewer')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const n = await notificationRow(ctx, id);
  if (!n) return sendError(res, 404, 'not_found', 'Notification not found.');
  const next = notificationActionToState(action);
  if (!notificationStateCanTransition(n.state, next)) {
    return sendError(res, 409, 'invalid_transition', `Cannot move a ${n.state} notification to ${next}.`);
  }
  const sets = ['state = $1'];
  const params = [next, id, ctx.teamId];
  if (next === 'read') sets.push('read_at = COALESCE(read_at, now())');
  if (next === 'unread') sets.push('read_at = NULL', 'acknowledged_at = NULL', 'acknowledged_by = NULL');
  if (next === 'acknowledged') {
    sets.push('acknowledged_at = now()', 'acknowledged_by = $4', 'read_at = COALESCE(read_at, now())');
    params.push(ctx.user.id);
  }
  await query(`UPDATE notifications SET ${sets.join(', ')} WHERE id = $2 AND team_id = $3`, params);
  await audit(ctx, `notification.${action}`, 'notification', id, { from: n.state, to: next });
  const payload = await inboxPayload(ctx);
  return sendJSON(res, 200, { ok: true, id, state: next, ...payload });
}

// Convert a notification's zone context into a proposed mission and link them.
async function convertMission(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const n = await notificationRow(ctx, id);
  if (!n) return sendError(res, 404, 'not_found', 'Notification not found.');
  if (n.mission_id) return sendJSON(res, 200, { ok: true, id, missionId: n.mission_id, alreadyLinked: true });

  const zone = n.geofence_id
    ? (await query('SELECT name, region FROM geofences WHERE id = $1 AND team_id = $2', [n.geofence_id, ctx.teamId])).rows[0]
    : null;
  const title = str(body.title, 'title', { required: false, max: 200 })
    || `Early-warning response: ${zone ? zone.name : n.title}`.slice(0, 200);
  const priority = ({ critical: 'critical', high: 'high', elevated: 'medium' })[n.band] || 'medium';

  const m = await query(
    `INSERT INTO missions (team_id, title, objective, status, priority, geography, source_ref, metadata, created_by)
     VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8) RETURNING id`,
    [
      ctx.teamId, title,
      `Respond to elevated watch score (${n.score}/100, ${n.band}) for ${zone ? zone.name : 'monitored zone'}.`,
      priority, zone ? zone.region : null, `notification:${n.id}`,
      JSON.stringify({ from_notification: n.id, zone_id: n.geofence_id, band: n.band, score: n.score }),
      ctx.user.id,
    ]
  );
  const missionId = m.rows[0].id;
  await query('UPDATE notifications SET mission_id = $1 WHERE id = $2 AND team_id = $3', [missionId, id, ctx.teamId]);
  await audit(ctx, 'notification.convert_mission', 'mission', missionId, { notificationId: id });
  return sendJSON(res, 201, { ok: true, id, missionId });
}

// Job-safe evaluation pass: score enabled zones, persist snapshots, then match
// enabled policies and create deduplicated notification events. Idempotent
// within a policy+zone+band time window (UNIQUE (team_id, dedupe_key)).
async function evaluate(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const now = Date.now();
  const events = await fetchLiveEvents(req);
  const scenario = await latestScenario(ctx);

  const { rows: zones } = await query('SELECT * FROM geofences WHERE team_id = $1 AND enabled = TRUE', [ctx.teamId]);
  const scored = [];
  for (const zone of zones) {
    const snap = await scoreAndPersist(ctx, zone, { events, scenario, now });
    scored.push({ zone, snap });
  }

  const { rows: policies } = await query('SELECT * FROM alert_policies WHERE team_id = $1 AND enabled = TRUE', [ctx.teamId]);

  let created = 0;
  let suppressed = 0;
  for (const policy of policies) {
    for (const { zone, snap } of scored) {
      const lastRes = await query(
        `SELECT created_at FROM notifications
          WHERE team_id = $1 AND policy_id = $2 AND geofence_id = $3
          ORDER BY created_at DESC LIMIT 1`,
        [ctx.teamId, policy.id, zone.id]
      );
      const lastNotifiedAt = lastRes.rows[0] ? lastRes.rows[0].created_at : null;
      const decision = shouldNotify(policy, snap, { zoneId: zone.id, lastNotifiedAt, now });
      if (!decision.notify) { if (decision.reason !== 'no_match') suppressed += 1; continue; }

      const dedupeKey = notificationDedupeKey({ policyId: policy.id, zoneId: zone.id, band: snap.band, now });
      const hasChannel = policy.escalation_target ? 'pending' : 'skipped';
      const payload = {
        zone: { id: zone.id, name: zone.name },
        dimensions: snap.dimensions,
        provenance: snap.provenance,
        evidence: snap.evidence,
        assumptions: snap.assumptions,
        confidence: snap.confidence,
        stale: snap.stale,
        deepLink: `/#watch?zone=${zone.id}`,
      };
      const { rowCount } = await query(
        `INSERT INTO notifications
           (team_id, policy_id, geofence_id, dedupe_key, title, body, band, score, payload, delivery_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (team_id, dedupe_key) DO NOTHING`,
        [
          ctx.teamId, policy.id, zone.id, dedupeKey,
          `${zone.name}: ${snap.band} watch (${snap.score}/100)`,
          snap.explanation, snap.band, snap.score, JSON.stringify(payload), hasChannel,
        ]
      );
      created += rowCount;
    }
  }

  await audit(ctx, 'notification.evaluate', 'notification', null, { zones: zones.length, policies: policies.length, created, suppressed });
  const payload = await inboxPayload(ctx);
  return sendJSON(res, 200, { ok: true, scoredZones: zones.length, policies: policies.length, created, suppressed, ...payload });
}
