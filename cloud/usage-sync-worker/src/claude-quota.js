import { readBody } from "./request-body.js";

const record = (value, keys) => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const timestamp = value => typeof value === "string" && value.length <= 40
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(value) && Number.isFinite(Date.parse(value));

function validWindow(window, percent = "usedPercent") {
  return window === null || (record(window, [percent, "resetsAt"])
    && typeof window[percent] === "number" && window[percent] >= 0 && window[percent] <= 100
    && (window.resetsAt === null || timestamp(window.resetsAt)));
}

function validObservation(value, now) {
  return timestamp(value) && Date.parse(value) <= now + 300_000
    && Date.parse(value) >= now - 7 * 86_400_000;
}

export function validClaudeQuota(value, now = Date.now()) {
  return record(value, ["observedAt", "fiveHour", "sevenDay"])
    && validObservation(value.observedAt, now)
    && (value.fiveHour !== null || value.sevenDay !== null)
    && validWindow(value.fiveHour) && validWindow(value.sevenDay);
}

function validGeminiPool(pool) {
  return pool === null || (record(pool, ["fiveHour", "weekly"])
    && (pool.fiveHour !== null || pool.weekly !== null)
    && validWindow(pool.fiveHour, "remainingPercent")
    && validWindow(pool.weekly, "remainingPercent"));
}

export function validGeminiQuota(value, now = Date.now()) {
  return record(value, ["observedAt", "gemini", "claudeGpt"])
    && validObservation(value.observedAt, now)
    && (value.gemini !== null || value.claudeGpt !== null)
    && validGeminiPool(value.gemini) && validGeminiPool(value.claudeGpt);
}

export async function providerQuota(request, env, member, { response, fail, validGroups }, gemini = false) {
  const table = gemini ? "gemini_quota_snapshots" : "claude_quota_snapshots";
  const validQuota = gemini ? validGeminiQuota : validClaudeQuota;
  const space = await env.DB.prepare("SELECT group_settings, claude_quota_groups FROM spaces WHERE id = ?")
    .bind(member.space_id).first();
  const raw = space?.group_settings;
  const approvedRaw = space?.claude_quota_groups;
  const groups = raw ? JSON.parse(raw) : null;
  const approvedGroups = approvedRaw ? JSON.parse(approvedRaw) : null;
  const person = validGroups(groups) && groups.groups.find(group => group.deviceIds.includes(member.device_id));
  // Members may edit usage groups. Only the owner's saved assignments can grant quota access.
  const approved = person && validGroups(approvedGroups)
    && approvedGroups.groups.find(group => group.id === person.id && group.deviceIds.includes(member.device_id));
  if (!approved) return response({ ok: true, snapshots: [] });
  const allowedDevices = person.deviceIds.filter(id => approved.deviceIds.includes(id));

  if (request.method === "POST") {
    const quota = await readBody(request, 2048);
    if (!validQuota(quota)) return fail(gemini ? "gemini_quota_invalid" : "claude_quota_invalid");
    await env.DB.prepare(`
      INSERT INTO ${table} (space_id, device_id, person_id, observed_at, payload_json)
      SELECT ?, ?, ?, ?, ? FROM spaces WHERE id = ? AND group_settings = ? AND claude_quota_groups = ?
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at IS NULL)
      ON CONFLICT (space_id, device_id) DO UPDATE SET
        person_id = excluded.person_id, observed_at = excluded.observed_at, payload_json = excluded.payload_json
      WHERE excluded.observed_at > ${table}.observed_at
    `).bind(member.space_id, member.device_id, person.id, Date.parse(quota.observedAt),
      JSON.stringify(quota), member.space_id, raw, approvedRaw, member.id).run();
    return response({ ok: true });
  }

  const rows = await env.DB.prepare(`
    SELECT q.device_id, m.display_name, q.payload_json FROM ${table} q
    JOIN members m ON m.space_id = q.space_id AND m.device_id = q.device_id
    JOIN spaces s ON s.id = q.space_id
    WHERE q.space_id = ? AND s.group_settings = ? AND s.claude_quota_groups = ? AND q.person_id = ?
      AND q.device_id != ? AND m.revoked_at IS NULL AND q.device_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at IS NULL)
    ORDER BY q.observed_at DESC, q.device_id LIMIT 31
  `).bind(member.space_id, raw, approvedRaw, person.id, member.device_id, JSON.stringify(allowedDevices), member.id).all();
  const snapshots = rows.results.flatMap(row => {
    const quota = JSON.parse(row.payload_json);
    return validQuota(quota) ? [{ deviceId: row.device_id, deviceName: row.display_name, quota }] : [];
  });
  return response({ ok: true, snapshots });
}
