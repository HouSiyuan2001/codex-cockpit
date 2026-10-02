import { DEFAULT_PROVIDER_ORDER, normalizeProviderOrder } from "./providers";
import type { ProviderId, WidgetPreferences, WindowCompactLayout } from "../types";

export const DEFAULT_WIDGET_PREFERENCES: WidgetPreferences = {
  codexFocusMode: true,
  dailyBudgetPercent: 14.3,
  dailyBudgetLocalDate: null,
  resetRiskOverridePercent: null,
  resetRiskManualEnabled: false,
  locked: false,
  alwaysOnTop: true,
  stayExpanded: true,
  pinnedProvider: "codex",
  providerOrder: DEFAULT_PROVIDER_ORDER,
  autoRotateSeconds: 12,
  language: "zh-CN",
  skippedUpdateVersion: null,
  hiddenProviders: ["qoder", "trae", "workbuddy", "volcengine", "antigravity"],
  collapsedProviders: [],
  layoutMode: "standard",
  compactLayout: "float",
  expandedLayout: "dashboard",
  colorTheme: "aurora",
  appearanceMode: "light",
  fontScale: 1.15,
  riskFirst: false,
  showHistorySparklines: true,
  accentColor: "#397ae0",
  alertThreshold: 15,
  notificationsEnabled: true,
  notifyOnReset: true,
  notifyOnRecovery: true,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  notificationCooldownMinutes: 120,
  updateChannel: "beta",
  automaticUpdates: true,
};

export function effectiveCompactLayout(preferences: WidgetPreferences, provider: ProviderId | null): WindowCompactLayout {
  return preferences.codexFocusMode && provider === "codex" ? "capsule" : preferences.compactLayout;
}

export function effectiveStayExpanded(preferences: WidgetPreferences): boolean {
  return preferences.stayExpanded && !preferences.codexFocusMode;
}

const providerSet = new Set<ProviderId>(DEFAULT_PROVIDER_ORDER);

function providerList(value: unknown): ProviderId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is ProviderId => providerSet.has(item as ProviderId)))];
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function boundedDecimal(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)) * 10) / 10
    : fallback;
}

function optionalBoundedDecimal(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(min, Math.min(max, value)) * 10) / 10
    : null;
}

function boundedFontScale(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(1, Math.min(2, value)) * 20) / 20
    : DEFAULT_WIDGET_PREFERENCES.fontScale;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function safeSkippedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 64 ? normalized : null;
}

function safeUsageDate(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

type LegacyWidgetPreferences = Partial<WidgetPreferences> & { visualStyle?: unknown };

export function normalizeWidgetPreferences(value: LegacyWidgetPreferences | null | undefined): WidgetPreferences {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const hiddenProviders = providerList(candidate.hiddenProviders);
  const pinnedProvider = providerSet.has(candidate.pinnedProvider as ProviderId) ? candidate.pinnedProvider as ProviderId : null;
  const layoutMode = candidate.layoutMode === "compact" || candidate.layoutMode === "detailed" ? candidate.layoutMode : "standard";
  const compactLayout = candidate.compactLayout === "bar" || candidate.compactLayout === "ring" || candidate.compactLayout === "float"
    ? candidate.compactLayout
    : candidate.visualStyle === "island" ? "bar" : "float";
  const expandedLayout = candidate.expandedLayout === "provider-bar" || candidate.expandedLayout === "stacked" || candidate.expandedLayout === "dashboard"
    ? candidate.expandedLayout
    : candidate.visualStyle === "island" ? "provider-bar" : "dashboard";
  const colorTheme = candidate.colorTheme === "graphite" || candidate.colorTheme === "paper" || candidate.colorTheme === "aurora"
    ? candidate.colorTheme
    : candidate.visualStyle === "graphite" || candidate.visualStyle === "paper"
      ? candidate.visualStyle
      : "aurora";
  const appearanceMode = candidate.appearanceMode === "system" || candidate.appearanceMode === "light" || candidate.appearanceMode === "dark"
    ? candidate.appearanceMode
    : DEFAULT_WIDGET_PREFERENCES.appearanceMode;
  const accentColor = typeof candidate.accentColor === "string" && /^#[0-9a-f]{6}$/i.test(candidate.accentColor)
    ? candidate.accentColor
    : DEFAULT_WIDGET_PREFERENCES.accentColor;
  return {
    codexFocusMode: booleanValue(candidate.codexFocusMode, DEFAULT_WIDGET_PREFERENCES.codexFocusMode),
    dailyBudgetPercent: boundedDecimal(candidate.dailyBudgetPercent, DEFAULT_WIDGET_PREFERENCES.dailyBudgetPercent, 1, 100),
    dailyBudgetLocalDate: safeUsageDate(candidate.dailyBudgetLocalDate),
    resetRiskOverridePercent: optionalBoundedDecimal(candidate.resetRiskOverridePercent, 0, 100),
    resetRiskManualEnabled: candidate.resetRiskManualEnabled === true,
    locked: booleanValue(candidate.locked, DEFAULT_WIDGET_PREFERENCES.locked),
    alwaysOnTop: booleanValue(candidate.alwaysOnTop, DEFAULT_WIDGET_PREFERENCES.alwaysOnTop),
    stayExpanded: booleanValue(candidate.stayExpanded, DEFAULT_WIDGET_PREFERENCES.stayExpanded),
    pinnedProvider,
    providerOrder: normalizeProviderOrder(Array.isArray(candidate.providerOrder) ? candidate.providerOrder as ProviderId[] : DEFAULT_PROVIDER_ORDER),
    autoRotateSeconds: boundedInteger(candidate.autoRotateSeconds, DEFAULT_WIDGET_PREFERENCES.autoRotateSeconds, 5, 300),
    language: candidate.language === "en" ? "en" : "zh-CN",
    skippedUpdateVersion: safeSkippedVersion(candidate.skippedUpdateVersion),
    hiddenProviders: hiddenProviders.length >= DEFAULT_PROVIDER_ORDER.length ? [] : hiddenProviders,
    collapsedProviders: providerList(candidate.collapsedProviders),
    layoutMode,
    compactLayout,
    expandedLayout,
    colorTheme,
    appearanceMode,
    fontScale: boundedFontScale(candidate.fontScale),
    personRingColors: Object.fromEntries(Object.entries(candidate.personRingColors && typeof candidate.personRingColors === "object" && !Array.isArray(candidate.personRingColors) ? candidate.personRingColors : {}).filter(([id, color]) => id.length > 0 && id.length <= 128 && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)).slice(0, 128)),
    riskFirst: booleanValue(candidate.riskFirst, DEFAULT_WIDGET_PREFERENCES.riskFirst),
    showHistorySparklines: booleanValue(candidate.showHistorySparklines, DEFAULT_WIDGET_PREFERENCES.showHistorySparklines),
    accentColor,
    alertThreshold: boundedInteger(candidate.alertThreshold, DEFAULT_WIDGET_PREFERENCES.alertThreshold, 1, 99),
    notificationsEnabled: booleanValue(candidate.notificationsEnabled, DEFAULT_WIDGET_PREFERENCES.notificationsEnabled),
    notifyOnReset: booleanValue(candidate.notifyOnReset, DEFAULT_WIDGET_PREFERENCES.notifyOnReset),
    notifyOnRecovery: booleanValue(candidate.notifyOnRecovery, DEFAULT_WIDGET_PREFERENCES.notifyOnRecovery),
    quietHoursStart: boundedInteger(candidate.quietHoursStart, DEFAULT_WIDGET_PREFERENCES.quietHoursStart, 0, 23),
    quietHoursEnd: boundedInteger(candidate.quietHoursEnd, DEFAULT_WIDGET_PREFERENCES.quietHoursEnd, 0, 23),
    notificationCooldownMinutes: boundedInteger(candidate.notificationCooldownMinutes, DEFAULT_WIDGET_PREFERENCES.notificationCooldownMinutes, 5, 1440),
    updateChannel: candidate.updateChannel === "stable" ? "stable" : candidate.updateChannel === "beta" ? "beta" : DEFAULT_WIDGET_PREFERENCES.updateChannel,
    automaticUpdates: booleanValue(candidate.automaticUpdates, DEFAULT_WIDGET_PREFERENCES.automaticUpdates),
  };
}

export function syncDailyBudgetToSuggestion(
  preferences: WidgetPreferences,
  usageDay: string,
  suggestedPercent: number,
): WidgetPreferences | null {
  if (!safeUsageDate(usageDay) || !Number.isFinite(suggestedPercent) || preferences.dailyBudgetLocalDate === usageDay) return null;
  return normalizeWidgetPreferences({
    ...preferences,
    dailyBudgetPercent: suggestedPercent,
    dailyBudgetLocalDate: usageDay,
  });
}
