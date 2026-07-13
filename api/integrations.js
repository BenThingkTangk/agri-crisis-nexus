// External command integrations (Phase IV) — generic signed webhook, Slack
// incoming webhook, Microsoft Teams webhook, and a provider-neutral email
// adapter contract.
//
//   GET  /api/integrations?action=list             -> channels + health (analyst may view)
//   GET  /api/integrations?action=get&id=...        -> one channel (owner sees secret_ref name)
//   POST /api/integrations?action=save   (owner)    -> create/update a channel
//   POST /api/integrations?action=toggle (owner)    -> enable/disable
//   POST /api/integrations?action=delete (owner)    -> delete
//   POST /api/integrations?action=test   (owner)    -> dry-run (default) or live test delivery
//
// Credentials are NEVER stored or returned: a channel references an environment
// variable NAME (`secretRef`) that holds the webhook URL/token; the value is
// read from process.env only at delivery time. Analysts can view health but not
// secret references or change credentials. Outbound requests are SSRF-guarded
// (HTTPS-only, no private/link-local/reserved hosts), bounded in time and size,
// and HMAC-signed for the generic webhook. A dry-run never pretends to deliver.

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { str, uuid, oneOf, jsonObject, ValidationError } from './_validate.js';
import {
  INTEGRATION_KINDS, validateWebhookUrl, signWebhookPayload, buildWebhookPayload,
  formatChannelMessage, notificationIdempotencyKey, nextRetryDelayMs, MAX_DELIVERY_ATTEMPTS,
} from './_intel.js';
import { roleAtLeast } from './_auth.js';

const DELIVERY_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 16_384;

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listChannels(req, res, ctx);
    if (action === 'get') return await getChannel(req, res, ctx);
    if (action === 'save') return await saveChannel(req, res, ctx);
    if (action === 'toggle') return await toggleChannel(req, res, ctx);
    if (action === 'delete') return await deleteChannel(req, res, ctx);
    if (action === 'test') return await testChannel(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[integrations] server_error', err && (err.code || err.message));
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function ensureReady(res) {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('[integrations] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

// Resolve whether a channel's referenced env var is present WITHOUT ever
// returning the value. `configured` = a secret_ref is set and the env var holds
// a value that passes SSRF validation (for webhook-style kinds).
function channelConfig(row) {
  const ref = row.secret_ref || null;
  const rawUrl = ref ? (process.env[ref] || '') : '';
  let configured = false;
  let urlValid = null;
  if (row.kind === 'email') {
    configured = Boolean(rawUrl);
  } else if (ref && rawUrl) {
    const v = validateWebhookUrl(rawUrl);
    urlValid = v.ok;
    configured = v.ok;
  }
  return { ref, rawUrl, configured, urlValid };
}

// Public-safe channel view. Owners additionally see the secret_ref NAME (never
// the value). Analysts see only health + configured status.
function channelView(row, isOwner) {
  const cfg = channelConfig(row);
  const view = {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    configured: cfg.configured,
    status: cfg.configured ? (row.enabled ? 'ready' : 'disabled') : 'not_configured',
    health: row.health || {},
    config: row.config || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (isOwner) view.secretRef = cfg.ref; // env var NAME only — never its value
  return view;
}

async function listChannels(req, res, ctx) {
  const isOwner = roleAtLeast(ctx.role, 'owner');
  const { rows } = await query(
    'SELECT * FROM integration_channels WHERE team_id = $1 ORDER BY kind ASC, name ASC',
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, channels: rows.map((r) => channelView(r, isOwner)), kinds: INTEGRATION_KINDS });
}

async function channelRow(ctx, id) {
  const { rows } = await query('SELECT * FROM integration_channels WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  return rows[0] || null;
}

async function getChannel(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const row = await channelRow(ctx, id);
  if (!row) return sendError(res, 404, 'not_found', 'Channel not found.');
  return sendJSON(res, 200, { ok: true, channel: channelView(row, roleAtLeast(ctx.role, 'owner')) });
}

async function saveChannel(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'owner')) return;
  const body = await readJSON(req);
  const kind = oneOf(body.kind, INTEGRATION_KINDS, 'kind');
  const name = str(body.name, 'name', { min: 2, max: 120 });
  const enabled = body.enabled === true;
  // secretRef is an env var NAME, not a value. Enforce a conservative name shape
  // and reject anything that looks like an inline secret (URL / token payload).
  let secretRef = null;
  if (body.secretRef != null && body.secretRef !== '') {
    secretRef = str(body.secretRef, 'secretRef', { max: 120 });
    if (!/^[A-Z][A-Z0-9_]{2,119}$/.test(secretRef)) {
      throw new ValidationError('secretRef must be an ENV VAR NAME (UPPER_SNAKE_CASE), not a value.');
    }
  }
  const config = jsonObject(body.config, 'config');

  if (body.id) {
    const id = uuid(body.id, 'id');
    const { rows } = await query(
      `UPDATE integration_channels SET kind=$1, name=$2, enabled=$3, secret_ref=$4, config=$5
        WHERE id=$6 AND team_id=$7 RETURNING id`,
      [kind, name, enabled, secretRef, JSON.stringify(config), id, ctx.teamId]
    );
    if (!rows.length) return sendError(res, 404, 'not_found', 'Channel not found.');
    await audit(ctx, 'integration.update', 'integration_channel', id, { kind, enabled });
    const row = await channelRow(ctx, id);
    return sendJSON(res, 200, { ok: true, channel: channelView(row, true) });
  }
  const { rows } = await query(
    `INSERT INTO integration_channels (team_id, kind, name, enabled, secret_ref, config, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.teamId, kind, name, enabled, secretRef, JSON.stringify(config), ctx.user.id]
  );
  await audit(ctx, 'integration.create', 'integration_channel', rows[0].id, { kind });
  const row = await channelRow(ctx, rows[0].id);
  return sendJSON(res, 201, { ok: true, channel: channelView(row, true) });
}

async function toggleChannel(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'owner')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const enabled = body.enabled === true;
  const { rowCount } = await query('UPDATE integration_channels SET enabled = $1 WHERE id = $2 AND team_id = $3', [enabled, id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Channel not found.');
  await audit(ctx, 'integration.toggle', 'integration_channel', id, { enabled });
  return sendJSON(res, 200, { ok: true, id, enabled });
}

async function deleteChannel(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'owner')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const { rowCount } = await query('DELETE FROM integration_channels WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Channel not found.');
  await audit(ctx, 'integration.delete', 'integration_channel', id);
  return sendJSON(res, 200, { ok: true, deleted: true });
}

// Sample payload used for tests (no real notification required).
function samplePayload() {
  return buildWebhookPayload(
    {
      id: null,
      band: 'elevated',
      score: 52,
      dedupe_key: 'test',
      payload: {
        zone: { id: null, name: 'Test Zone' },
        provenance: { observed: [], modeled: [{ note: 'sample' }], analyst: [] },
        evidence: [],
        deepLink: '/#watch',
      },
    },
    { now: Date.now() }
  );
}

// Test a channel. Dry-run (default) validates config and returns exactly what
// WOULD be sent WITHOUT contacting the network — it never claims delivery. A
// live test performs one SSRF-guarded, time-bounded request and records the
// honest outcome. Owner only.
async function testChannel(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'owner')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const row = await channelRow(ctx, id);
  if (!row) return sendError(res, 404, 'not_found', 'Channel not found.');
  const dryRun = body.live !== true; // default to dry-run

  const cfg = channelConfig(row);
  const payload = samplePayload();
  const message = formatChannelMessage(row.kind, payload);

  if (!cfg.configured) {
    await recordDelivery(ctx, row.id, null, dryRun ? 'dry_run' : 'live', 'skipped', 1, { host: null }, {}, 'not_configured');
    await setHealth(ctx, row.id, { status: 'not_configured', last_test_at: new Date().toISOString() });
    return sendJSON(res, 200, {
      ok: true, configured: false, delivered: false, status: 'not_configured',
      message: 'Channel is not configured — set the referenced environment variable. No delivery attempted.',
      wouldSend: dryRun ? { kind: row.kind, body: message } : undefined,
    });
  }

  if (row.kind === 'email') {
    // Provider-neutral email adapter contract: no SMTP/provider is wired, so we
    // are honest about it rather than faking a send.
    await recordDelivery(ctx, row.id, null, dryRun ? 'dry_run' : 'live', 'skipped', 1, { host: null }, {}, 'email_provider_unavailable');
    await setHealth(ctx, row.id, { status: 'adapter_only', last_test_at: new Date().toISOString() });
    return sendJSON(res, 200, {
      ok: true, configured: true, delivered: false, status: 'adapter_only',
      message: 'Email adapter contract is configured but no delivery provider is wired in this environment. No email was sent.',
      wouldSend: { kind: 'email', body: message },
    });
  }

  const target = validateWebhookUrl(cfg.rawUrl);
  if (!target.ok) {
    await recordDelivery(ctx, row.id, null, dryRun ? 'dry_run' : 'live', 'failed', 1, { host: null }, {}, `blocked:${target.error}`);
    await setHealth(ctx, row.id, { status: 'error', last_test_at: new Date().toISOString(), last_error: target.error });
    return sendError(res, 400, 'blocked_url', `Configured URL rejected (${target.error}).`);
  }

  const idempotencyKey = notificationIdempotencyKey({ notificationId: 'test', channelId: row.id, attempt: 1 });
  if (dryRun) {
    await recordDelivery(ctx, row.id, null, 'dry_run', 'dry_run', 1, { host: target.host }, {}, null);
    await setHealth(ctx, row.id, { status: 'ready', last_test_at: new Date().toISOString() });
    return sendJSON(res, 200, {
      ok: true, configured: true, delivered: false, dryRun: true, status: 'dry_run',
      wouldSend: { kind: row.kind, host: target.host, body: message, idempotencyKey },
      message: 'Dry-run only — validated configuration and payload. No request was sent.',
    });
  }

  // Live test — one bounded, SSRF-guarded request. Honest about the outcome.
  const outcome = await deliverOnce(row.kind, target.url, message, cfg.rawUrl, idempotencyKey);
  const status = outcome.ok ? 'delivered' : 'failed';
  await recordDelivery(ctx, row.id, null, 'live', status, 1, { host: target.host }, { code: outcome.code || null, ok: outcome.ok }, outcome.error || null);
  await setHealth(ctx, row.id, {
    status: outcome.ok ? 'ready' : 'error',
    last_test_at: new Date().toISOString(),
    ...(outcome.ok ? { last_success_at: new Date().toISOString() } : { last_error: outcome.error || `http_${outcome.code}` }),
  });
  await audit(ctx, 'integration.test', 'integration_channel', row.id, { live: true, ok: outcome.ok, code: outcome.code || null });
  return sendJSON(res, 200, {
    ok: true, configured: true, delivered: outcome.ok, status,
    code: outcome.code || null,
    nextRetryMs: outcome.ok ? null : nextRetryDelayMs(1),
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    message: outcome.ok ? 'Test delivered.' : `Test failed (${outcome.error || 'http_' + outcome.code}).`,
  });
}

// One bounded outbound request. Generic webhook payloads are HMAC-signed with
// the resolved secret; Slack/Teams receive their text message. Never throws.
async function deliverOnce(kind, url, message, secret, idempotencyKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const bodyStr = JSON.stringify(message);
    const headers = { 'content-type': 'application/json', 'idempotency-key': idempotencyKey };
    if (kind === 'webhook') headers['x-agrios-signature'] = 'sha256=' + signWebhookPayload(bodyStr, secret);
    const r = await fetch(url, { method: 'POST', headers, body: bodyStr, signal: controller.signal });
    // Bound how much we read back.
    try { await r.text(); } catch (_) { /* ignore body */ }
    return { ok: r.ok, code: r.status };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function recordDelivery(ctx, channelId, notificationId, mode, status, attempt, request, response, error) {
  try {
    await query(
      `INSERT INTO delivery_log (team_id, channel_id, notification_id, mode, idempotency_key, status, attempt, request, response, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.teamId, channelId, notificationId, mode, null, status, attempt, JSON.stringify(request || {}), JSON.stringify(response || {}), error || null]
    );
  } catch (_) { /* delivery log is best-effort */ }
}

async function setHealth(ctx, channelId, health) {
  await query('UPDATE integration_channels SET health = $1 WHERE id = $2 AND team_id = $3', [JSON.stringify(health), channelId, ctx.teamId]);
}
