// Mirror the native aggregate/feedback projections. Reject rather than store unknown fields.
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const text = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const number = (v, max = 1e12) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const nullable = (v, max) => v === null || number(v, max);
const optional = (v, check) => v === undefined || check(v);
const date = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const timestamp = v => text(v, 64) && Number.isFinite(Date.parse(v));
const list = (v, max, check) => Array.isArray(v) && v.length <= max && v.every(check);
const ids = v => list(v, 128, x => text(x, 128));
const coverage = v => ["complete", "partial", "unavailable"].includes(v);
const periods = ["today", "yesterday", "week", "month", "all"];
const metricKeys = ["in", "cached", "out", "reason", "cost", "models"];
const tokenKeys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"];
const tokenMetrics = v => tokenKeys.every(k => count(v[k]));

function model(v, ledger) {
  const allowed = ledger ? ["in", "cr", "cw", "out", "reason", "cost", "name"] : ["model_id", "name", "in", "cr", "out", "reason", "cost"];
  return fields(v, allowed) && count(v.in) && count(v.out)
    && ["cr", "cw", "reason"].every(k => optional(v[k], count))
    && optional(v.cost, x => nullable(x)) && optional(v.name, x => text(x))
    && (ledger || text(v.model_id));
}

function period(v, ledger) {
  if (!fields(v, metricKeys) || !count(v.in) || !count(v.out)
    || !["cached", "reason"].every(k => optional(v[k], count))
    || !optional(v.cost, x => nullable(x))) return false;
  if (!ledger) return list(v.models, 256, x => model(x, false));
  return object(v.models) && Object.keys(v.models).length <= 256
    && Object.entries(v.models).every(([id, row]) => text(id) && model(row, true));
}

export function validAggregates(payload) {
  if (!fields(payload.codex, ["ranges"]) || !fields(payload.codex.ranges, periods)
    || !Object.values(payload.codex.ranges).every(v => period(v, false))) return false;
  const ledger = payload._ledger;
  if (!fields(ledger, ["v", "tools"]) || !optional(ledger.v, v => v === 1)
    || !fields(ledger.tools, ["codex"]) || !object(ledger.tools.codex)
    || Object.keys(ledger.tools.codex).length > 4096
    || !Object.entries(ledger.tools.codex).every(([day, v]) => date(day) && period(v, true))) return false;
  if (payload._range_bounds !== undefined && (!fields(payload._range_bounds, periods)
    || !Object.values(payload._range_bounds).every(v => fields(v, ["start", "end"])
      && (v.start === null || date(v.start)) && (v.end === null || date(v.end))))) return false;
  const meta = payload._cockpit;
  return meta === undefined || (fields(meta, ["schemaVersion", "collectedAt", "status", "retainedDays", "nativeDays"])
    && meta.schemaVersion === 1 && optional(meta.collectedAt, timestamp)
    && optional(meta.status, v => ["ready", "partial", "unavailable"].includes(v))
    && optional(meta.retainedDays, count) && optional(meta.nativeDays, v => list(v, 4096, date)));
}

function tokenSnapshot(v, day) {
  return fields(v, ["localDate", "observedAt", "metricVersion", "coverage", ...tokenKeys, "models", "deviceIds", "missingDeviceIds", "incompleteDeviceIds"])
    && v.localDate === day && timestamp(v.observedAt) && v.metricVersion === "p020-person-calendar-token-v1"
    && coverage(v.coverage) && tokenMetrics(v)
    && list(v.models, 128, m => fields(m, ["id", "name", ...tokenKeys]) && text(m.id, 128) && text(m.name, 128) && tokenMetrics(m))
    && ids(v.deviceIds) && ids(v.missingDeviceIds) && optional(v.incompleteDeviceIds, ids);
}

function allocation(v, day) {
  return fields(v, ["metricVersion", "localDate", "observedAt", "totalUsedPercent", "personCostUsd", "totalCostUsd", "costShare", "allocatedUsedPercent", "coverage", "deviceIds", "missingDeviceIds"])
    && v.localDate === day && timestamp(v.observedAt) && v.metricVersion === "cost-share-v1" && coverage(v.coverage)
    && nullable(v.totalUsedPercent, 10000) && nullable(v.allocatedUsedPercent, 10000)
    && nullable(v.personCostUsd, 1e9) && nullable(v.totalCostUsd, 1e9) && nullable(v.costShare, 1)
    && ids(v.deviceIds) && ids(v.missingDeviceIds);
}

export function validFeedback(payload) {
  if (payload.comfortFeedback === undefined) return payload.comfortFeedbackVersion === undefined;
  return payload.comfortFeedbackVersion === 1 && list(payload.comfortFeedback, 4096, v =>
    fields(v, ["localDate", "observedAt", "updatedAt", "comfort", "personId", "personName", "tokenSnapshot", "quotaAllocation", "observedUsedPercent", "usageObservedAt", "usageCoverage", "usageSource", "curveVersion"])
    && date(v.localDate) && timestamp(v.observedAt) && optional(v.updatedAt, timestamp)
    && ["overloaded", "comfortable", "idle"].includes(v.comfort)
    && text(v.personId, 128) && (v.personName === null || text(v.personName, 64))
    && nullable(v.observedUsedPercent, 10000) && (v.usageObservedAt === null || timestamp(v.usageObservedAt))
    && coverage(v.usageCoverage) && ["official-snapshot", "local-history", "unavailable"].includes(v.usageSource)
    && ["p014-t014-ordinal-map-v3", "p014-t014-smooth-knee-v2", "p014-t014-y-v1"].includes(v.curveVersion)
    && (v.tokenSnapshot === null || tokenSnapshot(v.tokenSnapshot, v.localDate))
    && (v.quotaAllocation === null || allocation(v.quotaAllocation, v.localDate)));
}
