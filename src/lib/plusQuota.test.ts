import { expect, it } from "vitest";
import { fiveHourRemaining, isCodexPlus } from "./plusQuota";
import type { ProviderSnapshot } from "../types";
const snapshot = (plan: string | null, remaining = 42, duration = 18_000): ProviderSnapshot => ({
  provider: "codex", displayName: "Codex", plan, shortWindow: { remainingPercent: remaining, windowSeconds: duration, resetsAt: null },
  weeklyWindow: null, resetCredits: null, updatedAt: "", status: "ok", message: null,
});
it("recognizes Plus but not Pro, Prolite, other providers or unknown plans", () => {
  for (const plan of ["PLUS", " plus ", "ChatGPT Plus", "chatgpt_plus", "chatgpt-plus"]) expect(isCodexPlus(snapshot(plan))).toBe(true);
  for (const plan of ["PRO", "PROLITE", null, "business"]) expect(isCodexPlus(snapshot(plan))).toBe(false);
  expect(isCodexPlus({ ...snapshot("PLUS"), provider: "qoder" })).toBe(false);
});
it("keeps missing, non-finite and non-5h windows unknown while preserving zero", () => {
  expect(fiveHourRemaining(snapshot("PLUS", 0))).toBe(0);
  expect(fiveHourRemaining(snapshot("PLUS", NaN))).toBeNull();
  expect(fiveHourRemaining(snapshot("PLUS", 42, 604800))).toBeNull();
  expect(fiveHourRemaining({ ...snapshot("PLUS"), shortWindow: null })).toBeNull();
});
