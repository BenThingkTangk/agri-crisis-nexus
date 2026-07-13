// Geofenced breadbasket early-warning zones (Phase IV).
//
//   GET  /api/geofences?action=list                 -> zones + latest snapshot each
//   GET  /api/geofences?action=get&id=...           -> one zone + latest snapshot + history
//   GET  /api/geofences?action=history&id=...       -> snapshot history for a zone
//   GET  /api/geofences?action=compare&ids=a,b,c    -> latest snapshot for up to 3 zones
//   GET  /api/geofences?action=catalog              -> the product-defined starter catalog
//   POST /api/geofences?action=create   (analyst+)  -> create a custom zone (validated geometry)
//   POST /api/geofences?action=update   (analyst+)  -> edit a zone
//   POST /api/geofences?action=toggle   (analyst+)  -> enable/disable
//   POST /api/geofences?action=delete   (analyst+)  -> delete a zone
//   POST /api/geofences?action=seed-catalog (analyst+) -> upsert the starter catalog
//   POST /api/geofences?action=snapshot (analyst+)  -> score one/all zones and persist a snapshot
//
// Scoring is derived ONLY from existing normalized live signals (/api/live,
// attributed to a zone by geometry) plus modeled scenario state and analyst
// inputs. OBSERVED / MODELED / ANALYST provenance is kept separate. Snapshots
// are persisted so trend/history is real, never fabricated.

import { query } from './_db.js';
import { ensureSchema } from './_bootstrap.js';
import { readJSON, sendJSON, sendError } from './_http.js';
import { requireAnyAuth, requireWrite, audit } from './_auth.js';
import { str, uuid, strArray, jsonObject, ValidationError } from './_validate.js';
import {
  validateGeometry, scoreZone, catalogSeedRows, WATCH_CATALOG, CATALOG_DISCLAIMER, GEOFENCE_LIMITS,
} from './_intel.js';

const MAX_CUSTOM_ZONES = 100;

export default async function handler(req, res) {
  if (!(await ensureReady(res))) return;
  const action = (req.query && req.query.action) || 'list';
  const ctx = await requireAnyAuth(req, res);
  if (!ctx) return;
  if (!ctx.teamId) return sendError(res, 403, 'no_team', 'No active team.');
  try {
    if (action === 'list') return await listZones(req, res, ctx);
    if (action === 'get') return await getZone(req, res, ctx);
    if (action === 'history') return await history(req, res, ctx);
    if (action === 'compare') return await compare(req, res, ctx);
    if (action === 'catalog') return await catalog(req, res, ctx);
    if (action === 'create') return await createZone(req, res, ctx);
    if (action === 'update') return await updateZone(req, res, ctx);
    if (action === 'toggle') return await toggleZone(req, res, ctx);
    if (action === 'delete') return await deleteZone(req, res, ctx);
    if (action === 'seed-catalog') return await seedCatalog(req, res, ctx);
    if (action === 'snapshot') return await snapshot(req, res, ctx);
    return sendError(res, 404, 'unknown_action');
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, 400, 'invalid', err.message);
    console.error('[geofences] server_error', err && (err.code || err.message));
    return sendError(res, 500, 'server_error', 'Something went wrong.');
  }
}

async function ensureReady(res) {
  try {
    await ensureSchema();
    return true;
  } catch (err) {
    console.error('[geofences] schema_bootstrap_failed', err && (err.code || err.message));
    sendError(res, 500, 'server_error', 'Service is starting up. Please retry.');
    return false;
  }
}

// Zones with their latest persisted snapshot (LEFT JOIN LATERAL so zones with no
// snapshot yet still list, with null score fields).
async function listZones(req, res, ctx) {
  const { rows } = await query(
    `SELECT g.id, g.slug, g.name, g.kind, g.source, g.geometry, g.crops, g.threats,
            g.region, g.notes, g.enabled, g.metadata, g.created_at, g.updated_at,
            s.score, s.band, s.trend, s.delta, s.dimensions, s.confidence,
            s.freshness_hours, s.stale, s.created_at AS scored_at
       FROM geofences g
       LEFT JOIN LATERAL (
         SELECT * FROM zone_scores z WHERE z.geofence_id = g.id ORDER BY z.created_at DESC LIMIT 1
       ) s ON TRUE
      WHERE g.team_id = $1
      ORDER BY g.enabled DESC, s.score DESC NULLS LAST, g.name ASC`,
    [ctx.teamId]
  );
  return sendJSON(res, 200, { ok: true, zones: rows, disclaimer: CATALOG_DISCLAIMER, limits: GEOFENCE_LIMITS });
}

async function zoneRow(ctx, id) {
  const { rows } = await query('SELECT * FROM geofences WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  return rows[0] || null;
}

async function getZone(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const zone = await zoneRow(ctx, id);
  if (!zone) return sendError(res, 404, 'not_found', 'Zone not found.');
  const { rows: snaps } = await query(
    `SELECT id, score, band, trend, delta, dimensions, provenance, evidence,
            assumptions, confidence, freshness_hours, stale, explanation, created_at
       FROM zone_scores WHERE geofence_id = $1 ORDER BY created_at DESC LIMIT 30`,
    [id]
  );
  return sendJSON(res, 200, { ok: true, zone, latest: snaps[0] || null, history: snaps });
}

async function history(req, res, ctx) {
  const id = uuid((req.query && req.query.id) || '', 'id');
  const zone = await zoneRow(ctx, id);
  if (!zone) return sendError(res, 404, 'not_found', 'Zone not found.');
  const { rows } = await query(
    `SELECT score, band, trend, delta, confidence, stale, created_at
       FROM zone_scores WHERE geofence_id = $1 ORDER BY created_at DESC LIMIT 90`,
    [id]
  );
  return sendJSON(res, 200, { ok: true, history: rows });
}

// Compare up to 3 zones (latest snapshot each). Guards the team scope and count.
async function compare(req, res, ctx) {
  const raw = String((req.query && req.query.ids) || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return sendError(res, 400, 'invalid', 'Provide 1-3 zone ids.');
  if (raw.length > 3) return sendError(res, 400, 'invalid', 'Compare at most 3 zones.');
  const ids = raw.map((v) => uuid(v, 'ids'));
  const { rows } = await query(
    `SELECT g.id, g.name, g.kind, g.region,
            s.score, s.band, s.trend, s.delta, s.dimensions, s.confidence, s.stale, s.created_at AS scored_at
       FROM geofences g
       LEFT JOIN LATERAL (
         SELECT * FROM zone_scores z WHERE z.geofence_id = g.id ORDER BY z.created_at DESC LIMIT 1
       ) s ON TRUE
      WHERE g.team_id = $1 AND g.id = ANY($2::uuid[])`,
    [ctx.teamId, ids]
  );
  return sendJSON(res, 200, { ok: true, zones: rows });
}

async function catalog(req, res, ctx) {
  return sendJSON(res, 200, { ok: true, catalog: WATCH_CATALOG, disclaimer: CATALOG_DISCLAIMER });
}

// Parse + validate the shared zone fields from a request body.
function parseZoneInput(body) {
  const name = str(body.name, 'name', { min: 2, max: 120 });
  const kind = body.kind ? str(body.kind, 'kind', { max: 40 }) : 'custom';
  const crops = strArray(body.crops, 'crops', { max: 20 });
  const threats = strArray(body.threats, 'threats', { max: 8 });
  const region = body.region ? str(body.region, 'region', { required: false, max: 120 }) : null;
  const notes = body.notes ? str(body.notes, 'notes', { required: false, max: 2000 }) : '';
  const geoInput = jsonObject(body.geometry, 'geometry');
  const g = validateGeometry(geoInput);
  if (!g.ok) throw new ValidationError(`geometry invalid (${g.error})`);
  return { name, kind, crops, threats, region, notes, geometry: g.geometry };
}

async function createZone(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const input = parseZoneInput(body);

  const countRes = await query(
    `SELECT COUNT(*)::int AS n FROM geofences WHERE team_id = $1 AND source = 'custom'`,
    [ctx.teamId]
  );
  if (countRes.rows[0].n >= MAX_CUSTOM_ZONES) {
    return sendError(res, 400, 'limit', `Zone limit reached (${MAX_CUSTOM_ZONES}).`);
  }

  const slug = customSlug(input.name, ctx.teamId);
  const analystInputs = parseAnalystInputs(body.analystInputs);
  const { rows } = await query(
    `INSERT INTO geofences (team_id, slug, name, kind, source, geometry, crops, threats, region, notes, enabled, metadata, created_by)
     VALUES ($1,$2,$3,$4,'custom',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      ctx.teamId, slug, input.name, input.kind, JSON.stringify(input.geometry),
      input.crops, input.threats, input.region, input.notes,
      body.enabled !== false, JSON.stringify({ analystInputs }), ctx.user.id,
    ]
  );
  await audit(ctx, 'geofence.create', 'geofence', rows[0].id, { name: input.name });
  return sendJSON(res, 201, { ok: true, id: rows[0].id });
}

async function updateZone(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const zone = await zoneRow(ctx, id);
  if (!zone) return sendError(res, 404, 'not_found', 'Zone not found.');
  const input = parseZoneInput(body);
  const analystInputs = parseAnalystInputs(body.analystInputs);
  const metadata = { ...(zone.metadata || {}), analystInputs };
  await query(
    `UPDATE geofences SET name=$1, kind=$2, geometry=$3, crops=$4, threats=$5, region=$6, notes=$7, metadata=$8
      WHERE id=$9 AND team_id=$10`,
    [
      input.name, input.kind, JSON.stringify(input.geometry), input.crops, input.threats,
      input.region, input.notes, JSON.stringify(metadata), id, ctx.teamId,
    ]
  );
  await audit(ctx, 'geofence.update', 'geofence', id);
  return sendJSON(res, 200, { ok: true, id });
}

async function toggleZone(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const enabled = body.enabled !== false;
  const { rowCount } = await query(
    'UPDATE geofences SET enabled = $1 WHERE id = $2 AND team_id = $3',
    [enabled, id, ctx.teamId]
  );
  if (!rowCount) return sendError(res, 404, 'not_found', 'Zone not found.');
  await audit(ctx, 'geofence.toggle', 'geofence', id, { enabled });
  return sendJSON(res, 200, { ok: true, id, enabled });
}

async function deleteZone(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const id = uuid(body.id, 'id');
  const { rowCount } = await query('DELETE FROM geofences WHERE id = $1 AND team_id = $2', [id, ctx.teamId]);
  if (!rowCount) return sendError(res, 404, 'not_found', 'Zone not found.');
  await audit(ctx, 'geofence.delete', 'geofence', id);
  return sendJSON(res, 200, { ok: true, deleted: true });
}

// Upsert the product-defined starter catalog for this team. Idempotent
// (ON CONFLICT (team_id, slug) DO NOTHING) — never overwrites an edited zone.
async function seedCatalog(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  let inserted = 0;
  for (const z of catalogSeedRows()) {
    const { rowCount } = await query(
      `INSERT INTO geofences (team_id, slug, name, kind, source, geometry, crops, threats, region, notes, enabled, metadata, created_by)
       VALUES ($1,$2,$3,$4,'catalog',$5,$6,$7,$8,'',TRUE,$9,$10)
       ON CONFLICT (team_id, slug) DO NOTHING`,
      [
        ctx.teamId, z.slug, z.name, z.kind, JSON.stringify(z.geometry),
        z.crops, z.threats, z.region, JSON.stringify(z.metadata), ctx.user.id,
      ]
    );
    inserted += rowCount;
  }
  await audit(ctx, 'geofence.seed_catalog', 'geofence', null, { inserted });
  return sendJSON(res, 200, { ok: true, inserted });
}

// Score one zone (id) or all enabled zones and persist a snapshot each.
async function snapshot(req, res, ctx) {
  if (!requireWrite(req, res, ctx, 'analyst')) return;
  const body = await readJSON(req);
  const only = body.id ? uuid(body.id, 'id') : null;
  const events = await fetchLiveEvents(req);
  const scenario = await latestScenario(ctx);
  const { rows: zones } = only
    ? await query('SELECT * FROM geofences WHERE id = $1 AND team_id = $2', [only, ctx.teamId])
    : await query('SELECT * FROM geofences WHERE team_id = $1 AND enabled = TRUE', [ctx.teamId]);
  if (only && !zones.length) return sendError(res, 404, 'not_found', 'Zone not found.');

  const now = Date.now();
  const results = [];
  for (const zone of zones) {
    const snap = await scoreAndPersist(ctx, zone, { events, scenario, now });
    results.push({ zoneId: zone.id, name: zone.name, score: snap.score, band: snap.band, trend: snap.trend, stale: snap.stale });
  }
  await audit(ctx, 'geofence.snapshot', 'geofence', only, { count: results.length });
  return sendJSON(res, 200, { ok: true, scored: results.length, results });
}

// ---- shared scoring helpers (also used by the evaluation pass) -------------

// Fetch normalized live events from the existing keyless feed (same source as
// alerts). Never fabricates data — returns [] if unreachable.
export async function fetchLiveEvents(req) {
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

// Most recent saved scenario for the team, mapped to a MODELED input.
export async function latestScenario(ctx) {
  const { rows } = await query(
    `SELECT threat, params FROM scenarios WHERE team_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [ctx.teamId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const params = r.params || {};
  const intensity = Number(params.intensity != null ? params.intensity : params.severity) || 0;
  return { threat: r.threat, intensity };
}

// Score a zone against inputs and persist the snapshot (with trend vs previous).
export async function scoreAndPersist(ctx, zone, { events, scenario, now = Date.now() }) {
  const prevRes = await query(
    'SELECT score FROM zone_scores WHERE geofence_id = $1 ORDER BY created_at DESC LIMIT 1',
    [zone.id]
  );
  const previous = prevRes.rows[0] || null;
  const analystInputs = (zone.metadata && Array.isArray(zone.metadata.analystInputs)) ? zone.metadata.analystInputs : [];
  const snap = scoreZone(zone, { events, scenario, analystInputs, now, previous });
  await query(
    `INSERT INTO zone_scores
       (team_id, geofence_id, score, band, trend, delta, dimensions, provenance, evidence,
        assumptions, confidence, freshness_hours, stale, explanation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      ctx.teamId, zone.id, snap.score, snap.band, snap.trend, snap.delta,
      JSON.stringify(snap.dimensions), JSON.stringify(snap.provenance), JSON.stringify(snap.evidence),
      JSON.stringify(snap.assumptions), snap.confidence, snap.freshnessHours, snap.stale, snap.explanation,
    ]
  );
  return snap;
}

// ---- small helpers ---------------------------------------------------------
function customSlug(name, teamId) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || 'zone'}-${suffix}`;
}

function parseAnalystInputs(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((a) => ({
    dimension: typeof a?.dimension === 'string' ? a.dimension.slice(0, 40) : null,
    score: Math.max(0, Math.min(100, Number(a?.score) || 0)),
    note: typeof a?.note === 'string' ? a.note.slice(0, 200) : '',
  }));
}
