import { normalizeComfortFeedbackRecord, normalizeComfortFeedbackRecords } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";
import { localDateKey } from "./comfortFeedback";

const identity = (r: ComfortFeedbackRecord) => JSON.stringify([r.personId ?? null, r.localDate]);
const revision = (r: ComfortFeedbackRecord) => Date.parse(r.updatedAt ?? r.observedAt);
const validTimeline = (r: ComfortFeedbackRecord, now: Date) => r.localDate <= localDateKey(now)
  && [r.observedAt, r.updatedAt ?? r.observedAt].every(value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now.getTime() + 300_000);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;

/** Deterministic last-edit-wins union. No remote record can claim local legacy data. */
export function mergeSyncedComfortFeedback(local: readonly ComfortFeedbackRecord[], remote: unknown, now = new Date()): ComfortFeedbackRecord[] | null {
  if (!Array.isArray(remote)) return null;
  const merged = new Map(local.map(record => [identity(record), record]));
  let changed = false;
  for (const value of remote) {
    const candidate = normalizeComfortFeedbackRecord(value);
    if (!candidate?.personId || !validTimeline(candidate, now)) continue;
    const key = identity(candidate);
    const previous = merged.get(key);
    const normalizedPrevious = previous ? normalizeComfortFeedbackRecord(previous) : null;
    if (!previous || !validTimeline(previous, now) || revision(candidate) > revision(previous)
      || (revision(candidate) === revision(previous) && JSON.stringify(canonical(candidate)) > JSON.stringify(canonical(normalizedPrevious)))) {
      merged.set(key, candidate);
      changed = true;
    }
  }
  if (!changed) return null;
  const next = normalizeComfortFeedbackRecords([...merged.values()]);
  return JSON.stringify(next) === JSON.stringify(local) ? null : next;
}
