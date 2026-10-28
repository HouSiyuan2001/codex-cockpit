import { buildComfortPrompt } from "./comfortFeedback";
import { buildTokenComfortSnapshot } from "./tokenComfort";
import { buildPersonQuotaAllocation } from "./personQuotaAllocation";
import type { TokeiUsage } from "./tokeiUsage";
import type { CodexDailyUsage, ComfortFeedbackRecord, ComfortQuotaAllocation, DailyUsageSummary } from "../types";

/** The stored percentage remains the shared account total, never allocated twice. */
export function allocationForFeedback(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortQuotaAllocation | null {
  if (!record.personId) return null;
  if (!data) return record.quotaAllocation ?? null;
  const day = official.find(day => day.localDate === record.localDate) ?? null;
  const freshTotal = buildComfortPrompt({ localDate: record.localDate, isCatchUp: true }, day, history);
  // A finished calendar day can correct an earlier snapshot in either direction.
  // During an incremental scan, do not replace a later observation with a prefix.
  const observedAt = Date.parse(record.usageObservedAt ?? "");
  const freshEnough = day && (day.coverage === "complete" || !Number.isFinite(observedAt)
    || Date.parse(day.lastObservedAt ?? "") >= observedAt);
  const total = freshTotal.observedUsedPercent !== null
    && (freshEnough || record.observedUsedPercent === null) ? freshTotal : record;
  const fresh = buildPersonQuotaAllocation(data, record.personId, record.localDate, total, now);
  if (!fresh || fresh.allocatedUsedPercent === null) return record.quotaAllocation ?? fresh;
  return fresh;
}

/** A derived view for the original smooth-knee fitter; do not persist this view. */
export function personalFeedbackView(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortFeedbackRecord {
  if (!record.personId) return record;
  const quotaAllocation = allocationForFeedback(record, data, official, history, now);
  const currentTokens = data ? buildTokenComfortSnapshot(data, record.personId, record.localDate, now) : null;
  return {
    ...record,
    tokenSnapshot: currentTokens && currentTokens.coverage !== "unavailable" ? currentTokens : record.tokenSnapshot,
    quotaAllocation,
    observedUsedPercent: quotaAllocation?.allocatedUsedPercent ?? null,
    usageCoverage: quotaAllocation?.coverage ?? "unavailable",
  };
}

/** Upgrade existing assigned feedback once, retaining its feeling and raw total. */
export function backfillPersonAllocations(records: readonly ComfortFeedbackRecord[], data: TokeiUsage, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortFeedbackRecord[] | null {
  let changed = false;
  const next = records.map(record => {
    if (!record.personId || record.quotaAllocation) return record;
    const allocation = allocationForFeedback(record, data, official, history, now);
    if (!allocation || allocation.coverage !== "complete" || allocation.allocatedUsedPercent === null) return record;
    changed = true;
    return { ...record, quotaAllocation: allocation };
  });
  return changed ? next : null;
}
