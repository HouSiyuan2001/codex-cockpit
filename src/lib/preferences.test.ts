import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES, effectiveCompactLayout, effectiveStayExpanded, normalizeWidgetPreferences, syncDailyBudgetToSuggestion } from "./preferences";

describe("widget preference migration", () => {
  it("preserves only valid personal ring colors", () => {
    expect(normalizeWidgetPreferences({ personRingColors: { alex: "#123456", bad: "red;url(x)" } }).personRingColors).toEqual({ alex: "#123456" });
    expect(normalizeWidgetPreferences({}).personRingColors).toEqual({});
  });
  it("forces the focused Codex card to use an auto-collapsing capsule", () => {
    const focused = { ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, stayExpanded: true, compactLayout: "ring" as const };
    expect(effectiveCompactLayout(focused, "codex")).toBe("capsule");
    expect(effectiveStayExpanded(focused)).toBe(false);
    const standard = { ...focused, codexFocusMode: false };
    expect(effectiveCompactLayout(standard, "codex")).toBe("ring");
    expect(effectiveStayExpanded(standard)).toBe(true);
  });

  it("fills new quality-of-life settings for legacy preferences", () => {
    const value = normalizeWidgetPreferences({ language: "en", providerOrder: ["qoder", "codex"] as never });
    expect(value.providerOrder).toEqual(["qoder", "codex", "trae", "workbuddy", "volcengine", "antigravity"]);
    expect(value.layoutMode).toBe("standard");
    expect(value.compactLayout).toBe("float");
    expect(value.expandedLayout).toBe("dashboard");
    expect(value.colorTheme).toBe("aurora");
    expect(value.appearanceMode).toBe("light");
    expect(value.fontScale).toBe(1.15);
    expect(value.codexFocusMode).toBe(true);
    expect(value.dailyBudgetPercent).toBe(14.3);
    expect(value.dailyBudgetLocalDate).toBeNull();
    expect(value.resetRiskOverridePercent).toBeNull();
    expect(value.riskFirst).toBe(false);
    expect(value.showHistorySparklines).toBe(true);
    expect(value.notificationsEnabled).toBe(true);
  });

  it("normalizes independent compact layouts and color themes", () => {
    const graphiteBar = normalizeWidgetPreferences({ compactLayout: "bar", expandedLayout: "provider-bar", colorTheme: "graphite", riskFirst: true, showHistorySparklines: false });
    expect(graphiteBar.compactLayout).toBe("bar");
    expect(graphiteBar.expandedLayout).toBe("provider-bar");
    expect(graphiteBar.colorTheme).toBe("graphite");
    expect(normalizeWidgetPreferences({ compactLayout: "ring", expandedLayout: "stacked" })).toEqual(expect.objectContaining({ compactLayout: "ring", expandedLayout: "stacked" }));
    expect(normalizeWidgetPreferences({ appearanceMode: "system" }).appearanceMode).toBe("system");
    expect(normalizeWidgetPreferences({ appearanceMode: "dark" }).appearanceMode).toBe("dark");
    expect(normalizeWidgetPreferences({ appearanceMode: "sepia" as never }).appearanceMode).toBe("light");
    expect(normalizeWidgetPreferences({ compactLayout: "stack" as never }).compactLayout).toBe("float");
    expect(normalizeWidgetPreferences({ expandedLayout: "stack" as never }).expandedLayout).toBe("dashboard");
    expect(normalizeWidgetPreferences({ colorTheme: "neon" as never }).colorTheme).toBe("aurora");
  });

  it("migrates legacy visual styles without coupling layout and color", () => {
    expect(normalizeWidgetPreferences({ visualStyle: "island" }).compactLayout).toBe("bar");
    expect(normalizeWidgetPreferences({ visualStyle: "island" }).expandedLayout).toBe("provider-bar");
    expect(normalizeWidgetPreferences({ visualStyle: "island" }).colorTheme).toBe("aurora");
    expect(normalizeWidgetPreferences({ visualStyle: "graphite" }).compactLayout).toBe("float");
    expect(normalizeWidgetPreferences({ visualStyle: "graphite" }).colorTheme).toBe("graphite");
  });

  it("rejects unsafe colors and never hides every provider", () => {
    const value = normalizeWidgetPreferences({ accentColor: "red; background:url(x)", hiddenProviders: ["codex", "qoder", "trae", "workbuddy", "volcengine", "antigravity"] });
    expect(value.accentColor).toBe("#397ae0");
    expect(value.hiddenProviders).toEqual([]);
  });

  it("normalizes malformed values from a manually edited backup", () => {
    const value = normalizeWidgetPreferences({
      alertThreshold: "many" as never,
      autoRotateSeconds: Number.NaN,
      notificationsEnabled: "false" as never,
      quietHoursStart: -100,
      notificationCooldownMinutes: Number.POSITIVE_INFINITY,
      dailyBudgetPercent: 200.04,
    });
    expect(value.alertThreshold).toBe(15);
    expect(value.autoRotateSeconds).toBe(12);
    expect(value.notificationsEnabled).toBe(true);
    expect(value.quietHoursStart).toBe(0);
    expect(value.notificationCooldownMinutes).toBe(120);
    expect(value.dailyBudgetPercent).toBe(100);
    expect(normalizeWidgetPreferences({ resetRiskOverridePercent: 120 }).resetRiskOverridePercent).toBe(100);
    expect(normalizeWidgetPreferences({ resetRiskOverridePercent: -1 }).resetRiskOverridePercent).toBe(0);
    expect(normalizeWidgetPreferences({ resetRiskOverridePercent: 4.26 }).resetRiskOverridePercent).toBe(4.3);
    expect(normalizeWidgetPreferences({ resetRiskOverridePercent: 0 }).resetRiskOverridePercent).toBe(0);
    expect(normalizeWidgetPreferences({ resetRiskAdjustmentPercent: 7 } as never).resetRiskOverridePercent).toBeNull();
    expect(normalizeWidgetPreferences({ dailyBudgetPercent: 7.26 }).dailyBudgetPercent).toBe(7.3);
    expect(normalizeWidgetPreferences({ dailyBudgetLocalDate: "not-a-date" }).dailyBudgetLocalDate).toBeNull();
    expect(normalizeWidgetPreferences({ fontScale: 0.2 }).fontScale).toBe(1);
    expect(normalizeWidgetPreferences({ fontScale: 1.27 }).fontScale).toBe(1.25);
    expect(normalizeWidgetPreferences({ fontScale: 2 }).fontScale).toBe(2);
    expect(normalizeWidgetPreferences({ fontScale: 4 }).fontScale).toBe(2);
  });

  it("syncs the personal cap once per Beijing usage day and preserves manual edits afterward", () => {
    const preferences = { ...DEFAULT_WIDGET_PREFERENCES, dailyBudgetPercent: 5.7, dailyBudgetLocalDate: null };
    const synced = syncDailyBudgetToSuggestion(preferences, "2026-08-16", 22.9);
    expect(synced).toEqual(expect.objectContaining({ dailyBudgetPercent: 22.9, dailyBudgetLocalDate: "2026-08-16" }));
    const manual = { ...synced!, dailyBudgetPercent: 8.1 };
    expect(syncDailyBudgetToSuggestion(manual, "2026-08-16", 30)).toBeNull();
    expect(syncDailyBudgetToSuggestion(synced!, "2026-08-17", 30)).toEqual(expect.objectContaining({ dailyBudgetPercent: 30, dailyBudgetLocalDate: "2026-08-17" }));
  });
});
