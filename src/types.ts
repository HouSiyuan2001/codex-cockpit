export type ProviderId = "codex" | "qoder" | "trae" | "workbuddy" | "volcengine" | "antigravity";
export type SnapshotStatus = "ok" | "stale" | "loading" | "unavailable" | "signed_out";
export type Language = "zh-CN" | "en";
export type LayoutMode = "compact" | "standard" | "detailed";
export type CompactLayout = "float" | "ring" | "bar";
export type WindowCompactLayout = CompactLayout | "capsule";
export type ExpandedLayout = "dashboard" | "provider-bar" | "stacked";
export type ColorTheme = "aurora" | "graphite" | "paper";
export type AppearanceMode = "system" | "light" | "dark";
export type ResolvedAppearance = Exclude<AppearanceMode, "system">;
export type UpdateChannel = "stable" | "beta";

export const MAX_DAILY_OBSERVED_PERCENT = 10_000;

export interface UsageWindow {
  remainingPercent: number;
  resetsAt: string | null;
  windowSeconds: number;
}

export interface RateLimitSnapshot {
  source: "app-server" | "legacy-api";
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
  observedAt: string;
}

export interface ProviderSnapshot {
  provider: ProviderId;
  displayName: string;
  plan: string | null;
  shortWindow: UsageWindow | null;
  weeklyWindow: UsageWindow | null;
  monthlyWindow?: UsageWindow | null;
  resetCredits: number | null;
  resetCreditExpiresAt?: string[];
  balanceRemaining?: number | null;
  balanceUnit?: string | null;
  rateLimitSnapshot?: RateLimitSnapshot | null;
  updatedAt: string;
  status: SnapshotStatus;
  message: string | null;
}

export interface CodexDailyUsage {
  localDate: string;
  observedUsedPercent: number;
  sampleCount: number;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  coverage: "complete" | "partial" | "unavailable";
  source: "official-snapshot" | "codex-session-rate-limits";
}

export type ComfortCode = "overloaded" | "comfortable" | "idle";
export type ComfortUsageCoverage = "complete" | "partial" | "unavailable";
export type ComfortUsageSource = "official-snapshot" | "local-history" | "unavailable";

export interface ComfortTokenModelUsage {
  id: string;
  name: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Aggregate-only calendar-day usage captured for one stable Tokei group. */
export interface ComfortTokenSnapshot {
  localDate: string;
  observedAt: string;
  metricVersion: string;
  coverage: ComfortUsageCoverage;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  models: ComfortTokenModelUsage[];
  deviceIds: string[];
  missingDeviceIds: string[];
  incompleteDeviceIds: string[];
}

/** Estimated personal share of a shared daily quota, allocated by calendar-day cost. */
export interface ComfortQuotaAllocation {
  metricVersion: "cost-share-v1";
  localDate: string;
  observedAt: string;
  totalUsedPercent: number | null;
  personCostUsd: number | null;
  totalCostUsd: number | null;
  costShare: number | null;
  allocatedUsedPercent: number | null;
  coverage: ComfortUsageCoverage;
  deviceIds: string[];
  missingDeviceIds: string[];
}

export interface ComfortFeedbackRecord {
  localDate: string;
  observedAt: string;
  /** Last explicit edit/refresh; distinct from the original feedback time. */
  updatedAt?: string;
  comfort: ComfortCode;
  /** Stable Tokei group id. Missing/null is deliberately unassigned legacy data. */
  personId?: string | null;
  personName?: string | null;
  tokenSnapshot?: ComfortTokenSnapshot | null;
  quotaAllocation?: ComfortQuotaAllocation | null;
  observedUsedPercent: number | null;
  usageObservedAt: string | null;
  usageCoverage: ComfortUsageCoverage;
  usageSource: ComfortUsageSource;
  curveVersion: string;
}

export interface ComfortPrompt {
  localDate: string;
  isCatchUp: boolean;
  personId?: string | null;
  personName?: string | null;
  tokenSnapshot?: ComfortTokenSnapshot | null;
  quotaAllocation?: ComfortQuotaAllocation | null;
  observedUsedPercent: number | null;
  usageObservedAt: string | null;
  usageCoverage: ComfortUsageCoverage;
  usageSource: ComfortUsageSource;
}

export interface ComfortCurvePoint {
  usedPercent: number;
  baselineScore: number;
  personalizedScore: number;
}

export interface ComfortCurveObservation {
  localDate: string;
  usedPercent: number;
  comfort: ComfortCode;
  usageCoverage: Exclude<ComfortUsageCoverage, "unavailable">;
  fitWeight?: number;
}

export interface PersonalizedComfortCurve {
  curveVersion: string;
  baselineXStarPercent: number;
  xStarPercent: number;
  sampleCount: number;
  confidence: number;
  mode: "baseline-fallback" | "personalized";
  points: ComfortCurvePoint[];
  observations: ComfortCurveObservation[];
  recencyHalfLifeDays?: number;
  weightedSampleCount?: number;
}

export interface TokenComfortObservation {
  localDate: string;
  tokenMillions: number;
  comfort: ComfortCode;
  coverage: ComfortUsageCoverage;
  eligibleForFit: boolean;
}

export interface TokenComfortTrendPoint {
  tokenMillions: number;
  /** Ordinal subjective category: idle=0, comfortable=1, overloaded=2. */
  comfortScore: number;
  minTokenMillions: number;
  maxTokenMillions: number;
  sampleCount: number;
}

export interface TokenComfortModel {
  metricVersion: string;
  personId: string | null;
  mode: "scatter-only" | "empirical-fit";
  sampleCount: number;
  completeSampleCount: number;
  distinctTokenCount: number;
  observations: TokenComfortObservation[];
  trend: {
    method: "binned-ordinal-mean-v1";
    points: TokenComfortTrendPoint[];
  } | null;
}

export interface ResetWatch {
  level: "elevated" | "strong";
  resetChancePercent: number | null;
  observedAt: string;
  expiresAt: string;
}

/** Website community ballot, not a daily calibrated risk or official forecast. */
export interface WebsiteResetProbability extends ResetWatch {
  checkedAt: string;
  episodeId: string;
}

export interface ResetForecast {
  score: number;
  windowHours: number;
  fetchedAt: string;
  resetAnnounced: boolean;
  resetAt?: string | null;
  sourceUrl: string;
  activeWatch?: ResetWatch | null;
  watchCheckedAt?: string;
  tomorrowRiskPercent?: number;
  historySampleCount?: number;
  historyResetDates?: string[];
  riskFactors?: Array<{
    id: string;
    label: string;
    deltaPct: number;
    note: string;
  }>;
}

export type WidgetFontFamily = "codex" | "yahei" | "smiley";

export interface WidgetPreferences {
  codexFocusMode: boolean;
  dailyBudgetPercent: number;
  dailyBudgetLocalDate: string | null;
  resetRiskOverridePercent: number | null;
  resetRiskManualEnabled?: boolean;
  locked: boolean;
  alwaysOnTop: boolean;
  stayExpanded: boolean;
  pinnedProvider: ProviderId | null;
  providerOrder?: ProviderId[];
  autoRotateSeconds: number;
  language: Language;
  skippedUpdateVersion?: string | null;
  hiddenProviders: ProviderId[];
  collapsedProviders: ProviderId[];
  layoutMode: LayoutMode;
  compactLayout: CompactLayout;
  expandedLayout: ExpandedLayout;
  colorTheme: ColorTheme;
  appearanceMode: AppearanceMode;
  fontScale: number;
  fontFamily: WidgetFontFamily;
  personRingColors?: Record<string, string>;
  riskFirst: boolean;
  showHistorySparklines: boolean;
  accentColor: string;
  alertThreshold: number;
  notificationsEnabled: boolean;
  notifyOnReset: boolean;
  notifyOnRecovery: boolean;
  quietHoursStart: number;
  quietHoursEnd: number;
  notificationCooldownMinutes: number;
  updateChannel: UpdateChannel;
  automaticUpdates: boolean;
}

export type ActivityKind = "quota" | "reset" | "warning" | "recovered" | "update";

export interface ActivityEvent {
  id: string;
  provider: ProviderId | null;
  kind: ActivityKind;
  occurredAt: string;
  title: string;
  detail: string;
}

export interface QuotaHistoryPoint {
  provider: ProviderId;
  capturedAt: string;
  metric: number | null;
  metricKind: "percent" | "balance" | "unlimited" | "none";
  status: SnapshotStatus;
  resetsAt: string | null;
}

export interface DailyUsageSummary {
  provider: ProviderId;
  localDate: string;
  observedUsedPercent: number;
  sampleCount: number;
  updatedAt: string;
}

export interface SavedLayout {
  id: string;
  name: string;
  createdAt: string;
  providerOrder: ProviderId[];
  hiddenProviders: ProviderId[];
  collapsedProviders: ProviderId[];
  layoutMode: LayoutMode;
  compactLayout: CompactLayout;
  expandedLayout: ExpandedLayout;
  colorTheme: ColorTheme;
  appearanceMode: AppearanceMode;
  riskFirst: boolean;
  showHistorySparklines: boolean;
  accentColor: string;
}

export interface DailyPaceBaseline {
  provider: ProviderId;
  period: "5h" | "weekly" | "monthly";
  localDate: string;
  capturedAt: string;
  remainingPercent: number;
  resetsAt: string;
  cycleStartedAt: string;
  cycleStartRemainingPercent: number;
  planningResetsAt: string;
  resetForecastScore: number | null;
  resetForecastWindowHours: number | null;
}

export interface DailyRecommendationRecord {
  provider: ProviderId;
  localDate: string;
  targetPercent: number;
  safetyCapPercent: number;
  resetRiskPercent: number;
  fatigueKneePercent: number;
  carryInPercent: number;
  policyVersion: string;
  updatedAt: string;
}

export interface RuntimeState {
  schemaVersion: 1;
  history: QuotaHistoryPoint[];
  dailyUsage: DailyUsageSummary[];
  comfortFeedback: ComfortFeedbackRecord[];
  comfortPromptedDates: string[];
  comfortPersonId?: string | null;
  events: ActivityEvent[];
  savedLayouts: SavedLayout[];
  lastNotifications: Record<string, string>;
  dailyPaceBaselines: Record<string, DailyPaceBaseline>;
  dailyRecommendations: DailyRecommendationRecord[];
}

export interface AppDiagnostics {
  appVersion: string;
  platform: string;
  configDirectory: string;
  preferencesBackupAvailable: boolean;
  runtimeBackupAvailable: boolean;
}

export interface VolcengineDiagnostics {
  installed: boolean;
  executablePath: string | null;
  executableSource: string | null;
  stalePath: boolean;
  cliVersion: string | null;
  authenticated: boolean;
  authMethod: string | null;
  profileName: string | null;
  profileType: string | null;
  profileRegion: string | null;
  recommendedProfile: boolean;
  lastError: string | null;
}
