import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "./preferences";
import { planPreferences, planDateKey } from "./personPlanSync";

describe("person plan projection", () => {
  it("uses Beijing midnight independently of the 04:00 usage day", () => {
    expect(planDateKey(new Date("2026-09-10T15:59:59Z"))).toBe("2026-09-10");
    expect(planDateKey(new Date("2026-09-10T16:00:00Z"))).toBe("2026-09-11");
    expect(planDateKey(new Date("2026-09-10T19:59:59Z"))).toBe("2026-09-11");
  });
  it("activates a shared manual scenario and clears it when following the website", () => {
    const dormant = { ...DEFAULT_WIDGET_PREFERENCES, resetRiskOverridePercent: 35, resetRiskManualEnabled: false };
    const enabled = planPreferences(dormant, { resetRiskOverridePercent: 35 }, "2026-09-11")!;
    expect(enabled.resetRiskManualEnabled).toBe(true);
    expect(planPreferences(enabled, { resetRiskOverridePercent: null }, "2026-09-11")).toMatchObject({ resetRiskManualEnabled: false, resetRiskOverridePercent: null });
    expect(planPreferences(enabled, {}, "2026-09-11")).toBeNull();
  });
  it("updates only allowlisted plan fields and preserves device preferences", () => {
    const initial = { ...DEFAULT_WIDGET_PREFERENCES, dailyBudgetPercent: 10, fontScale: 1.5, stayExpanded: true };
    const result = planPreferences(initial, { dailyBudgetPercent: 25, resetRiskOverridePercent: null }, "2026-09-11");
    expect(result).toEqual({ ...initial, dailyBudgetPercent: 25, dailyBudgetLocalDate: "2026-09-11", resetRiskOverridePercent: null });
  });
  it("missing or invalid remote values never overwrite local settings", () => {
    expect(planPreferences(DEFAULT_WIDGET_PREFERENCES, {}, "2026-09-11")).toBeNull();
    expect(planPreferences(DEFAULT_WIDGET_PREFERENCES, { dailyBudgetPercent: NaN, resetRiskOverridePercent: 101 }, "2026-09-11")).toBeNull();
  });
  it("an unchanged imported plan does not cause another write", () => {
    const initial = { ...DEFAULT_WIDGET_PREFERENCES, dailyBudgetPercent: 25, dailyBudgetLocalDate: "2026-09-11" };
    expect(planPreferences(initial, { dailyBudgetPercent: 25 }, "2026-09-11")).toBeNull();
  });
});
