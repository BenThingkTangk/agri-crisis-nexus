// War Room collaboration — server-backed presence + messages. Honest
// near-real-time: the client polls this endpoint and labels the last sync time;
// presence freshness is DERIVED from each member's last heartbeat (never faked).
//
//   GET  /api/collab?action=state                 -> roster + presence + recent messages + serverTime
//   POST /api/collab?action=heartbeat  { focus? }  -> upsert my presence, return state
//   POST /api/collab?action=message    { body, refType?, refId? } -> post a message (+@mentions)
//   POST /api/collab?action=system     { body, refType?, refId? } -> post a system event (assignment/approval)
//
// All rows are tenant-scoped to the caller's active team.

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { str, optionalUuid, oneOf, ValidationError } from './_validate.js';
import { presenceFreshness, parseMentions } from './_intel.js';

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'state';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'state') return await state(req, res, ctx);
    if (action === 'heartbeat') return await heartbeat(req, res, ctx);
    if (action === 'message') return await postMessage(req, res, ctx, 'message');
    if (action === 'system') return await postMessage(req, res, ctx, 'system');
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[collab] server_error', err && (err.code || err.message));
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
    console.error('[collab] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

async function roster(ctx) {
  const { rows } = await query(
    `SELECT u.id, u.display_name, tm.role FROM team_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 ORDER BY u.display_name`,
    [ctx.teamId]
  );
  return rows;
}

// Build the full War Room state. Presence status is recomputed from last_seen_at
// so a member who stopped heartbeating decays online -> away -> offline honestly.
async function buildState(ctx) {
  const now = Date.now();
  const [members, presence, messages] = await Promise.all([
    roster(ctx),
    query(`SELECT user_id, focus, last_seen_at FROM room_presence WHERE team_id = $1`, [ctx.teamId]),
    query(
      `SELECT m.id, m.user_id, m.body, m.mentions, m.kind, m.ref_type, m.ref_id, m.created_at,
              u.display_name AS user_name
         FROM room_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.team_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
      [ctx.teamId]
    ),
  ]);
  const presenceById = {};
  for (const p of presence.rows) presenceById[p.user_id] = p;
  const members2 = members.map((mem) => {
    const p = presenceById[mem.id];
    const fresh = presenceFreshness(p && p.last_seen_at, now);
    return {
      id: mem.id, name: mem.display_name, role: mem.role,
      presence: fresh.status, focus: (p && p.focus) || null,
      lastSeenAt: (p && p.last_seen_at) || null,
      isMe: mem.id === ctx.user.id,
    };
  });
  return {
    members: members2,
    online: members2.filter((m) => m.presence === 'online').length,
    messages: messages.rows.reverse(),
    serverTime: new Date(now).toISOString(),
  };
}

async function state(req, res, ctx) {
  return sendJSON(res, 200, { ok: true, ...(await buildState(ctx)) });
}

async function heartbeat(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'viewer')) return;
  const body = await readJSON(req);
  const focus = str(body.focus, 'focus', { required: false, max: 120 });
  await query(
    `INSERT INTO room_presence (team_id, user_id, status, focus, last_seen_at)
     VALUES ($1,$2,'online',$3, now())
     ON CONFLICT (team_id, user_id)
     DO UPDATE SET status = 'online', focus = EXCLUDED.focus, last_seen_at = now()`,
    [ctx.teamId, ctx.user.id, focus]
  );
  return sendJSON(res, 200, { ok: true, ...(await buildState(ctx)) });
}

async function postMessage(req, res, ctx, kind) {
  if (!requireWrite(req, res, ctx, kind === 'system' ? 'analyst' : 'viewer')) return;
  const body = await readJSON(req);
  const text = str(body.body, 'body', { min: 1, max: 4000 });
  const refType = body.refType ? oneOf(body.refType, ['alert', 'mission', 'scenario'], 'refType') : null;
  const refId = optionalUuid(body.refId, 'refId');
  const mentions = parseMentions(text, (await roster(ctx)).map((m) => ({ id: m.id, display_name: m.display_name })));
  const { rows } = await query(
    `INSERT INTO room_messages (team_id, user_id, body, mentions, kind, ref_type, ref_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [ctx.teamId, ctx.user.id, text, mentions, kind, refType, refId]
  );
  // Refresh my presence as a side effect of activity.
  await query(
    `INSERT INTO room_presence (team_id, user_id, status, last_seen_at) VALUES ($1,$2,'online',now())
     ON CONFLICT (team_id, user_id) DO UPDATE SET status='online', last_seen_at=now()`,
    [ctx.teamId, ctx.user.id]
  );
  await audit(ctx, 'collab.message', 'room_message', rows[0].id, { kind, mentions: mentions.length });
  return sendJSON(res, 201, { ok: true, id: rows[0].id, mentions, ...(await buildState(ctx)) });
}
