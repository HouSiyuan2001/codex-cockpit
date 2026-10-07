import { dailyPlan } from "./daily-plan.js";
import { validAggregates, validFeedback } from "./snapshot-schema.js";
import { readBody } from "./request-body.js";
const MAX_MEMBERS = 32;
const ALLOWED_PAYLOAD_KEYS = new Set([
  "_cockpit", "_device", "_ledger", "_range_bounds", "_ts", "codex",
  "comfortFeedback", "comfortFeedbackVersion", "taskUsage",
]);

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function fail(code, status = 400) {
  return response({ ok: false, error: code }, status);
}

export function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    && value !== "." && value !== ".." && !value.endsWith(".");
}

export function validGroups(value) {
  if (!value || !Array.isArray(value.groups) || value.groups.length > 32) return false;
  const ids = new Set(), names = new Set(), devices = new Set();
  for (const group of value.groups) {
    if (!safeId(group.id) || !safeName(group.name) || ids.has(group.id) || names.has(group.name) || !Array.isArray(group.deviceIds) || group.deviceIds.length > 128) return false;
    ids.add(group.id); names.add(group.name);
    for (const id of group.deviceIds) { if (!safeId(id) || devices.has(id)) return false; devices.add(id); }
  }
  return value.defaultGroupId === null || ids.has(value.defaultGroupId);
}

function safeName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64
    && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
}

export function cleanSharedSettings(value) {
  if (!value || value.schemaVersion !== 2 || !validGroups(value.groups)) return null;
  const pricing = value.pricing;
  if (!pricing || typeof pricing.models !== "object" || Array.isArray(pricing.models)) return null;
  const entries = Object.entries(pricing.models || {});
  const modelId = id => typeof id === "string" && /^[A-Za-z0-9~][A-Za-z0-9/~_.:+-]{0,255}$/.test(id);
  if (!entries.length || entries.length > 2048) return null;
  const models = Object.create(null), aliases = Object.create(null);
  for (const [id, rate] of entries) {
    if (!modelId(id) || !rate || ![rate.in, rate.out, rate.cache_read].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1e6)) return null;
    if (rate.canonical_slug !== undefined && !modelId(rate.canonical_slug)) return null;
    models[id] = { in: rate.in, out: rate.out, cache_read: rate.cache_read, ...(rate.canonical_slug ? { canonical_slug: rate.canonical_slug } : {}) };
  }
  if (Object.keys(pricing.aliases || {}).length > 4096) return null;
  for (const [id, target] of Object.entries(pricing.aliases || {})) {
    if (!modelId(id) || !modelId(target)) return null;
    aliases[id] = target;
  }
  return { schemaVersion: 2, groups: { groups: value.groups.groups.map(g => ({ id: g.id, name: g.name, deviceIds: g.deviceIds })), defaultGroupId: value.groups.defaultGroupId }, pricing: { models, aliases }, costPolicy: "event-context-v1" };
}

async function sharedSettings(env, spaceId) {
  const row = await env.DB.prepare("SELECT shared_settings, settings_revision FROM spaces WHERE id = ?").bind(spaceId).first();
  return { revision: row.settings_revision, value: row.shared_settings ? JSON.parse(row.shared_settings) : null };
}

async function updateSettings(request, env, member) {
  if (member.role !== "owner") return fail("forbidden", 403);
  const body = await readBody(request);
  const clean = cleanSharedSettings(body.value);
  if (!clean || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) return fail("settings_invalid");
  const result = await env.DB.prepare("UPDATE spaces SET shared_settings = ?, group_settings = ?, settings_revision = settings_revision + 1 WHERE id = ? AND settings_revision = ?")
    .bind(JSON.stringify(clean), JSON.stringify(clean.groups), member.space_id, body.expectedRevision).run();
  if (result.meta.changes !== 1) return fail("settings_conflict", 409);
  return response({ ok: true, sharedSettings: await sharedSettings(env, member.space_id) });
}

async function updateGroups(request, env, member) {
  const body = await readBody(request);
  if (!validGroups(body?.groups) || !Number.isSafeInteger(body?.expectedRevision) || body.expectedRevision < 0) return fail("groups_invalid");
  const current = await sharedSettings(env, member.space_id);
  if (!current.value) return fail("settings_unavailable", 409);
  if (current.revision !== body.expectedRevision) return fail("settings_conflict", 409);
  const groups = { groups: body.groups.groups.map(group => ({ id: group.id, name: group.name, deviceIds: group.deviceIds })), defaultGroupId: body.groups.defaultGroupId };
  const value = { ...current.value, groups };
  const result = await env.DB.prepare("UPDATE spaces SET shared_settings = ?, group_settings = ?, settings_revision = settings_revision + 1 WHERE id = ? AND settings_revision = ?")
    .bind(JSON.stringify(value), JSON.stringify(groups), member.space_id, body.expectedRevision).run();
  if (result.meta.changes !== 1) return fail("settings_conflict", 409);
  return response({ ok: true, sharedSettings: await sharedSettings(env, member.space_id) });
}

export function validTaskUsage(value) {
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const fields = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
  const text = v => typeof v === "string" && v.length > 0 && v.length <= 2048 && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
  const counts = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"];
  const metrics = v => counts.every(k => Number.isSafeInteger(v[k]) && v[k] >= 0)
    && (v.estimatedCostUsd === null || typeof v.estimatedCostUsd === "number" && Number.isFinite(v.estimatedCostUsd) && v.estimatedCostUsd >= 0);
  const date = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!fields(value, ["version", "partial", "tasks"]) || value.version !== 1 || typeof value.partial !== "boolean" || !Array.isArray(value.tasks) || value.tasks.length > 4000) return false;
  const ids = new Set();
  return value.tasks.every(task => {
    if (!fields(task, ["id", "name", "relation", "parentId", "rootId", "daily"]) || !safeId(task.id) || ids.has(task.id) || !text(task.name) || !["root", "subagent", "fork", "unlinked"].includes(task.relation)) return false;
    ids.add(task.id);
    if (["parentId", "rootId"].some(k => task[k] !== undefined && !safeId(task[k]))) return false;
    if (!object(task.daily) || Object.keys(task.daily).length > 4096) return false;
    return Object.entries(task.daily).every(([day, v]) => date(day)
      && fields(v, [...counts, "estimatedCostUsd", "models", "start", "end"]) && metrics(v)
      && ["start", "end"].every(k => v[k] == null || date(v[k]))
      && Array.isArray(v.models) && v.models.length <= 256
      && v.models.every(m => fields(m, [...counts, "estimatedCostUsd", "id", "name"]) && text(m.id) && text(m.name) && metrics(m)));
  });
}

export function validateSnapshot(payload, deviceId, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "snapshot_invalid";
  if (Object.keys(payload).some(key => !ALLOWED_PAYLOAD_KEYS.has(key))) return "snapshot_fields_rejected";
  if (payload._device !== deviceId || !safeId(payload._device)) return "snapshot_identity_mismatch";
  if (!Number.isInteger(payload._ts) || payload._ts <= 0 || payload._ts > nowSeconds + 300) return "snapshot_timestamp_invalid";
  if (!validAggregates(payload)) return "snapshot_schema_invalid";
  if (!validFeedback(payload)) return "snapshot_feedback_invalid";
  if (payload.taskUsage !== undefined && !validTaskUsage(payload.taskUsage)) return "snapshot_tasks_invalid";
  return null;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}

async function hash(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

async function memberFor(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!/^ccs_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare("SELECT id, space_id, display_name, device_id, role FROM members WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await hash(token)).first();
}

async function snapshots(env, spaceId) {
  const rows = await env.DB.prepare("SELECT snapshots.device_id, members.display_name, snapshots.payload_json, snapshots.updated_at FROM snapshots JOIN members ON members.space_id = snapshots.space_id AND members.device_id = snapshots.device_id WHERE snapshots.space_id = ? AND members.revoked_at IS NULL ORDER BY members.created_at LIMIT ?")
    .bind(spaceId, MAX_MEMBERS).all();
  return rows.results.map(row => ({
    deviceId: row.device_id,
    displayName: row.display_name,
    updatedAt: row.updated_at,
    payload: JSON.parse(row.payload_json),
  })).filter(row => validateSnapshot(row.payload, row.deviceId) === null);
}

async function createSpace(request, env) {
  if (!env.BOOTSTRAP_SECRET || request.headers.get("x-bootstrap-secret") !== env.BOOTSTRAP_SECRET) return fail("forbidden", 403);
  const body = await readBody(request);
  const name = safeName(body.name);
  const displayName = safeName(body.displayName);
  if (!name || !displayName || !safeId(body.deviceId)) return fail("invalid_space_request");
  const now = Math.floor(Date.now() / 1000);
  const spaceId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const token = `ccs_${randomToken()}`;
  const inviteCode = `CCI-${randomToken(12)}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO spaces(id, name, created_at) VALUES (?, ?, ?)").bind(spaceId, name, now),
    env.DB.prepare("INSERT INTO members(id, space_id, display_name, device_id, role, token_hash, created_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)").bind(memberId, spaceId, displayName, body.deviceId, await hash(token), now),
    env.DB.prepare("INSERT INTO invites(id, space_id, code_hash, expires_at, max_uses, uses, created_by, created_at) VALUES (?, ?, ?, ?, 1, 0, ?, ?)").bind(crypto.randomUUID(), spaceId, await hash(inviteCode), now + 86400, memberId, now),
  ]);
  return response({ ok: true, spaceId, token, inviteCode, inviteExpiresAt: now + 86400 }, 201);
}

async function joinSpace(request, env) {
  const body = await readBody(request);
  const displayName = safeName(body.displayName);
  if (!displayName || !safeId(body.deviceId) || typeof body.inviteCode !== "string") return fail("invalid_join_request");
  const now = Math.floor(Date.now() / 1000);
  const invite = await env.DB.prepare("SELECT id, space_id, expires_at, max_uses, uses FROM invites WHERE code_hash = ? AND revoked_at IS NULL")
    .bind(await hash(body.inviteCode)).first();
  if (!invite || invite.expires_at < now || invite.uses >= invite.max_uses) return fail("invite_invalid", 403);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM members WHERE space_id = ? AND revoked_at IS NULL").bind(invite.space_id).first();
  if (Number(count?.count || 0) >= MAX_MEMBERS) return fail("space_full", 409);
  const token = `ccs_${randomToken()}`;
  try {
    const result = await env.DB.batch([
      env.DB.prepare("UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND expires_at > ? AND (SELECT COUNT(*) FROM members WHERE space_id = ? AND revoked_at IS NULL) < ?").bind(invite.id, now, invite.space_id, MAX_MEMBERS),
      env.DB.prepare("INSERT INTO members(id, space_id, display_name, device_id, role, token_hash, created_at) SELECT ?, ?, ?, ?, 'member', ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), invite.space_id, displayName, body.deviceId, await hash(token), now),
    ]);
    if (result[1].meta.changes !== 1) return fail("invite_invalid", 403);
  } catch { return fail("device_already_joined", 409); }
  return response({ ok: true, spaceId: invite.space_id, token }, 201);
}

async function createInvite(request, env, member) {
  if (member.role !== "owner") return fail("forbidden", 403);
  const body = await readBody(request);
  const maxUses = Number.isInteger(body.maxUses) ? body.maxUses : 1;
  const expiresHours = Number.isInteger(body.expiresHours) ? body.expiresHours : 24;
  if (maxUses < 1 || maxUses > 20 || expiresHours < 1 || expiresHours > 720) return fail("invalid_invite_request");
  const now = Math.floor(Date.now() / 1000);
  const inviteCode = `CCI-${randomToken(12)}`;
  await env.DB.prepare("INSERT INTO invites(id, space_id, code_hash, expires_at, max_uses, uses, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
    .bind(crypto.randomUUID(), member.space_id, await hash(inviteCode), now + expiresHours * 3600, maxUses, member.id, now).run();
  return response({ ok: true, inviteCode, inviteExpiresAt: now + expiresHours * 3600 }, 201);
}

async function sync(request, env, member) {
  const body = await readBody(request);
  if (body.deviceId !== member.device_id) return fail("device_identity_mismatch", 403);
  const error = validateSnapshot(body.payload, member.device_id);
  if (error) return fail(error);
  if (body.groupSettings !== undefined) {
    if (member.role !== "owner") return fail("forbidden", 403);
    if (!validGroups(body.groupSettings)) return fail("groups_invalid");
    const clean = { groups: body.groupSettings.groups.map(group => ({id: group.id, name: group.name, deviceIds: group.deviceIds})), defaultGroupId: body.groupSettings.defaultGroupId };
    await env.DB.prepare("UPDATE spaces SET group_settings = ? WHERE id = ? AND shared_settings IS NULL").bind(JSON.stringify(clean), member.space_id).run();
  }
  if (body.clientInfo !== undefined) {
    const i = body.clientInfo;
    if (!i || i.protocolVersion !== 2 || typeof i.appVersion !== "string" || !/^[A-Za-z0-9.+-]{1,64}$/.test(i.appVersion) || !Number.isSafeInteger(i.settingsRevision) || i.settingsRevision < 0) return fail("client_info_invalid");
    await env.DB.prepare("UPDATE members SET sync_info = ?, heartbeat_at = ? WHERE id = ?").bind(JSON.stringify({protocolVersion: 2, appVersion: i.appVersion, settingsRevision: i.settingsRevision}), Math.floor(Date.now() / 1000), member.id).run();
  }
  const payloadJson = JSON.stringify(body.payload);
  const payloadHash = await hash(payloadJson);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare("INSERT INTO snapshots(space_id, device_id, payload_json, payload_hash, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, device_id) DO UPDATE SET payload_json = excluded.payload_json, payload_hash = excluded.payload_hash, updated_at = excluded.updated_at WHERE snapshots.payload_hash <> excluded.payload_hash AND json_extract(excluded.payload_json, '$._ts') > json_extract(snapshots.payload_json, '$._ts')")
    .bind(member.space_id, member.device_id, payloadJson, payloadHash, now).run();
  return response({ ok: true, snapshots: await snapshots(env, member.space_id) });
}

async function revokeDevice(request, env, member) {
  if (member.role !== "owner") return fail("forbidden", 403);
  const body = await readBody(request);
  if (!safeId(body?.deviceId) || body.deviceId === member.device_id) return fail("device_revoke_invalid");
  const result = await env.DB.prepare("UPDATE members SET revoked_at = ? WHERE space_id = ? AND device_id = ? AND role = 'member' AND revoked_at IS NULL")
    .bind(Math.floor(Date.now() / 1000), member.space_id, body.deviceId).run();
  if (result.meta.changes !== 1) return fail("device_not_active", 404);
  // Preserve snapshots for operator-approved recovery. Revocation is not erasure.
  return response({ ok: true });
}

export default {
  async fetch(request, env) {
    try {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/health") return response({ ok: true, service: "codex-cockpit-sync", version: 1 });
      // Fail closed on old configs: do not silently deploy an unprotected service.
      if (!env.AUTH_RATE_LIMITER?.limit || !env.API_RATE_LIMITER?.limit) return fail("rate_limit_unconfigured", 503);
      const ip = request.headers.get("cf-connecting-ip") || "local";
      const authRoute = request.method === "POST" && ["/v1/spaces", "/v1/join"].includes(pathname);
      const authLimit = await env.AUTH_RATE_LIMITER.limit({ key: authRoute ? `enroll:${ip}` : `access:${ip}` });
      if (!authLimit.success) {
        const limited = fail("rate_limited", 429);
        limited.headers.set("retry-after", "60");
        return limited;
      }
      if (request.method === "POST" && pathname === "/v1/spaces") return await createSpace(request, env);
      if (request.method === "POST" && pathname === "/v1/join") return await joinSpace(request, env);
      const member = await memberFor(request, env);
      if (!member) return fail("unauthorized", 401);
      const apiLimit = await env.API_RATE_LIMITER.limit({ key: `${member.space_id}:${member.id}` });
      if (!apiLimit.success) {
        const limited = fail("rate_limited", 429);
        limited.headers.set("retry-after", "60");
        return limited;
      }
      if (request.method === "POST" && pathname === "/v2/daily-plan") return await dailyPlan(request, env, member);
      if (request.method === "GET" && pathname === "/v1/me") {
        const space = await env.DB.prepare("SELECT id, name, group_settings FROM spaces WHERE id = ?").bind(member.space_id).first();
        const members = await env.DB.prepare("SELECT m.device_id AS deviceId, m.display_name AS displayName, m.role, m.sync_info AS syncInfo, m.heartbeat_at AS heartbeatAt, s.updated_at AS updatedAt FROM members m LEFT JOIN snapshots s ON s.space_id = m.space_id AND s.device_id = m.device_id WHERE m.space_id = ? AND m.revoked_at IS NULL ORDER BY m.created_at LIMIT ?").bind(member.space_id, MAX_MEMBERS).all();
        return response({ ok: true, space: { id: space.id, name: space.name }, sharedSettings: await sharedSettings(env, member.space_id), groupSettings: space.group_settings ? JSON.parse(space.group_settings) : null, deviceId: member.device_id, role: member.role, members: members.results.map(m => ({...m, syncInfo: m.syncInfo ? JSON.parse(m.syncInfo) : null})) });
      }
      if (request.method === "GET" && pathname === "/v2/settings") return response({ ok: true, sharedSettings: await sharedSettings(env, member.space_id) });
      if (request.method === "POST" && pathname === "/v2/settings") return await updateSettings(request, env, member);
      if (request.method === "POST" && pathname === "/v2/groups") return await updateGroups(request, env, member);
      if (request.method === "POST" && pathname === "/v1/invites") return await createInvite(request, env, member);
      if (request.method === "POST" && pathname === "/v1/devices/revoke") return await revokeDevice(request, env, member);
      if (request.method === "POST" && pathname === "/v1/sync") return await sync(request, env, member);
      if (request.method === "GET" && pathname === "/v1/snapshots") return response({ ok: true, snapshots: await snapshots(env, member.space_id) });
      return fail("not_found", 404);
    } catch (error) {
      const code = error instanceof Error && ["body_too_large", "invalid_json"].includes(error.message) ? error.message : "internal_error";
      return fail(code, code === "internal_error" ? 500 : code === "body_too_large" ? 413 : 400);
    }
  },
};
