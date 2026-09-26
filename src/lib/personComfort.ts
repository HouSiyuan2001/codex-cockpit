import { buildComfortPrompt } from "./comfortFeedback";
import { buildPersonQuotaAllocation } from "./personQuotaAllocation";
import type { TokeiUsage } from "./tokeiUsage";
import type { CodexDailyUsage, ComfortFeedbackRecord, ComfortQuotaAllocation, DailyUsageSummary } from "../types";

/** The stored percentage remains the shared account total, never allocated twice. */
export function allocationForFeedback(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortQuotaAllocation | null {
  if (!record.personId) return null;
  if (record.quotaAllocation) return record.quotaAllocation;
  if (!data) return null;
  const total = record.observedUsedPercent !== null && record.usageCoverage !== "unavailable"
    ? record
    : buildComfortPrompt({ localDate: record.localDate, isCatchUp: true }, official.find(day => day.localDate === record.localDate) ?? null, history);
  return buildPersonQuotaAllocation(data, record.personId, record.localDate, total, now);
}

/** A derived view for the original smooth-knee fitter; do not persist this view. */
export function personalFeedbackView(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortFeedbackRecord {
  if (!record.personId) return record;
  const quotaAllocation = allocationForFeedback(record, data, official, history, now);
  return {
    ...record,
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
