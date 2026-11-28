import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES, defaultFontScaleForPlatform, effectiveCompactLayout, effectiveStayExpanded, normalizeWidgetPreferences, syncDailyBudgetToSuggestion } from "./preferences";
import { UI_FONT_OPTIONS, defaultFontFamilyForPlatform } from "./fonts";

describe("widget preference migration", () => {
  it("only enables Codex in a fresh profile", () => {
    const defaults = { cockpitMode: "codex", codexEnabled: true, claudeEnabled: false, geminiEnabled: false };
    expect(DEFAULT_WIDGET_PREFERENCES).toMatchObject(defaults);
    expect(normalizeWidgetPreferences({})).toMatchObject(defaults);
  });

  it("defaults the shared five-hour refresh switch off and preserves the saved choice", () => {
    expect(normalizeWidgetPreferences({}).autoRefreshFiveHourQuota).toBe(false);
    const enabled = normalizeWidgetPreferences({ autoRefreshFiveHourQuota: true });
    expect(normalizeWidgetPreferences(JSON.parse(JSON.stringify(enabled))).autoRefreshFiveHourQuota).toBe(true);
    expect(normalizeWidgetPreferences({ ...enabled, autoRefreshFiveHourQuota: false }).autoRefreshFiveHourQuota).toBe(false);
  });

  it("keeps Claude off after restoring Codex and Gemini in AI mode", () => {
    const toggled = normalizeWidgetPreferences({ cockpitMode: "ai", codexEnabled: true, claudeEnabled: false, geminiEnabled: true });
    const restored = normalizeWidgetPreferences(JSON.parse(JSON.stringify(toggled)));
    expect(restored).toMatchObject({ cockpitMode: "ai", codexEnabled: true, claudeEnabled: false, geminiEnabled: true });
    expect(normalizeWidgetPreferences({ cockpitMode: "ai", claudeEnabled: false }).cockpitMode).toBe("codex");
  });

  it("infers Claude only for legacy Claude or Codex and Claude profiles", () => {
    expect(normalizeWidgetPreferences({ cockpitMode: "claude" }).claudeEnabled).toBe(true);
    expect(normalizeWidgetPreferences({ cockpitMode: "ai" }).claudeEnabled).toBe(true);
    expect(normalizeWidgetPreferences({ cockpitMode: "ai", geminiEnabled: true }).claudeEnabled).toBe(false);
  });

  it("defaults to manual updates while honoring saved opt-in", () => {
    expect(normalizeWidgetPreferences({}).automaticUpdates).toBe(false);
    expect(normalizeWidgetPreferences({ automaticUpdates: false }).automaticUpdates).toBe(false);
    expect(normalizeWidgetPreferences({ automaticUpdates: true }).automaticUpdates).toBe(true);
  });

  it("defaults to stable updates without changing an explicit beta preference", () => {
    expect(DEFAULT_WIDGET_PREFERENCES.updateChannel).toBe("stable");
    expect(normalizeWidgetPreferences({}).updateChannel).toBe("stable");
    expect(normalizeWidgetPreferences({ updateChannel: "invalid" as never }).updateChannel).toBe("stable");
    expect(normalizeWidgetPreferences({ updateChannel: "beta" }).updateChannel).toBe("beta");
  });
  it("keeps platform defaults for older settings and persists every supported font", () => {
    expect(defaultFontFamilyForPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("system");
    expect(defaultFontFamilyForPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("smiley");
    expect(normalizeWidgetPreferences({}).fontFamily).toBe(DEFAULT_WIDGET_PREFERENCES.fontFamily);
    for (const { id } of UI_FONT_OPTIONS) {
      const restored = JSON.parse(JSON.stringify(normalizeWidgetPreferences({ fontFamily: id, fontScale: 1.75 })));
      expect(normalizeWidgetPreferences(restored)).toEqual(expect.objectContaining({ fontFamily: id, fontScale: 1.75 }));
    }
    for (const value of [null, 12, {}, "unknown", "serif; background: url(x)"]) {
      expect(normalizeWidgetPreferences({ fontFamily: value as never }).fontFamily).toBe(DEFAULT_WIDGET_PREFERENCES.fontFamily);
    }
  });

  it("uses a readable 150% default on both desktop platforms without replacing manual sizes", () => {
    expect(defaultFontScaleForPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(1.5);
    expect(defaultFontScaleForPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(1.5);
    expect(normalizeWidgetPreferences({}).fontScale).toBe(1.5);
    expect(normalizeWidgetPreferences({ fontScale: 1.1 }).fontScale).toBe(1.1);
    expect(normalizeWidgetPreferences({ fontScale: 2 }).fontScale).toBe(2);
  });

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
    expect(value.fontScale).toBe(DEFAULT_WIDGET_PREFERENCES.fontScale);
    expect(value.backgroundBlur).toBe(true);
    expect(value.codexFocusMode).toBe(true);
    expect(value.dailyBudgetPercent).toBe(14.3);
    expect(value.dailyBudgetLocalDate).toBeNull();
    expect(value.resetRiskOverridePercent).toBeNull();
    expect(value.riskFirst).toBe(false);
    expect(value.showHistorySparklines).toBe(true);
    expect(value.notificationsEnabled).toBe(true);
  });

  it("defaults Liquid Glass to off and preserves an explicit opt-in", () => {
    expect(normalizeWidgetPreferences({}).capsuleLiquidGlass).toBe(false);
    expect(normalizeWidgetPreferences({ capsuleLiquidGlass: true }).capsuleLiquidGlass).toBe(true);
  });

  it("preserves an explicit no-blur background preference", () => {
    expect(normalizeWidgetPreferences({ backgroundBlur: false }).backgroundBlur).toBe(false);
    expect(normalizeWidgetPreferences({ backgroundBlur: "false" as never }).backgroundBlur).toBe(true);
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
