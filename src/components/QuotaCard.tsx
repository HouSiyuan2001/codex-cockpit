import { ClaudeConnectionIndicator } from "./ClaudeConnectionIndicator";
import { useCapsuleGlass } from "../hooks/useCapsuleGlass";
import type { useSharedClaudeQuota } from "../hooks/useClaudeUsage";
import { USAGE_TIME_ZONE } from "../lib/usageDay";
import { ArrowClockwise, ArrowsInSimple, ArrowsOutSimple, Bell, CaretRight, CheckCircle, ClockCounterClockwise, CloudArrowDown, CloudSlash, DotsSixVertical, Gauge, GearSix, Pulse, PushPin, PushPinSlash, SignIn, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { memo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { clampPercent, formatDateTime, formatResetDate, formatResetTime, quotaTier } from "../lib/format";
import { copy, normalizeLanguage, resetForecastLabel, resetForecastTitle } from "../lib/i18n";
import { useModalDialog } from "../lib/modalDialog";
import { activeManualResetRisk, planDateKey } from "../lib/personPlanSync";
import { useRingReadoutFit } from "../lib/useRingReadoutFit";
import { normalizeProviderOrder, PROVIDER_CATALOG, type ProviderDefinition } from "../lib/providers";
import { recentPercentageHistory, sortProviderIdsByRisk } from "../lib/providerPresentation";
import { calculateQuotaPace, paceBaselineKey, trackedQuotaWindows, type NamedQuotaWindow, type QuotaPace, type QuotaPeriod } from "../lib/quotaPace";
import type { DailyRecommendation } from "../lib/dynamicQuota";
import type { PersonalUsageCalibration } from "../lib/personalUsageModel";
import type { RecentCodexReset } from "../lib/resetDetection";
import { buildTodayQuotaAdvice, dailyUsageRatio, type TodayQuotaAdvice } from "../lib/todayQuota";
import type { CapsuleCorner, CockpitMode, CodexDailyUsage, ColorTheme, ComfortCode, ComfortPrompt, DailyPaceBaseline, DailyUsageSummary, GeminiQuota, Language, ProviderId, ProviderSnapshot, QuotaHistoryPoint, ResetForecast, ResolvedAppearance, VolcengineDiagnostics, WidgetPreferences, WindowCompactLayout } from "../types";
import { ComfortFeedbackPanel } from "./ComfortFeedbackPanel";
import { CockpitBrandMark, CockpitModeSwitch, cockpitTitle } from "./ClaudeCockpit";
import { claudeQuotaMessage, type ClaudeCockpitView } from "../lib/claudeCockpit";
import type { CapsulePointerDrag } from "../lib/bridge";
import { capsuleCellLogicalWidth, compactPercentLabel as compactPercent, effectiveCockpitMode, enabledCockpitModes, enabledProviderFlags, geminiCornerPlacement, geminiFiveHourUsedPercent, resolveCapsuleLayout, type GeminiCockpitView, type GeminiWindowView } from "../lib/geminiCockpit";
import { ProviderMark } from "./ProviderMark";
import { ProviderLogoSlider } from "./ProviderLogoSlider";
import { RangeSlider } from "./RangeSlider";
import { EMPTY_UPDATE_STATE, UpdatePanel, type UpdateViewState } from "./UpdatePanel";
import { UsageInsightsPanel } from "./UsageInsightsPanel";
import { ResetWatchBell } from "./ResetWatchBell";
import { resetWatchLabel } from "../lib/resetWatch";
import { isCodexPlus, fiveHourRemaining, fiveHourWindow } from "../lib/plusQuota";
import type { ResetWatch } from "../types";

import { PersonCostArcs, PersonCostBar } from "./PersonCostRing";
import type { DailyPersonCosts } from "../lib/dailyPersonCosts";

const GEMINI_SHARED_POOL_LABEL = "Gemini · Claude / GPT";

type ResetRiskSource = "website" | "manual" | "history" | "fallback" | "scheduled-only";

interface Props {
  snapshot: ProviderSnapshot;
  snapshots: ProviderSnapshot[];
  preferences: WidgetPreferences;
  sharedBudgetPercent?: number;
  codexDailyUsage?: CodexDailyUsage | null;
  dailyPersonCosts?: DailyPersonCosts;
  dailyRecommendation?: DailyRecommendation | null;
  personalUsageCalibration?: PersonalUsageCalibration | null;
  comfortPrompt?: ComfortPrompt | null;
  comfortSaving?: boolean;
  comfortSaveError?: string | null;
  onComfortSelect?: (comfort: ComfortCode) => void;
  claudeView?: ClaudeCockpitView | null;
  claudeShared?: ReturnType<typeof useSharedClaudeQuota>;
  geminiView?: GeminiCockpitView | null;
  capsuleCorner?: CapsuleCorner;
  now?: Date;
  onCockpitModeChange?: (mode: CockpitMode) => void;
  onDailyBudgetChange?: (value: number) => void;
  onResetRiskChange?: (value: number | null) => void;
  onResetDailyBudget?: () => void;
  onSliderInteraction?: (active: boolean) => void;
  resolvedAppearance?: ResolvedAppearance;
  onSelectProvider: (provider: ProviderId) => void;
  onReorderProviders?: (order: ProviderId[]) => void;
  onLock: () => void;
  onToggleStayExpanded?: () => void;
  onLanguage: () => void;
  onDrag: () => void;
  onHover: (hovered: boolean) => void;
  onRefresh?: () => void;
  onClaudeLogin?: () => void;
  claudeLogin?: { pending: boolean; error: string | null };
  onDiagnostics?: () => void;
  onCloseDiagnostics?: () => void;
  onReconnect?: () => void;
  diagnostics?: VolcengineDiagnostics | null;
  diagnosticsOpen?: boolean;
  diagnosticsLoading?: boolean;
  reconnecting?: boolean;
  recentCodexReset?: RecentCodexReset | null;
  resetWatch?: ResetWatch | null;
  resetRiskSource?: ResetRiskSource;
  resetForecast?: ResetForecast | null;
  onOpenResetForecast?: (url: string) => void;
  paceBaselines?: Record<string, DailyPaceBaseline>;
  history?: QuotaHistoryPoint[];
  dailyUsage?: DailyUsageSummary[];
  updateState?: UpdateViewState;
  updateOpen?: boolean;
  onUpdateOpen?: () => void;
  onUpdateClose?: () => void;
  onUpdateDownload?: () => void;
  onUpdateInstall?: () => void;
  onUpdateRetry?: () => void;
  onUpdateLater?: () => void;
  onUpdateSkip?: () => void;
  onUpdateRelease?: () => void;
  isConsuming?: boolean;
  consumingProviders: ReadonlySet<string>;
  notice?: ReactNode;
  controlCenter?: ReactNode;
  controlOpen?: boolean;
  onControlOpen?: () => void;
  initialShowCreditTip?: boolean;
  initialInsightsOpen?: boolean;
}

function StatusIcon({ status, expired = false }: { status: ProviderSnapshot["status"]; expired?: boolean }) {
  if (status === "signed_out") return <SignIn weight="duotone" />;
  if (status === "stale" || expired) return <ClockCounterClockwise weight="duotone" />;
  if (status === "unavailable") return <CloudSlash weight="duotone" />;
  return <WarningCircle weight="duotone" />;
}

function quotaAvailableLabel(period: QuotaPeriod, remaining: number, language: Language): string {
  const t = copy[language];
  if (period === "weekly") return t.availableLabel(remaining);
  const label = period === "5h" ? t.fiveHourShort : t.monthlyShort;
  return language === "en"
    ? `${label} quota remaining ${remaining}%`
    : `${label}剩余 ${remaining}%`;
}

function focusResetDate(value: string | null, language: Language): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    timeZone: USAGE_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function QuotaResetRow({ label, resetsAt, now, language, awaitingRefresh, unknownLabel }: {
  label: string;
  resetsAt: string | null;
  now: Date;
  language: Language;
  awaitingRefresh?: boolean;
  unknownLabel?: string;
}) {
  const resetMs = Date.parse(resetsAt ?? "");
  const known = resetsAt !== null && Number.isFinite(resetMs);
  const pending = awaitingRefresh || (known && resetMs <= now.getTime());
  return (
    <span>
      {label}{" "}
      <strong>
        {pending ? (language === "en" ? "Pending" : "待更新") : known ? (
          <time dateTime={resetsAt} title={`${focusResetDate(resetsAt, language)} ${language === "en" ? "Beijing time" : "北京时间"}`}>
            {compactResetTime(resetsAt, now, language)}
          </time>
        ) : <span title={copy[language].resetTimeUnknown}>{unknownLabel ?? (language === "en" ? "Unknown" : "未知")}</span>}
      </strong>
    </span>
  );
}

function QuotaPaceHint({ pace, language, provider }: { pace: QuotaPace; language: Language; provider: ProviderId }) {
  const t = copy[language];
  const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
  const statusLabel = pace.status === "on_track" ? t.onTrack : pace.status === "over_pace" ? t.overPaceBy(number.format(pace.overByPercent)) : t.paceUnknown;
  const unit = pace.unit === "hour" ? t.hourUnit : t.dayUnit;
  return (
    <div className={`quota-pace-hint quota-pace-hint--${pace.status}`} role="status">
      <span>
        {pace.status === "on_track" ? <CheckCircle weight="fill" /> : pace.status === "over_pace" ? <WarningCircle weight="fill" /> : <ClockCounterClockwise />}
        {statusLabel}
      </span>
      <div className="quota-pace-copy">
        {provider === "codex" ? <small className="quota-pace-used">{t.usedSinceReset(number.format(pace.todayUsedPercent))}</small> : null}
        {pace.todayRemainingPercent !== null ? <small className="quota-pace-today">{t.todayPlannedRemaining(number.format(pace.todayRemainingPercent))}</small> : null}
        <small>{t.averageSuggested(number.format(pace.averageRate), unit)}</small>
      </div>
    </div>
  );
}

function TodayQuotaAdvicePanel({
  advice,
  language,
  riskSource,
  websiteRisk,
  onRiskChange,
  onInteractionChange,
}: {
  advice: TodayQuotaAdvice;
  language: Language;
  riskSource: ResetRiskSource;
  websiteRisk: number | null;
  onRiskChange: (value: number | null) => void;
  onInteractionChange: (active: boolean) => void;
}) {
  const t = copy[language];
  const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
  const sourceLabel = advice.source === "app-server"
    ? t.officialSourceAppServer
    : advice.source === "legacy-api"
      ? t.officialSourceLegacy
      : advice.source === "local-session"
        ? t.officialSourceLocal
        : "—";
  const stateLabel = advice.state === "live"
    ? t.officialFresh
    : advice.state === "stale"
      ? t.officialStale
      : advice.state === "missing"
        ? t.officialMissing
        : sourceLabel;
  const display = (value: number | null) => value === null ? "—" : `${number.format(value)}%`;
  const english = language === "en";
  const followsWebsite = riskSource === "website";
  const riskPercent = followsWebsite ? websiteRisk ?? advice.resetRiskPercent : advice.resetRiskPercent;
  const riskLabel = english ? "Reset risk" : "重置风险";
  const riskSourceLabel = (english
    ? { website: "Website", manual: "Manual", history: "History", fallback: null, "scheduled-only": null }
    : { website: "网站", manual: "手动", history: "历史", fallback: null, "scheduled-only": null })[riskSource];
  const riskHint = {
    website: english ? "Current Codex Resets watch." : "Codex Resets 当前预警。",
    manual: undefined,
    "scheduled-only": english ? "The plan uses your scheduled weekly reset." : "按账户的周重置时间安排用量。",
    history: english
      ? "24-hour planning estimate based on recent resets that immediately refilled quota."
      : "按近期直接补充额度的重置记录估算未来 24 小时的风险。",
    fallback: english
      ? "Using the default planning reference until enough reset records are available."
      : "重置记录不足时使用默认规划参考值。",
  }[riskSource];
  const restoreLabel = english ? "Restore automatic risk estimate" : "恢复自动风险估算";
  return (
    <section className={`today-quota-advice today-quota-advice--${advice.state}`} aria-label={t.officialSnapshot}>
      <header>
        <strong>{t.officialSnapshot}</strong>
        <small>{stateLabel}</small>
      </header>
      <div className="today-quota-advice-grid">
        <div><span>{language === "en" ? "Suggested day total" : "今日总建议"}</span><strong>{display(advice.todaySuggestedPercent)}</strong></div>
        <div><span>{t.todayUsed}</span><strong>{display(advice.todayUsedPercent)}</strong></div>
        <div className="today-quota-advice-risk" title={riskHint}>
          <span>{riskLabel}{riskSourceLabel ? ` · ${riskSourceLabel}` : ""}</span>
          <div className="reset-risk-value">
            <strong>{display(riskPercent)}</strong>
            <button type="button" aria-label={restoreLabel} title={restoreLabel} disabled={followsWebsite} onClick={() => onRiskChange(null)}><ArrowClockwise /></button>
          </div>
          <RangeSlider aria-label={riskLabel} min={0} max={100} step={1} value={riskPercent ?? 0} disabled={followsWebsite} onChange={(event) => onRiskChange(Number(event.target.value))} onInteractionChange={onInteractionChange} />
        </div>
      </div>
    </section>
  );
}

function DailyQuotaControl({ language, cap, suggested, onChange, onReset, onInteractionChange, min = 1 }: {
  language: Language; cap: number | null; suggested: number | null; min?: number;
  onChange: (value: number) => void; onReset: () => void; onInteractionChange: (active: boolean) => void;
}) {
  const id = useId();
  const label = language === "en" ? "Personal cap" : "个人上限";
  const restore = copy[language].restoreDailyBudget;
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const display = (value: number | null) => value === null ? "—" : `${number.format(value)}%`;
  return <div className="daily-budget-control" onMouseDown={(event) => event.stopPropagation()}>
    <div className="daily-budget-heading">
      <label htmlFor={id}><span>{label}</span><output>{display(cap)}</output></label>
      <button type="button" className="daily-budget-refresh" onClick={onReset} disabled={suggested === null} aria-label={restore} title={restore}>
        <ArrowClockwise weight="bold" />
      </button>
    </div>
    <small className="daily-budget-recommendation"><span>{language === "en" ? "Day total" : "今日总建议"} {display(suggested)}</span></small>
    <RangeSlider id={id} min={min} max={100} step="0.1" value={cap ?? min} aria-label={label} disabled={cap === null}
      onChange={(event) => onChange(Number(event.target.value))} onInteractionChange={onInteractionChange} />
  </div>;
}

export function QuotaRing({ label, value, progress, tone, caption, detail, footer, overPace = false, innerProgress, personCosts, variant, badge, badgeTitle }: {
  label: string;
  value: string;
  progress: number;
  tone: "weekly" | "daily";
  caption?: string;
  detail?: string;
  footer?: ReactNode;
  overPace?: boolean;
  innerProgress?: number | null;
  personCosts?: DailyPersonCosts;
  variant?: "claude" | "gemini-short" | "gemini-weekly" | "gemini-shared";
  badge?: ReactNode;
  badgeTitle?: string;
}) {
  const compactDecimal = variant === "gemini-short" || variant === "gemini-weekly";
  const decimalIndex = compactDecimal ? value.indexOf(".") : -1;
  const readoutRef = useRef<HTMLDivElement>(null);
  // The compact decimal uses a tighter line box, so the measured box can sit closer to the ring.
  useRingReadoutFit(readoutRef, value, innerProgress !== undefined, decimalIndex >= 0 ? 2 : undefined);
  const safeProgress = Math.max(0, Math.min(100, progress));
  const weeklyBand = tone === "weekly"
    ? safeProgress >= 50 ? "high" : safeProgress >= 20 ? "mid" : "low"
    : null;
  const dailyBand = tone === "daily"
    ? progress > 100 ? "over" : progress >= 80 ? "warning" : null
    : null;
  return (
    <section className={`codex-ring-card codex-ring-card--${tone}${weeklyBand ? ` codex-ring-card--quota-${weeklyBand}` : ""}${dailyBand ? ` codex-ring-card--daily-${dailyBand}` : ""}${overPace ? " codex-ring-card--over_pace" : ""}${variant ? ` codex-ring-card--${variant}` : ""}`} role="group" aria-label={value === "—" ? label : `${label} ${value}%`}>
      <header className="codex-ring-header">
        <span><i aria-hidden="true" />{label}</span>
        <small title={badgeTitle}>{badge ?? (tone === "weekly" ? "LIVE" : "PLAN")}</small>
      </header>
      <div className={`codex-ring-visual${innerProgress !== undefined ? " codex-ring-visual--dual" : ""}`}>
        <svg viewBox="0 0 140 140" aria-hidden="true">
          <circle className="codex-ring-track" cx="70" cy="70" r="53" pathLength="100" />
          {personCosts ? <PersonCostArcs data={personCosts} progress={safeProgress} /> : <circle className="codex-ring-progress" cx="70" cy="70" r="53" pathLength="100" strokeDasharray={`${safeProgress} ${100 - safeProgress}`} />}
          {innerProgress !== undefined ? <>
            <circle className="codex-ring-track" cx="70" cy="70" r="42" pathLength="100" />
            <circle className="codex-ring-progress codex-ring-progress--five-hour" cx="70" cy="70" r="42" pathLength="100" strokeDasharray={`${innerProgress ?? 0} ${100 - (innerProgress ?? 0)}`} />
          </> : null}
        </svg>
        <div className="codex-ring-value" ref={readoutRef}>
          <strong>{decimalIndex < 0 ? value : <>{value.slice(0, decimalIndex)}<small>{value.slice(decimalIndex)}</small></>}</strong>
          {value === "—" ? null : <span>%</span>}
        </div>
      </div>
      {caption || detail ? <div className="codex-ring-caption">{caption ? <span>{caption}</span> : null}{detail ? <strong>{detail}</strong> : null}</div> : null}
      {footer ? <footer className="codex-ring-footer">{footer}</footer> : null}
    </section>
  );
}

export function GeminiQuotaCard({ view, language, now }: { view: GeminiCockpitView; language: Language; now: Date }) {
  const english = language === "en";
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const pendingBadge = view.sourceDevice
    ? (english ? "SYNC" : "同步")
    : english ? "STALE" : "待更新";
  const weeklyLabel = english ? "Weekly remaining" : "本周剩余";
  const weeklyResetLabel = english ? "Weekly reset" : "周重置";
  const fiveHourResetLabel = english ? "5h reset" : "5h 重置";
  const renderGeminiPool = (label: string, short: GeminiWindowView, week: GeminiWindowView, variant: "gemini-short" | "gemini-weekly") => {
    const primary = week.remaining ?? short.remaining;
    const awaiting = short.awaitingRefresh || week.awaitingRefresh;
    const badge = awaiting || (view.quotaStatus === "stale" && primary !== null) ? pendingBadge : primary === null ? "—" : undefined;
    const percent = (value: number | null) => value === null ? "—" : `${number.format(value)}%`;
    return <QuotaRing
      label={label}
      value={primary === null ? "—" : number.format(primary)}
      progress={week.remaining ?? 0}
      innerProgress={short.remaining ?? undefined}
      tone="weekly"
      variant={variant}
      badge={badge}
      badgeTitle={view.sourceDevice}
      footer={(
        <div className="weekly-reset-footer reset-countdown-footer">
          <span>{weeklyLabel} <strong>{percent(week.remaining)}</strong></span>
          <QuotaResetRow label={weeklyResetLabel} resetsAt={week.resetsAt} awaitingRefresh={week.awaitingRefresh} now={now} language={language} unknownLabel="—" />
          <span>{english ? "5h remaining" : "5 小时剩余"} <strong>{percent(short.remaining)}</strong></span>
          <QuotaResetRow label={fiveHourResetLabel} resetsAt={short.resetsAt} awaitingRefresh={short.awaitingRefresh} now={now} language={language} unknownLabel="—" />
        </div>
      )}
    />;
  };
  return (
    <section className="codex-ring-card gemini-quota-card" aria-label={english ? "Gemini quotas" : "Gemini 额度"}>
      {renderGeminiPool("Gemini", view.geminiFiveHour, view.geminiWeekly, "gemini-short")}
      {renderGeminiPool(GEMINI_SHARED_POOL_LABEL, view.sharedFiveHour, view.sharedWeekly, "gemini-weekly")}
    </section>
  );
}

export function ClaudeQuotaCards({ view, language, now, connection }: {
  view: ClaudeCockpitView;
  language: Language;
  now: Date;
  connection?: ReactNode;
}) {
  const english = language === "en";
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const display = (value: number | null) => value === null ? "—" : number.format(value);
  const complement = (value: number | null) => value === null ? "—" : `${number.format(100 - value)}%`;
  const badge = (value: number | null) => value === null ? "—" : view.quotaStatus === "ok" ? undefined : english ? "STALE" : "待更新";
  return (
    <div className="codex-focus-ring-grid">
      <QuotaRing label={english ? "Weekly remaining" : "本周剩余"} value={display(view.weeklyRemaining)}
        progress={view.weeklyRemaining ?? 0} tone="weekly" variant="claude" badge={connection ?? badge(view.weeklyRemaining)}
        footer={<div className="weekly-reset-footer reset-countdown-footer">
          <span>{english ? "Weekly used" : "本周已用"} <strong>{complement(view.weeklyRemaining)}</strong></span>
          <QuotaResetRow label={english ? "Weekly reset" : "周重置"} resetsAt={view.weeklyResetsAt} now={now} language={language} />
          {view.opusWeeklyRemaining !== null ? <span>Opus <strong>{display(view.opusWeeklyRemaining)}%</strong></span> : null}
        </div>} />
      <QuotaRing label={english ? "5h used" : "5h 已用"} value={display(view.fiveHourUsed)}
        progress={view.fiveHourUsed ?? 0} tone="weekly" variant="claude"
        badge={view.fiveHourAwaitingRefresh ? (english ? "STALE" : "待更新") : badge(view.fiveHourUsed)}
        footer={<div className="weekly-reset-footer reset-countdown-footer">
          <span>{english ? "5h remaining" : "5h 剩余"} <strong>{complement(view.fiveHourUsed)}</strong></span>
          <QuotaResetRow label={english ? "5h reset" : "5h 重置"} resetsAt={view.fiveHourResetsAt} now={now} language={language} awaitingRefresh={view.fiveHourAwaitingRefresh} />
        </div>} />
    </div>
  );
}

function ProviderHistorySparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="provider-history provider-history--empty" aria-hidden="true" />;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 44;
    const y = 15 - (value / 100) * 14;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `M 0 16 L ${points.replaceAll(" ", " L ")} L 44 16 Z`;
  return (
    <svg className="provider-history" viewBox="0 0 44 16" preserveAspectRatio="none" aria-hidden="true">
      <path d={area} />
      <polyline points={points} />
    </svg>
  );
}

function QuotaWindowList({ windows, provider, language, paceBaselines }: { windows: NamedQuotaWindow[]; provider: ProviderId; language: Language; paceBaselines: Record<string, DailyPaceBaseline> }) {
  const t = copy[language];
  const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
  const labels: Record<QuotaPeriod, string> = {
    "5h": t.fiveHourShort,
    weekly: t.weeklyShort,
    monthly: t.monthlyShort,
  };
  return (
    <section className="quota-window-list" aria-label={t.quotaWindows}>
      {windows.map(({ period, window }) => {
        const remaining = clampPercent(window.remainingPercent);
        const pace = calculateQuotaPace(window, new Date(), paceBaselines[paceBaselineKey(provider, period)] ?? null);
        const statusLabel = pace.status === "on_track" ? t.onTrack : pace.status === "over_pace" ? t.overPaceBy(number.format(pace.overByPercent)) : t.paceUnknown;
        const unit = pace.unit === "hour" ? t.hourUnit : t.dayUnit;
        return (
          <article className={`quota-window quota-window--${pace.status}`} key={period}>
            <header>
              <strong>{labels[period]}</strong>
              <span>{remaining}%</span>
              <em>
                {pace.status === "on_track" ? <CheckCircle weight="fill" /> : pace.status === "over_pace" ? <WarningCircle weight="fill" /> : <ClockCounterClockwise />}
                {statusLabel}
              </em>
            </header>
            <div className="quota-window-progress" role="progressbar" aria-label={`${labels[period]} ${remaining}%`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining}>
              <span style={{ width: `${remaining}%` }} />
            </div>
            <footer>
              {pace.todayRemainingPercent !== null ? <span className="quota-pace-today">{t.todayPlannedRemaining(number.format(pace.todayRemainingPercent))}</span> : null}
              <span>{t.averageSuggested(number.format(pace.averageRate), unit)}</span>
              <span>{formatResetTime(window.resetsAt, new Date(), language)}</span>
            </footer>
          </article>
        );
      })}
    </section>
  );
}

function localizedBackendMessage(message: string | null, language: Language, provider = "Volcengine"): string | null {
  if (!message) return null;
  if (language === "en") return message;
  const normalized = message.toLowerCase();
  if (normalized.includes("sign in") || normalized.includes("login") || normalized.includes("reconnect")) return `${provider} 登录已失效，请重新连接。`;
  if (normalized.includes("rate limited")) return "请求过于频繁，将稍后自动重试。";
  if (normalized.includes("network")) return "网络不可用，将自动重试。";
  if (normalized.includes("format")) return "额度响应格式已变化。";
  if (normalized.includes("missing the weekly")) return "额度响应缺少每周窗口。";
  if (normalized.includes("refresh is already running")) return "额度正在刷新，请稍候。";
  return message;
}

function ProviderLedgerRow({
  definition,
  snapshot,
  selected,
  consuming,
  language,
  onSelect,
  sortable,
  dragging,
  dragTarget,
  dragAfter,
  onReorderPointerDown,
  onReorderPointerMove,
  onReorderPointerUp,
  onReorderPointerCancel,
  onMove,
  condensed,
  history,
  showHistory,
  preferRisk,
}: {
  definition: ProviderDefinition;
  snapshot?: ProviderSnapshot;
  selected: boolean;
  consuming: boolean;
  language: Language;
  onSelect: (provider: ProviderId) => void;
  sortable: boolean;
  dragging: boolean;
  dragTarget: boolean;
  dragAfter: boolean;
  onReorderPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, provider: ProviderId) => void;
  onReorderPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onReorderPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onReorderPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onMove: (provider: ProviderId, offset: -1 | 1) => void;
  condensed: boolean;
  history: number[];
  showHistory: boolean;
  preferRisk: boolean;
}) {
  const t = copy[language];
  const riskWindow = snapshot
    ? trackedQuotaWindows(snapshot).sort((left, right) => left.window.remainingPercent - right.window.remainingPercent)[0] ?? null
    : null;
  const quotaWindow = preferRisk && riskWindow
    ? { label: riskWindow.period === "weekly" ? t.weeklyShort : riskWindow.period === "5h" ? t.fiveHourShort : t.monthlyShort, window: riskWindow.window }
    : snapshot?.weeklyWindow
    ? { label: t.weeklyShort, window: snapshot.weeklyWindow }
    : snapshot?.shortWindow
      ? { label: t.fiveHourShort, window: snapshot.shortWindow }
      : snapshot?.monthlyWindow
        ? { label: t.monthlyShort, window: snapshot.monthlyWindow }
        : null;
  const remaining = quotaWindow ? clampPercent(quotaWindow.window.remainingPercent) : null;
  const balance = snapshot?.balanceRemaining ?? null;
  const unlimited = snapshot?.balanceUnit === "unlimited";
  const unlimitedLabel = language === "en" ? "Unlimited" : "不限量";
  const value = unlimited
    ? "∞"
    : remaining !== null
    ? `${remaining}%`
    : balance !== null
      ? new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 }).format(balance)
      : "--";
  const detail = !snapshot
    ? t.notDetected
    : consuming
      ? t.active
      : snapshot.status === "stale"
        ? t.dataStale
        : snapshot.status === "signed_out"
          ? t.notSignedIn
            : snapshot.status !== "ok"
              ? t.temporarilyUnavailable
            : unlimited
              ? unlimitedLabel
            : quotaWindow
              ? `${quotaWindow.label} · ${formatResetDate(quotaWindow.window.resetsAt, language)}`
              : snapshot.balanceUnit ?? t.balanceRemaining;

  return (
    <div
      className={`provider-row-shell${dragging ? " is-dragging" : ""}${dragTarget ? ` is-drag-target ${dragAfter ? "is-drag-after" : "is-drag-before"}` : ""}${condensed ? " is-condensed" : ""}${sortable ? "" : " is-fixed"}`}
      data-provider-id={definition.id}
      role="listitem"
      tabIndex={sortable ? 0 : -1}
      aria-label={sortable ? t.reorderProvider(definition.label) : undefined}
      title={sortable ? t.reorderProvider(definition.label) : undefined}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (!sortable || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        event.stopPropagation();
        onMove(definition.id, event.key === "ArrowUp" ? -1 : 1);
      }}
    >
      <button
        type="button"
        className={`provider-row${selected ? " is-selected" : ""}${consuming ? " is-consuming" : ""}${showHistory ? " has-history" : ""}`}
        onClick={() => onSelect(definition.id)}
        disabled={!snapshot}
        aria-pressed={selected}
      >
        <ProviderMark provider={definition.id} label={definition.label} />
        <span className="provider-identity">
          <strong>{definition.label}</strong>
          <small>{snapshot?.plan ?? ""}</small>
        </span>
        {showHistory ? <ProviderHistorySparkline values={history} /> : null}
        <span className="provider-value">
          <strong>{value}</strong>
          <small>{detail}</small>
        </span>
      </button>
      {sortable ? (
        <button
          type="button"
          className="provider-reorder-grip"
          aria-label={t.reorderProvider(definition.label)}
          title={t.reorderProvider(definition.label)}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => onReorderPointerDown(event, definition.id)}
          onPointerMove={onReorderPointerMove}
          onPointerUp={onReorderPointerUp}
          onPointerCancel={onReorderPointerCancel}
        >
          <DotsSixVertical weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

function VolcengineDiagnosticsPanel({
  value,
  language,
  loading,
  reconnecting,
  onClose,
  onReconnect,
}: {
  value: VolcengineDiagnostics | null;
  language: Language;
  loading: boolean;
  reconnecting: boolean;
  onClose: () => void;
  onReconnect: () => void;
}) {
  const dialogRef = useModalDialog<HTMLElement>(onClose);
  const t = copy[language];
  const healthy = Boolean(
    value?.installed
    && value.authenticated
    && value.recommendedProfile
    && !value.stalePath
    && !value.lastError,
  );

  return (
    <section
      ref={dialogRef}
      className="diagnostics-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="volcengine-diagnostics-title"
      tabIndex={-1}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className="diagnostics-header">
        <div>
          <p className="diagnostics-kicker">VOLCENGINE · PREFLIGHT</p>
          <h2 id="volcengine-diagnostics-title">{t.diagnosticsTitle}</h2>
          <p>{t.diagnosticsSubtitle}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t.closeDiagnostics} title={t.closeDiagnostics} data-dialog-initial-focus><X /></button>
      </header>

      {loading && !value ? (
        <div className="diagnostics-loading" role="status"><SpinnerGap /><span>{t.diagnosticsLoading}</span></div>
      ) : value ? (
        <>
          <div className="diagnostics-body">
            <div className={`diagnostics-health${healthy ? " is-healthy" : " is-attention"}`}>
              {healthy ? <CheckCircle weight="duotone" /> : <WarningCircle weight="duotone" />}
              <strong>{healthy ? t.diagnosticsHealthy : t.diagnosticsAttention}</strong>
              <small>{value.cliVersion ?? t.cliMissing}</small>
            </div>
            <dl className="diagnostics-grid">
              <div><dt>{t.cliStatus}</dt><dd>{value.installed ? t.cliInstalled : t.cliMissing}</dd></div>
              <div><dt>{t.authentication}</dt><dd>{value.authenticated ? `${t.signedIn}${value.authMethod ? ` · ${value.authMethod}` : ""}` : t.signedOut}</dd></div>
              <div><dt>{t.profile}</dt><dd title={value.profileName ?? undefined}>{value.profileName ?? "—"}</dd></div>
              <div><dt>{t.region}</dt><dd>{value.profileRegion ?? "—"}</dd></div>
              <div className="diagnostics-wide"><dt>{t.executable}</dt><dd title={value.executablePath ?? undefined}>{value.executablePath ?? "—"}{value.executableSource ? ` · ${value.executableSource}` : ""}</dd></div>
              <div className="diagnostics-wide"><dt>{t.lastError}</dt><dd title={value.lastError ?? undefined}>{value.lastError ?? t.noLastError}</dd></div>
            </dl>
          </div>
          <footer className="diagnostics-footer">
            <p className={value.stalePath || !value.recommendedProfile ? "diagnostics-hint is-warning" : "diagnostics-hint"}>
              {value.stalePath ? t.pathFallback : value.recommendedProfile ? t.recommendedProfile : t.profileWarning}
            </p>
            <button type="button" className="diagnostics-reconnect" onClick={onReconnect} disabled={reconnecting || !value.installed}>
              {reconnecting ? <SpinnerGap /> : <SignIn />}
              <span>{reconnecting ? t.reconnecting : t.reconnect}</span>
            </button>
          </footer>
        </>
      ) : (
        <div className="diagnostics-loading" role="status"><WarningCircle /><span>{t.errorUnavailable}</span></div>
      )}
    </section>
  );
}

export const QuotaCard = memo(function QuotaCard({
  snapshot,
  snapshots,
  preferences,
  sharedBudgetPercent,
  codexDailyUsage = null,
  dailyPersonCosts,
  dailyRecommendation = null,
  personalUsageCalibration = null,
  comfortPrompt = null,
  comfortSaving = false,
  comfortSaveError = null,
  onComfortSelect = () => undefined,
  claudeView = null,
  claudeShared,
  geminiView = null,
  capsuleCorner = "right-bottom",
  now = new Date(),
  onCockpitModeChange = () => undefined,
  onDailyBudgetChange = () => undefined,
  onResetRiskChange = () => undefined,
  onResetDailyBudget = () => undefined,
  onSliderInteraction = () => undefined,
  resolvedAppearance = "light",
  onSelectProvider,
  onReorderProviders = () => undefined,
  onLock,
  onToggleStayExpanded = () => undefined,
  onLanguage,
  onDrag,
  onHover,
  onRefresh,
  onClaudeLogin,
  claudeLogin,
  onDiagnostics = () => undefined,
  onCloseDiagnostics = () => undefined,
  onReconnect = () => undefined,
  diagnostics = null,
  diagnosticsOpen = false,
  diagnosticsLoading = false,
  reconnecting = false,
  recentCodexReset = null,
  resetWatch = null,
  resetRiskSource,
  resetForecast = null,
  onOpenResetForecast = () => undefined,
  paceBaselines = {},
  history = [],
  dailyUsage = [],
  updateState = EMPTY_UPDATE_STATE,
  updateOpen = false,
  onUpdateOpen = () => undefined,
  onUpdateClose = () => undefined,
  onUpdateDownload = () => undefined,
  onUpdateInstall = () => undefined,
  onUpdateRetry = () => undefined,
  onUpdateLater = () => undefined,
  onUpdateSkip = () => undefined,
  onUpdateRelease = () => undefined,
  isConsuming = false,
  consumingProviders,
  notice = null,
  controlCenter = null,
  controlOpen = false,
  onControlOpen = () => undefined,
  initialShowCreditTip = false,
  initialInsightsOpen = false,
}: Props) {
  const [showCreditTip, setShowCreditTip] = useState(initialShowCreditTip);
  const [insightsOpen, setInsightsOpen] = useState(initialInsightsOpen);
  const [draggedProvider, setDraggedProvider] = useState<ProviderId | null>(null);
  const [dragTargetProvider, setDragTargetProvider] = useState<ProviderId | null>(null);
  const [dragTargetAfter, setDragTargetAfter] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const providerPointerDrag = useRef<{ source: ProviderId; target: ProviderId; after: boolean; pointerId: number } | null>(null);
  const quotaTabRef = useRef<HTMLButtonElement>(null);
  const insightsTabRef = useRef<HTMLButtonElement>(null);
  const language = normalizeLanguage(preferences.language);
  const t = copy[language];
  const tabId = useId();
  const quotaTabId = `${tabId}-quota-tab`;
  const insightsTabId = `${tabId}-insights-tab`;
  const quotaPanelId = `${tabId}-quota-panel`;
  const insightsPanelId = `${tabId}-insights-panel`;
  const quotaWindows = trackedQuotaWindows(snapshot);
  const showQuotaWindowList = quotaWindows.length > 1;
  const singleQuotaWindow = quotaWindows.length === 1 ? quotaWindows[0] : null;
  const singleRemaining = singleQuotaWindow
    ? clampPercent(singleQuotaWindow.window.remainingPercent)
    : null;
  const singleWindowPace = quotaWindows.length === 1
    ? calculateQuotaPace(quotaWindows[0].window, new Date(), paceBaselines[paceBaselineKey(snapshot.provider, quotaWindows[0].period)] ?? null)
    : null;
  const balance = snapshot.balanceRemaining ?? null;
  const unlimited = snapshot.balanceUnit === "unlimited";
  const unlimitedLabel = language === "en" ? "Unlimited" : "不限量";
  const formattedBalance = unlimited
    ? "∞"
    : balance !== null
    ? new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 }).format(balance)
    : null;
  const singleWindowTitle = singleQuotaWindow?.period === "weekly"
    ? t.weeklyRemaining
    : singleQuotaWindow?.period === "5h"
      ? t.fiveHourShort
      : singleQuotaWindow?.period === "monthly"
        ? t.monthlyShort
        : null;
  const metricTitle = showQuotaWindowList ? t.quotaWindows : unlimited ? unlimitedLabel : singleWindowTitle ?? (balance !== null ? t.balanceRemaining : t.unavailableStatus);
  const metricLabel = showQuotaWindowList
    ? t.quotaWindows
    : singleRemaining !== null && singleQuotaWindow
    ? quotaAvailableLabel(singleQuotaWindow.period, singleRemaining, language)
    : unlimited
      ? unlimitedLabel
    : balance !== null
      ? `${formattedBalance} ${snapshot.balanceUnit ?? ""}`.trim()
      : null;
  const staleAge = Date.now() - new Date(snapshot.updatedAt).getTime();
  const staleExpired = snapshot.status === "stale" && staleAge > 30 * 60_000;
  const available = snapshot.status === "ok" || (snapshot.status === "stale" && !staleExpired);
  const tier = quotaTier(quotaWindows.length > 0 ? Math.min(...quotaWindows.map(({ window }) => clampPercent(window.remainingPercent))) : null);
  const indicatorState = isConsuming ? "active" : snapshot.status === "ok" ? "ok" : snapshot.status === "stale" ? "stale" : "error";
  const indicatorLabel = isConsuming
    ? t.active
    : snapshot.status === "ok"
      ? t.dataSynced
      : snapshot.status === "stale"
        ? t.dataStale
        : snapshot.status === "signed_out"
          ? t.notSignedIn
          : t.unavailableStatus;
  const message = localizedBackendMessage(snapshot.message, language, snapshot.displayName);
  const cockpitName = language === "en" ? "Codex Cockpit" : "Codex 驾驶舱";
  const cockpitKicker = language === "en" ? "CODEX COCKPIT" : "CODEX 驾驶舱";
  const overlayOpen = diagnosticsOpen || updateOpen || controlOpen;
  const updatePanel = updateOpen ? (
    <UpdatePanel
      state={updateState}
      language={language}
      onClose={onUpdateClose}
      onDownload={onUpdateDownload}
      onInstall={onUpdateInstall}
      onRetry={onUpdateRetry}
      onLater={onUpdateLater}
      onSkip={onUpdateSkip}
      onOpenRelease={onUpdateRelease}
    />
  ) : null;
  const quotaTabLabel = language === "en" ? "Quota" : "\u989d\u5ea6";
  const insightsTabLabel = language === "en" ? "Insights" : "\u6d1e\u5bdf";
  const updateAttention = !["idle", "current"].includes(updateState.phase);
  const creditExpirations = useMemo(() => (snapshot.resetCreditExpiresAt ?? []).map((value, index) => {
    return t.creditItem(index, formatDateTime(value, language));
  }), [language, snapshot.resetCreditExpiresAt, t]);
  const snapshotsByProvider = useMemo(() => new Map(snapshots.map((item) => [item.provider, item])), [snapshots]);
  const percentageHistoryByProvider = useMemo(() => new Map(
    PROVIDER_CATALOG.map((definition) => [definition.id, recentPercentageHistory(history, definition.id)]),
  ), [history]);
  const providerDefinitions = useMemo(() => {
    const byProvider = new Map(PROVIDER_CATALOG.map((definition) => [definition.id, definition]));
    const visibleOrder = normalizeProviderOrder(preferences.providerOrder).filter((provider) => !preferences.hiddenProviders.includes(provider));
    const displayedOrder = preferences.riskFirst ? sortProviderIdsByRisk(visibleOrder, snapshots) : visibleOrder;
    return displayedOrder.map((provider) => byProvider.get(provider)!);
  }, [preferences.hiddenProviders, preferences.providerOrder, preferences.riskFirst, snapshots]);
  const resetMarker = snapshot.provider === "codex" && snapshot.status === "ok" ? recentCodexReset : null;
  const visibleResetForecast = snapshot.provider === "codex" ? resetForecast : null;

  const commitProviderOrder = (source: ProviderId, target: ProviderId, after = false) => {
    const order = providerDefinitions.map((definition) => definition.id);
    const sourceIndex = order.indexOf(source);
    const targetIndex = order.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0 || source === target) return;
    order.splice(sourceIndex, 1);
    const remainingTarget = order.indexOf(target);
    const insertAt = remainingTarget + (after ? 1 : 0);
    order.splice(insertAt, 0, source);
    onReorderProviders(order);
    setReorderAnnouncement(t.providerMoved(PROVIDER_CATALOG.find((item) => item.id === source)?.label ?? source, insertAt + 1));
  };

  const moveProvider = (provider: ProviderId, offset: -1 | 1) => {
    const order = providerDefinitions.map((definition) => definition.id);
    const index = order.indexOf(provider);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    onReorderProviders(order);
    setReorderAnnouncement(t.providerMoved(providerDefinitions[index].label, nextIndex + 1));
  };

  const providerAtPoint = (clientX: number, clientY: number) => {
    const row = document.elementFromPoint?.(clientX, clientY)?.closest<HTMLElement>("[data-provider-id]");
    if (!row) return null;
    const provider = row.dataset.providerId as ProviderId | undefined;
    if (!provider || !providerDefinitions.some((definition) => definition.id === provider)) return null;
    const bounds = row.getBoundingClientRect();
    return { provider, after: clientY > bounds.top + bounds.height / 2 };
  };

  const updateProviderPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = providerPointerDrag.current;
    if (!drag || drag.pointerId !== (event.pointerId ?? 1)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = providerAtPoint(event.clientX, event.clientY);
    if (!target) return;
    providerPointerDrag.current = { ...drag, target: target.provider, after: target.after };
    setDragTargetProvider(target.provider);
    setDragTargetAfter(target.after);
  };

  const finishProviderPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>, canceled: boolean) => {
    const drag = providerPointerDrag.current;
    if (!drag || drag.pointerId !== (event.pointerId ?? 1)) return;
    event.preventDefault();
    event.stopPropagation();
    const finalTarget = providerAtPoint(event.clientX, event.clientY);
    const target = finalTarget ? { ...drag, target: finalTarget.provider, after: finalTarget.after } : drag;
    if (event.currentTarget.hasPointerCapture?.(drag.pointerId)) event.currentTarget.releasePointerCapture(drag.pointerId);
    providerPointerDrag.current = null;
    setDraggedProvider(null);
    setDragTargetProvider(null);
    setDragTargetAfter(false);
    if (!canceled) commitProviderOrder(target.source, target.target, target.after);
  };

  if (preferences.codexFocusMode && snapshot.provider === "codex") {
    const plus = isCodexPlus(snapshot);
    const short = fiveHourWindow(snapshot);
    const shortRemaining = fiveHourRemaining(snapshot);
    const hasFiveHour = plus && shortRemaining !== null;
    const focusWindow = quotaWindows.find(({ period }) => period === "weekly") ?? quotaWindows[0] ?? null;
    const focusRemaining = focusWindow ? clampPercent(focusWindow.window.remainingPercent) : null;
    const todayAdvice = buildTodayQuotaAdvice({
      rateLimitSnapshot: snapshot.rateLimitSnapshot,
      weeklyWindow: plus ? snapshot.weeklyWindow : focusWindow?.window ?? null,
      dailyUsage: codexDailyUsage,
      status: snapshot.status,
      dynamicRecommendation: dailyRecommendation,
    });
    const dailyUsed = todayAdvice.todayUsedPercent;
    const dailySuggested = todayAdvice.todaySuggestedPercent;
    const dailyBudget = preferences.dailyBudgetPercent;
    const accountBudget = sharedBudgetPercent ?? dailyBudget;
    const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
    const dailyBudgetUsageRatio = dailyUsageRatio(dailyUsed, accountBudget);
    const dailyBudgetExhausted = dailyBudgetUsageRatio !== null && dailyBudgetUsageRatio >= 100;
    const weeklyLabel = language === "en" ? "Weekly remaining" : "本周剩余";
    const dailyLabel = language === "en" ? "Today's used" : "今日已用";
    const claudeFiveHourLabel = language === "en" ? "5h used" : "5h 已用";
    const primaryResetsAt = (hasFiveHour ? short?.resetsAt : focusWindow?.window.resetsAt) ?? null;
    const weeklyResetLabel = language === "en" ? "Weekly reset" : "周重置";
    const fiveHourResetLabel = language === "en" ? "5h reset" : "5h 重置";
    const codexResetLabel = focusWindow?.period === "5h" ? fiveHourResetLabel
      : focusWindow?.period === "monthly" ? (language === "en" ? "Monthly reset" : "月重置")
      : weeklyResetLabel;
    const resetCreditsLabel = snapshot.resetCredits === null || snapshot.resetCredits <= 0
      ? (language === "en" ? "None" : "暂无")
      : snapshot.resetCredits;
    const claudeActiveInCard = Boolean(claudeView) && preferences.claudeEnabled;
    const geminiActiveInCard = Boolean(geminiView) && Boolean(preferences.geminiEnabled);
    const activeFlags = enabledProviderFlags({
      codexEnabled: preferences.codexEnabled,
      claudeEnabled: claudeActiveInCard,
      geminiEnabled: geminiActiveInCard,
    });
    const availableModes = enabledCockpitModes({
      codexEnabled: activeFlags.codex,
      claudeEnabled: activeFlags.claude,
      geminiEnabled: activeFlags.gemini,
    });
    const cockpitMode: CockpitMode = effectiveCockpitMode({
      cockpitMode: preferences.cockpitMode,
      codexEnabled: activeFlags.codex,
      claudeEnabled: activeFlags.claude,
      geminiEnabled: activeFlags.gemini,
    });
    const showModeSwitch = availableModes.length > 1;
    const showDynamicTitle = showModeSwitch || cockpitMode !== "codex";
    const claudeDisconnected = claudeView?.quotaStatus === "signed_out" || claudeView?.quotaStatus === "unavailable";
    const showClaudeRings = claudeView !== null &&
      (claudeDisconnected || claudeView.weeklyRemaining !== null || claudeView.fiveHourUsed !== null || claudeView.fiveHourAwaitingRefresh);
    const pendingBadge = language === "en" ? "STALE" : "待更新";
    const english = language === "en";
    const claudeConnection = claudeDisconnected && claudeView ? (
      <ClaudeConnectionIndicator language={language} message={claudeQuotaMessage(claudeView, language)}
        shared={claudeShared} login={claudeLogin}
        onLogin={claudeView.quotaStatus === "signed_out" ? onClaudeLogin : undefined} />
    ) : null;
    const claudeQuotaBadge = claudeConnection ?? (claudeView?.fiveHourAwaitingRefresh ? pendingBadge
      : claudeView?.quotaStatus === "ok" ? undefined : showClaudeRings ? pendingBadge : "—");
    const claudeUnavailable = claudeView ? (
      <section className="codex-focus-unavailable"><strong role="status">{claudeQuotaMessage(claudeView, language)}</strong></section>
    ) : null;
    const codexFiveHourFooter = hasFiveHour ? <span>{language === "en" ? "5h remaining" : "5 小时剩余"} <strong>{number.format(shortRemaining)}%</strong></span> : null;
    const claudeResetRows = claudeView && <>
      <QuotaResetRow label={weeklyResetLabel} resetsAt={claudeView.weeklyResetsAt} now={now} language={language} />
      {claudeView.fiveHourUsed !== null || claudeView.fiveHourResetsAt !== null || claudeView.fiveHourAwaitingRefresh ? <>
        <span>{claudeFiveHourLabel} <strong>{claudeView.fiveHourUsed === null ? "—" : number.format(claudeView.fiveHourUsed) + "%"}</strong></span>
        <QuotaResetRow label={fiveHourResetLabel} resetsAt={claudeView.fiveHourResetsAt} now={now} language={language} awaitingRefresh={claudeView.fiveHourAwaitingRefresh} />
      </> : null}
    </>;
    const aiCodexRing = (
      <QuotaRing
        label="Codex"
        value={available && focusRemaining !== null ? number.format(focusRemaining) : "—"}
        progress={available && focusRemaining !== null ? focusRemaining : 0}
        innerProgress={hasFiveHour ? shortRemaining : undefined}
        tone="weekly"
        footer={(
          <div className="weekly-reset-footer reset-countdown-footer">
            <span>{focusWindow?.period === "5h" ? (language === "en" ? "5h remaining" : "5h 剩余") : focusWindow?.period === "monthly" ? t.monthlyShort : weeklyLabel} <strong>{available && focusRemaining !== null ? `${number.format(focusRemaining)}%` : "—"}</strong></span>
            <QuotaResetRow label={codexResetLabel} resetsAt={available ? focusWindow?.window.resetsAt ?? null : null} now={now} language={language} />
            {focusWindow?.period !== "5h" && codexFiveHourFooter}
            {hasFiveHour && focusWindow?.period !== "5h" && <QuotaResetRow label={fiveHourResetLabel} resetsAt={available ? short?.resetsAt ?? null : null} now={now} language={language} />}
            {dailyBudgetUsageRatio !== null && dailyPersonCosts && dailyPersonCosts.people.length > 0 && (
              <PersonCostBar data={dailyPersonCosts} progress={dailyBudgetUsageRatio} label={dailyLabel} english={language === "en"} />
            )}
          </div>
        )}
      />
    );
    const aiClaudeRing = claudeView ? (
      <QuotaRing
        label="Claude"
        value={claudeView.weeklyRemaining === null ? "—" : number.format(claudeView.weeklyRemaining)}
        progress={claudeView.weeklyRemaining ?? 0}
        innerProgress={claudeView.fiveHourUsed ?? undefined}
        tone="weekly"
        variant="claude"
        badge={claudeQuotaBadge}
        footer={showClaudeRings ? (
          <div className="weekly-reset-footer reset-countdown-footer">
            <span>{weeklyLabel} <strong>{claudeView.weeklyRemaining === null ? "—" : number.format(claudeView.weeklyRemaining) + "%"}</strong></span>
            {claudeResetRows}
          </div>
        ) : null}
      />
    ) : null;
    const geminiCards = geminiView ? <GeminiQuotaCard view={geminiView} language={language} now={now} /> : null;
    const geminiCorner = activeFlags.codex !== activeFlags.claude ? geminiCornerPlacement(capsuleCorner) : null;
    const companionCard = activeFlags.codex ? aiCodexRing : aiClaudeRing;
    return (
      <main
        className={`quota-card codex-focus-card cockpit-mode--${cockpitMode} quota-card--${snapshot.status} quota-card--${tier} quota-card--style-${preferences.colorTheme} quota-card--theme-${resolvedAppearance}${controlOpen || updateOpen ? " quota-card--overlay-open" : ""}`}
        style={{ "--accent-color": preferences.accentColor } as CSSProperties}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onMouseDown={(event) => { if (event.button === 0) void onDrag(); }}
      >
        <div className="aurora" aria-hidden="true" />
        {notice ? <div className="operation-notice" role="status">{notice}</div> : null}
        {controlOpen ? controlCenter : null}
        {updatePanel}
        <div className="codex-focus-content" aria-hidden={controlOpen || updateOpen || undefined} inert={controlOpen || updateOpen || undefined}>
          <header className="codex-focus-header">
            <div className="codex-focus-brand"><CockpitBrandMark mode={cockpitMode} codexEnabled={activeFlags.codex} claudeEnabled={activeFlags.claude} geminiEnabled={activeFlags.gemini} /><span className="codex-focus-brand-copy"><span className="codex-focus-title-row"><strong>{showDynamicTitle ? cockpitTitle(cockpitMode, language) : cockpitName}</strong>{resetWatch && (cockpitMode === "codex" || (cockpitMode === "ai" && activeFlags.codex)) ? <ResetWatchBell watch={resetWatch} language={language} onOpen={onOpenResetForecast} /> : null}</span></span></div>
            {showModeSwitch && !preferences.locked ? <CockpitModeSwitch mode={cockpitMode} modes={availableModes} language={language} onChange={onCockpitModeChange} />
              : cockpitMode === "claude" && claudeDisconnected ? null
              : <span className="codex-focus-live"><i aria-hidden="true" />{language === "en" ? "LIVE" : "实时"}</span>}
            {!preferences.locked ? (
              <button type="button" className="codex-focus-more" onMouseDown={(event) => event.stopPropagation()} onClick={onControlOpen} aria-label={language === "en" ? "Settings" : "设置"}>
                <CaretRight weight="bold" />
              </button>
            ) : null}
          </header>

          <div className="codex-focus-scroll" key={cockpitMode}>
            <div className="codex-focus-body">
              {comfortPrompt && activeFlags.codex && (cockpitMode === "codex" || cockpitMode === "ai")
                ? <ComfortFeedbackPanel prompt={comfortPrompt} language={language} onSelect={onComfortSelect} saving={comfortSaving} error={comfortSaveError} onOpenCodex={cockpitMode === "ai" && onCockpitModeChange ? () => onCockpitModeChange("codex") : undefined} />
                : null}

              {cockpitMode === "gemini" && geminiView ? (
                <div className="codex-focus-ring-grid cockpit-gemini-grid">
                  {geminiCards}
                </div>
              ) : cockpitMode === "claude" && claudeView ? (
                showClaudeRings ? <ClaudeQuotaCards view={claudeView} language={language} now={now} connection={claudeConnection} />
                  : claudeUnavailable
              ) : cockpitMode === "ai" && activeFlags.gemini && geminiView ? (
                <div
                  className="codex-focus-ring-grid cockpit-ai-grid cockpit-gemini-grid"
                  data-gemini-row={geminiCorner?.geminiRow}
                  data-companion-column={geminiCorner?.companionColumn}
                >
                  {geminiCorner ? (
                    geminiCorner.geminiRow === "top" ? <>{geminiCards}{companionCard}</> : <>{companionCard}{geminiCards}</>
                  ) : <>{geminiCards}{aiCodexRing}{aiClaudeRing}</>}
                </div>
              ) : cockpitMode === "ai" && claudeView ? (
                <div className="codex-focus-ring-grid cockpit-ai-grid">
                  {aiCodexRing}
                  {aiClaudeRing}
                </div>
              ) : available && focusWindow && focusRemaining !== null ? (
                <>
                  <div className="codex-focus-ring-grid">
                    <QuotaRing
                      label={hasFiveHour ? (language === "en" ? "5h remaining" : "5 小时剩余") : weeklyLabel}
                      value={hasFiveHour ? number.format(shortRemaining) : String(focusRemaining)}
                      progress={hasFiveHour ? snapshot.weeklyWindow?.remainingPercent ?? 0 : focusRemaining}
                      innerProgress={hasFiveHour ? shortRemaining : undefined}
                      tone="weekly"
                      detail={hasFiveHour ? (language === "en" ? "Inner 5h · outer week" : "内环 5h · 外环周") : undefined}
                      footer={(
                        <div className="weekly-reset-footer reset-countdown-footer codex-reset-footer">
                          {hasFiveHour ? <span>{weeklyLabel} <strong>{snapshot.weeklyWindow ? number.format(snapshot.weeklyWindow.remainingPercent) + "%" : "—"}</strong></span> : null}
                          <QuotaResetRow label={language === "en" ? "Resets in" : "距重置"} resetsAt={primaryResetsAt} now={now} language={language} unknownLabel="—" />
                          <span>{hasFiveHour ? fiveHourResetLabel : (language === "en" ? "Next reset" : "下次重置")} <strong>{focusResetDate(primaryResetsAt, language)}</strong></span>
                          <span>{language === "en" ? "Reset credits" : "重置机会"} <strong>{resetCreditsLabel}</strong></span>
                        </div>
                      )}
                    />
                    <QuotaRing
                      label={dailyLabel}
                      value={dailyBudgetUsageRatio === null ? "—" : number.format(dailyBudgetUsageRatio)}
                      progress={dailyBudgetUsageRatio ?? 0}
                      tone="daily"
                      personCosts={dailyPersonCosts}
                      overPace={dailyBudgetExhausted}
                      footer={<DailyQuotaControl language={language} cap={dailyBudget} suggested={dailySuggested} onChange={onDailyBudgetChange}
                        onReset={onResetDailyBudget} onInteractionChange={onSliderInteraction} />}
                    />
                  </div>

                  <div className="codex-focus-insights">
                    <TodayQuotaAdvicePanel
                      advice={todayAdvice}
                      language={language}
                      riskSource={resetRiskSource ?? (activeManualResetRisk(preferences, planDateKey(now)) === null ? "fallback" : "manual")}
                      websiteRisk={resetWatch?.resetChancePercent ?? null}
                      onRiskChange={onResetRiskChange}
                      onInteractionChange={onSliderInteraction}
                    />
                  </div>
                </>
              ) : (
                <section className="codex-focus-unavailable" role="status"><strong>{language === "en" ? "Quota unavailable" : "未读取到额度"}</strong></section>
              )}
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`quota-card quota-card--${snapshot.status} quota-card--${tier} quota-card--layout-${preferences.layoutMode} quota-card--expanded-${preferences.expandedLayout} quota-card--style-${preferences.colorTheme} quota-card--theme-${resolvedAppearance}${overlayOpen ? " quota-card--overlay-open" : ""}${insightsOpen ? " quota-card--insights-open" : ""}`}
      style={{ "--accent-color": preferences.accentColor } as CSSProperties}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onMouseDown={(event) => { if (event.button === 0) void onDrag(); }}
    >
      <div className="aurora" aria-hidden="true" />
      <span className="sr-only" aria-live="polite">{available ? metricLabel : message}</span>
      <span className="sr-only" aria-live="polite">{reorderAnnouncement}</span>
      {notice ? <div className="operation-notice" role="status">{notice}</div> : null}
      {controlOpen ? controlCenter : null}
      {diagnosticsOpen ? (
        <VolcengineDiagnosticsPanel
          value={diagnostics}
          language={language}
          loading={diagnosticsLoading}
          reconnecting={reconnecting}
          onClose={onCloseDiagnostics}
          onReconnect={onReconnect}
        />
      ) : null}
      {updatePanel}
      <header className="quota-panel-header" aria-hidden={overlayOpen || undefined} inert={overlayOpen || undefined}>
        <div className="quota-panel-navigation">
          <p className="quota-panel-brand">{cockpitKicker} <span>· LOCAL FIRST</span></p>
          <div className="quota-panel-tabs" role="tablist" aria-label={language === "en" ? "Widget views" : "\u5c0f\u7ec4\u4ef6\u89c6\u56fe"} onMouseDown={(event) => event.stopPropagation()}>
            <button
              type="button"
              ref={quotaTabRef}
              id={quotaTabId}
              className={insightsOpen ? "" : "is-active"}
              role="tab"
              aria-selected={!insightsOpen}
              aria-controls={quotaPanelId}
              tabIndex={insightsOpen ? -1 : 0}
              onClick={() => setInsightsOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft" || event.key === "End") {
                  event.preventDefault();
                  setInsightsOpen(true);
                  requestAnimationFrame(() => insightsTabRef.current?.focus());
                }
              }}
            >
              {quotaTabLabel}
            </button>
            <button
              type="button"
              ref={insightsTabRef}
              id={insightsTabId}
              className={insightsOpen ? "is-active" : ""}
              role="tab"
              aria-selected={insightsOpen}
              aria-controls={insightsPanelId}
              tabIndex={insightsOpen ? 0 : -1}
              onClick={() => setInsightsOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home") {
                  event.preventDefault();
                  setInsightsOpen(false);
                  requestAnimationFrame(() => quotaTabRef.current?.focus());
                }
              }}
            >
              {insightsTabLabel}
            </button>
          </div>
        </div>
        {!preferences.locked ? (
          <nav className="card-actions quota-panel-actions" aria-label={t.controls} onMouseDown={(event) => event.stopPropagation()}>
            <span className={`usage-indicator usage-indicator--${indicatorState}`} role="status" aria-label={indicatorLabel} title={indicatorLabel}><i /></span>
            <button className={updateAttention ? "update-action update-action--active" : "update-action"} onClick={onUpdateOpen} aria-label={t.appUpdate} title={t.appUpdate}><CloudArrowDown /></button>
            <button className={controlOpen ? "control-action control-action--active" : "control-action"} onClick={onControlOpen} aria-label={language === "en" ? "Control center" : "\u63a7\u5236\u4e2d\u5fc3"} title={language === "en" ? "Control center" : "\u63a7\u5236\u4e2d\u5fc3"}><GearSix /></button>
            <button onClick={onDiagnostics} aria-label={t.diagnostics} title={t.diagnostics}><Pulse /></button>
            <button className="language-button" onClick={onLanguage} aria-label={t.switchLanguage} title={t.switchLanguage}>{language === "en" ? "\u4e2d" : "EN"}</button>
            <button className={preferences.stayExpanded ? "expand-button expand-button--active" : "expand-button"} onClick={onToggleStayExpanded} aria-pressed={preferences.stayExpanded} aria-label={preferences.stayExpanded ? t.keepExpandedOff : t.keepExpandedOn} title={preferences.stayExpanded ? t.keepExpandedOff : t.keepExpandedOn}>
              {preferences.stayExpanded ? <ArrowsInSimple weight="bold" /> : <ArrowsOutSimple />}
            </button>
            <button onClick={onLock} aria-label={preferences.alwaysOnTop ? t.pinOff : t.pinOn} title={preferences.alwaysOnTop ? t.pinOff : t.pinOn}>
              {preferences.alwaysOnTop ? <PushPin /> : <PushPinSlash />}
            </button>
          </nav>
        ) : null}
      </header>

      <div
        className="quota-tab-panel quota-tab-panel--quota"
        id={quotaPanelId}
        role="tabpanel"
        aria-labelledby={quotaTabId}
        hidden={insightsOpen}
        aria-hidden={overlayOpen || undefined}
        inert={overlayOpen || undefined}
      >
      <section className="primary-pane">
        <header className="card-header">
          <div>
            <p className="eyebrow">{snapshot.displayName} · {snapshot.plan ?? t.accountFallback}</p>
            <div className="metric-context">
              {snapshot.status !== "stale" ? <p className="updated">{metricTitle}</p> : null}
              {resetMarker ? <span className="recent-reset" title={t.resetDetectedAt(formatDateTime(resetMarker.resetAt, language))}><ClockCounterClockwise weight="bold" />{t.recentlyReset}</span> : null}
              {visibleResetForecast ? (
                <button
                  type="button"
                  className={`reset-forecast${visibleResetForecast.resetAnnounced ? " reset-forecast--announced" : ""}`}
                  title={resetForecastTitle(language)}
                  aria-label={resetForecastTitle(language)}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => onOpenResetForecast(visibleResetForecast.sourceUrl)}
                >
                  <Gauge weight="bold" />
                  <span className="reset-forecast-copy">
                    <small>{language === "en" ? "Unofficial outlook" : "非官方重置展望"}</small>
                    <strong>{resetForecastLabel(language, visibleResetForecast.score, visibleResetForecast.windowHours, visibleResetForecast.resetAnnounced)}</strong>
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </header>

        {available && (quotaWindows.length > 0 || balance !== null) ? (
          <>
            {showQuotaWindowList ? (
              <QuotaWindowList windows={quotaWindows} provider={snapshot.provider} language={language} paceBaselines={paceBaselines} />
            ) : (
              <>
                <section className="primary-metric" aria-label={metricLabel ?? undefined}>
                  <span>{singleRemaining ?? formattedBalance}</span><small>{singleRemaining !== null ? "%" : unlimited ? "" : ` ${snapshot.balanceUnit ?? ""}`}</small>
                </section>
                {singleRemaining !== null && singleQuotaWindow ? <div className="progress" role="progressbar" aria-label={quotaAvailableLabel(singleQuotaWindow.period, singleRemaining, language)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={singleRemaining}>
                  <span style={{ width: `${singleRemaining}%` }} />
                </div> : null}
                <p className="reset-time">{singleQuotaWindow ? formatResetTime(singleQuotaWindow.window.resetsAt, new Date(), language) : unlimited ? unlimitedLabel : snapshot.balanceUnit ?? ""}</p>
                {singleWindowPace ? <QuotaPaceHint pace={singleWindowPace} language={language} provider={snapshot.provider} /> : balance !== null && !unlimited ? (
                  <div className="quota-pace-hint quota-pace-hint--unknown" role="status"><span><ClockCounterClockwise />{t.paceNeedsPeriod}</span></div>
                ) : null}
              </>
            )}
            <footer className={`primary-footer${showQuotaWindowList ? " primary-footer--windows" : ""}`}>
              {!showQuotaWindowList && (singleQuotaWindow?.period === "weekly" || snapshot.resetCredits !== null) ? <div className="quota-meta">
                {singleQuotaWindow?.period === "weekly" ? <p>{t.weeklyResetDate(formatResetDate(singleQuotaWindow.window.resetsAt, language))}</p> : null}
                <div className="reset-credit-row" onMouseDown={(event) => event.stopPropagation()}>
                  <span>{snapshot.resetCredits === null ? t.resetCreditUnknown : t.resetCredits(snapshot.resetCredits)}</span>
                  {snapshot.resetCredits !== null && snapshot.resetCredits > 0 ? (
                    <button type="button" className="reset-credit-button" onClick={() => setShowCreditTip((value) => !value)} aria-expanded={showCreditTip} aria-label={t.view}>{t.view}</button>
                  ) : null}
                </div>
                {showCreditTip ? (
                  <div className="reset-credit-tip" role="status" onMouseDown={(event) => event.stopPropagation()}>
                    {creditExpirations.length > 0 ? creditExpirations.map((item) => <p key={item}>{item}</p>) : <p>{t.noCreditExpiration}</p>}
                  </div>
                ) : null}
              </div> : null}
              {!showQuotaWindowList ? <ProviderMark provider={snapshot.provider} label={snapshot.displayName} /> : null}
            </footer>
          </>
        ) : (
          <section className="error-state" aria-live="polite">
            <div className="status-icon" aria-hidden="true"><StatusIcon status={snapshot.status} expired={staleExpired} /></div>
            <div><strong>{snapshot.status === "signed_out" ? t.signedInRequiredFor(snapshot.displayName) : staleExpired ? t.staleExpired : t.temporarilyUnavailable}</strong>
            <p>{message ?? t.errorUnavailable}</p></div>
            <div className="error-actions">
              {snapshot.status === "stale" ? (
                <button type="button" className="error-refresh-button" onMouseDown={(event) => event.stopPropagation()} onClick={onRefresh} disabled={!onRefresh} aria-label={t.refreshQuota}>
                  <ArrowClockwise />
                  <span>{t.refresh}</span>
                </button>
              ) : null}
              {snapshot.provider === "volcengine" && snapshot.status === "signed_out" ? (
                <button type="button" className="error-refresh-button error-reconnect-button" onMouseDown={(event) => event.stopPropagation()} onClick={onReconnect} disabled={reconnecting} aria-label={t.reconnect}>
                  {reconnecting ? <SpinnerGap /> : <SignIn />}
                  <span>{reconnecting ? t.reconnecting : t.reconnect}</span>
                </button>
              ) : null}
              {snapshot.provider === "volcengine" && snapshot.status !== "ok" ? (
                <button type="button" className="error-refresh-button" onMouseDown={(event) => event.stopPropagation()} onClick={onDiagnostics} aria-label={t.diagnostics}>
                  <Pulse />
                  <span>{t.diagnostics}</span>
                </button>
              ) : null}
            </div>
          </section>
        )}
      </section>

      <aside className="provider-ledger" aria-hidden={overlayOpen || undefined} inert={overlayOpen || undefined}>
        <header className="ledger-header">
          <p>{t.allServices}<span>{providerDefinitions.length}/{PROVIDER_CATALOG.length}</span>{preferences.riskFirst ? <b>{language === "en" ? "RISK FIRST" : "风险优先"}</b> : null}</p>
        </header>
        <div className="provider-list" role="list">
          {providerDefinitions.map((definition) => (
            <ProviderLedgerRow
              key={definition.id}
              definition={definition}
              snapshot={snapshotsByProvider.get(definition.id)}
              selected={snapshot.provider === definition.id}
              consuming={consumingProviders.has(definition.id)}
              language={language}
              onSelect={onSelectProvider}
              sortable={!preferences.locked && !preferences.riskFirst}
              dragging={draggedProvider === definition.id}
              dragTarget={dragTargetProvider === definition.id && draggedProvider !== definition.id}
              dragAfter={dragTargetAfter}
              onReorderPointerDown={(event, provider) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                const pointerId = event.pointerId ?? 1;
                providerPointerDrag.current = { source: provider, target: provider, after: false, pointerId };
                setDraggedProvider(provider);
                setDragTargetProvider(provider);
                setDragTargetAfter(false);
                event.currentTarget.setPointerCapture?.(pointerId);
              }}
              onReorderPointerMove={updateProviderPointerDrag}
              onReorderPointerUp={(event) => finishProviderPointerDrag(event, false)}
              onReorderPointerCancel={(event) => finishProviderPointerDrag(event, true)}
              onMove={moveProvider}
              condensed={preferences.collapsedProviders.includes(definition.id)}
              history={percentageHistoryByProvider.get(definition.id) ?? []}
              showHistory={preferences.showHistorySparklines}
              preferRisk={preferences.riskFirst}
            />
          ))}
        </div>
      </aside>
      </div>

      <div
        className="quota-tab-panel quota-tab-panel--insights"
        id={insightsPanelId}
        role="tabpanel"
        aria-labelledby={insightsTabId}
        hidden={!insightsOpen}
        aria-hidden={overlayOpen || undefined}
        inert={overlayOpen || undefined}
      >
        <UsageInsightsPanel
          snapshot={snapshot}
          history={history}
          dailyUsage={dailyUsage}
          paceBaselines={paceBaselines}
          language={language}
          resetForecast={visibleResetForecast}
          onOpenResetForecast={onOpenResetForecast}
          dailyRecommendation={dailyRecommendation}
          personalUsageCalibration={personalUsageCalibration}
        />
      </div>
    </main>
  );
});

function aiCapsuleDimensions(codexRatio: number | null, claudeRatio: number | null, fontScale: number) {
  const scale = Number.isFinite(fontScale) ? Math.min(2, Math.max(1.15, fontScale)) : 1.15;
  const codexWidth = capsuleCellLogicalWidth(codexRatio, scale);
  const claudeWidth = capsuleCellLogicalWidth(claudeRatio, scale);
  const totalWidth = codexWidth + claudeWidth;
  const width = Math.min(320, totalWidth);
  // The grid spans the capsule interior, one pixel inside each border.
  const split = (width * (codexWidth / totalWidth) - 1) / (width - 2);
  return { width, split };
}

export function aiCapsuleLogicalWidth(codexRatio: number | null, claudeRatio: number | null, fontScale = 1.15): number {
  return aiCapsuleDimensions(codexRatio, claudeRatio, fontScale).width;
}

export function capsuleLogicalWidth(dailyRatio: number | null, fontScale = 1.15): number {
  if (dailyRatio === null) return 88;
  const label = `${compactPercent(dailyRatio)}%`;
  const scale = Number.isFinite(fontScale) ? Math.min(2, Math.max(1, fontScale)) : 1.15;
  return Math.ceil(Math.min(196, Math.max(88, 88 + Math.max(0, label.length - 3) * 10 * scale)));
}

function CapsuleQuotaRings({ remaining, dailyRatio, watchActive = false, shortRemaining, valueKind = "used", variant }: { remaining: number; dailyRatio: number | null; watchActive?: boolean; shortRemaining?: number | null; valueKind?: "used" | "remaining" | "five-hour-used"; variant?: "claude" | "gemini-short" | "gemini-weekly" }) {
  let dailyTone = "normal";
  if (dailyRatio !== null) {
    if (valueKind === "remaining") {
      dailyTone = dailyRatio <= 5 ? "over" : dailyRatio <= 20 ? "warning" : "normal";
    } else if (valueKind === "five-hour-used") {
      dailyTone = dailyRatio >= 95 ? "over" : dailyRatio >= 70 ? "warning" : "normal";
    } else {
      dailyTone = dailyRatio > 100 ? "over" : dailyRatio >= 80 ? "warning" : "normal";
    }
  }
  const remainingBand = remaining >= 50 ? "high" : remaining >= 20 ? "mid" : "low";
  const ringStyle = {
    "--remaining-ring-angle": `${Math.round(clampPercent(remaining) * 36) / 10}deg`,
    "--short-ring-angle": `${(shortRemaining ?? 0) * 3.6}deg`,
  } as CSSProperties;
  return (
    <section className={`capsule-quota-readout capsule-quota-readout--${dailyTone}${variant ? ` capsule-quota-readout--${variant}` : ""}`} style={ringStyle} aria-hidden="true">
      <span className="capsule-ring-stack">
        <span className="capsule-daily-disc" />
        <span className={`capsule-ring capsule-ring--remaining capsule-ring--quota-${remainingBand}`} />
        {shortRemaining !== undefined ? <span className="capsule-ring capsule-ring--five-hour" /> : null}
        {watchActive ? <span className="capsule-watch-badge"><Bell weight="fill" /></span> : null}
      </span>
      <span className="capsule-daily-value">
        <b>{compactPercent(dailyRatio)}{dailyRatio === null ? null : <small>%</small>}</b>
      </span>
    </section>
  );
}

export const QuotaOrb = memo(function QuotaOrb({ snapshot, onDrag, onActivate = () => undefined, onPointerDrag, capsuleLiquidGlass = false, language = "zh-CN", compactLayout = "float", colorTheme = "aurora", accentColor = "#397ae0", resolvedAppearance = "light", dailyUsage = null, dailyRecommendation = null, dailyBudgetPercent = null, fontScale = 1.15, resetWatch = null, cockpitMode = "codex", codexEnabled = true, claudeEnabled, geminiEnabled, capsuleCorner = "right-bottom", claudeWeeklyRemaining = null, claudeFiveHourUsed = null, claudeFiveHourAwaitingRefresh = false,  geminiFiveHourRemaining = null, geminiWeeklyRemaining = null, sharedFiveHourRemaining = null, sharedWeeklyRemaining = null, geminiStatus = "unavailable" }: Pick<Props, "snapshot" | "onDrag" | "dailyRecommendation"> & { onActivate?: () => void; onPointerDrag?: () => CapsulePointerDrag; capsuleLiquidGlass?: boolean; language?: Language; compactLayout?: WindowCompactLayout; colorTheme?: ColorTheme; accentColor?: string; resolvedAppearance?: ResolvedAppearance; dailyUsage?: CodexDailyUsage | null; dailyBudgetPercent?: number | null; fontScale?: number; resetWatch?: ResetWatch | null; cockpitMode?: CockpitMode; codexEnabled?: boolean; claudeEnabled?: boolean; geminiEnabled?: boolean; capsuleCorner?: CapsuleCorner; claudeWeeklyRemaining?: number | null; claudeFiveHourUsed?: number | null; claudeFiveHourAwaitingRefresh?: boolean; geminiFiveHourRemaining?: number | null; geminiWeeklyRemaining?: number | null; sharedFiveHourRemaining?: number | null; sharedWeeklyRemaining?: number | null; geminiStatus?: GeminiQuota["status"] }) {
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const dragGesture = useRef<{ screenX: number; screenY: number; started: boolean } | null>(null);
  const pointerGesture = useRef<{ id: number; x: number; y: number; drag?: CapsulePointerDrag } | null>(null);
  const suppressPointerClick = useRef(false);
  const usePointerDrag = compactLayout === "capsule" && onPointerDrag && /^Mac/i.test(navigator.platform);
  useEffect(() => () => pointerGesture.current?.drag?.finish(), []);
  const deferNativeDrag = /^(Win|Linux)/i.test(navigator.platform);
  const activeLanguage = normalizeLanguage(language);
  const visibleWatch = snapshot.provider === "codex" ? resetWatch : null;
  const t = copy[activeLanguage];
  const quotaWindows = trackedQuotaWindows(snapshot);
  const orbQuota = quotaWindows.find(({ period }) => period === "weekly") ?? quotaWindows[0] ?? null;
  const remaining = orbQuota ? clampPercent(orbQuota.window.remainingPercent) : null;
  const balance = snapshot.balanceRemaining ?? null;
  const unlimited = snapshot.balanceUnit === "unlimited";
  const compactBalance = unlimited
    ? "∞"
    : balance !== null
    ? new Intl.NumberFormat(activeLanguage === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(balance)
    : null;
  const tier = quotaTier(remaining);
  const available = snapshot.status === "ok" && (remaining !== null || balance !== null);
  const compactProgress = remaining ?? (available ? 100 : 0);
  const todayAdvice = buildTodayQuotaAdvice({
    rateLimitSnapshot: snapshot.rateLimitSnapshot,
    weeklyWindow: orbQuota?.window ?? null,
    dailyUsage,
    dynamicRecommendation: dailyRecommendation,
    status: snapshot.status,
  });
  const dailyUsed = todayAdvice.todayUsedPercent;
  // Keep the capsule's daily figure identical to the expanded card: today's
  // observed use divided by the user's daily personal cap. The outer ring
  // remains the independent weekly quota remainder.
  const dailyBudgetUsageRatio = dailyUsageRatio(dailyUsed, dailyBudgetPercent);
  const plus = isCodexPlus(snapshot);
  const shortRemaining = fiveHourRemaining(snapshot);
  const hasFiveHour = plus && shortRemaining !== null;
  const capsuleValue = plus ? shortRemaining ?? remaining : dailyBudgetUsageRatio;
  const capsuleMode: CockpitMode = compactLayout === "capsule" ? cockpitMode : "codex";
  const resolvedClaudeEnabled = claudeEnabled ?? (capsuleMode === "claude" || capsuleMode === "ai");
  const resolvedGeminiEnabled = geminiEnabled ?? (capsuleMode === "gemini");
  const claudeShowingWeekly = claudeFiveHourUsed === null && !claudeFiveHourAwaitingRefresh;
  const claudeRatio = claudeShowingWeekly ? claudeWeeklyRemaining
    : claudeFiveHourUsed;
  const geminiUsed = geminiFiveHourUsedPercent(geminiFiveHourRemaining);
  const sharedUsed = geminiFiveHourUsedPercent(sharedFiveHourRemaining);
  const resolvedLayout = compactLayout === "capsule" ? resolveCapsuleLayout({
    mode: capsuleMode,
    codexEnabled,
    claudeEnabled: resolvedClaudeEnabled,
    geminiEnabled: resolvedGeminiEnabled,
    corner: capsuleCorner,
    codexRatio: capsuleValue,
    claudeRatio,
    geminiRatio: geminiUsed,
    sharedRatio: sharedUsed,
    fontScale,
  }) : null;
  const aiCapsule = capsuleMode === "ai" && resolvedLayout?.shape === "pair-codex-claude" ? aiCapsuleDimensions(capsuleValue, claudeRatio, fontScale) : null;
  const glassRef = useCapsuleGlass(capsuleLiquidGlass && compactLayout === "capsule" && resolvedLayout?.shape !== "corner-l", resolvedAppearance === "dark");
  const compactCapsuleWidth = resolvedLayout ? resolvedLayout.width : null;
  const compactCapsuleHeight = resolvedLayout ? resolvedLayout.height : null;
  const claudeWeeklyLabel = claudeWeeklyRemaining === null
    ? (activeLanguage === "en" ? "Weekly remaining —" : "本周剩余 —")
    : quotaAvailableLabel("weekly", claudeWeeklyRemaining, activeLanguage);
  const hasClaudeCapsuleQuota = claudeWeeklyRemaining !== null || claudeFiveHourUsed !== null;
  const claudeCapsuleLabel = !hasClaudeCapsuleQuota
    ? (activeLanguage === "en" ? "Claude quota unavailable" : "未读取到 Claude 额度")
    : claudeShowingWeekly ? `Claude ${claudeWeeklyLabel}`
      : `Claude ${activeLanguage === "en" ? "5h used" : "5h 已用"} ${compactPercent(claudeFiveHourUsed)}${claudeFiveHourUsed === null ? "" : "%"}; ${claudeWeeklyLabel}`;
  const quotaPercent = (value: number | null) => value === null ? "—" : `${compactPercent(value)}%`;
  const groupLabel = (group: string, short: number | null, week: number | null) =>
    `${group} ${activeLanguage === "en" ? "5h used" : "5h 已用"} ${quotaPercent(short)}; ${activeLanguage === "en" ? "Weekly remaining" : "本周剩余"} ${quotaPercent(week)}`;
  const geminiCapsuleLabel = [
    groupLabel("Gemini", geminiUsed, geminiWeeklyRemaining),
    groupLabel(GEMINI_SHARED_POOL_LABEL, sharedUsed, sharedWeeklyRemaining),
  ].join("; ");
  const codexCapsuleCell = available && remaining !== null
    ? <CapsuleQuotaRings remaining={hasFiveHour ? snapshot.weeklyWindow?.remainingPercent ?? 0 : remaining} dailyRatio={capsuleValue} valueKind={plus ? "remaining" : "used"} shortRemaining={hasFiveHour ? shortRemaining : undefined} watchActive={visibleWatch !== null} />
    : <section className="orb-unavailable"><StatusIcon status={snapshot.status} /></section>;
  const claudeCapsule = !hasClaudeCapsuleQuota
    ? <section className="orb-unavailable"><StatusIcon status="unavailable" /></section>
    : <CapsuleQuotaRings remaining={claudeWeeklyRemaining ?? 0} dailyRatio={claudeRatio} valueKind={claudeShowingWeekly ? "remaining" : "five-hour-used"} variant="claude" />;
  const geminiPairCells = (
    <span className="capsule-ai-pair capsule-gemini-pair">
      <CapsuleQuotaRings remaining={geminiWeeklyRemaining ?? 0} shortRemaining={geminiFiveHourRemaining ?? undefined} dailyRatio={geminiUsed} valueKind="five-hour-used" variant="gemini-short" />
      <CapsuleQuotaRings remaining={sharedWeeklyRemaining ?? 0} shortRemaining={sharedFiveHourRemaining ?? undefined} dailyRatio={sharedUsed} valueKind="five-hour-used" variant="gemini-weekly" />
    </span>
  );
  const capsuleWatch = capsuleMode === "codex" || capsuleMode === "ai" ? visibleWatch : null;
  const accessibleLabel = remaining !== null && orbQuota
    ? quotaAvailableLabel(orbQuota.period, remaining, activeLanguage)
    : unlimited
      ? (activeLanguage === "en" ? "Unlimited" : "不限量")
    : `${balance} ${snapshot.balanceUnit ?? ""}`.trim();
  const capsuleAccessibleLabel = compactLayout === "capsule" && hasFiveHour
    ? `${activeLanguage === "en" ? "5h remaining" : "5 小时剩余"} ${compactPercent(shortRemaining)}${shortRemaining === null ? "" : "%"}; ${accessibleLabel}`
    : compactLayout === "capsule" && plus
    ? accessibleLabel
    : compactLayout === "capsule" && remaining !== null
    ? `${accessibleLabel}; ${activeLanguage === "en" ? "Today's used / personal cap" : "今日已用/个人上限"} ${compactPercent(dailyBudgetUsageRatio)}${dailyBudgetUsageRatio === null ? "" : "%"}`
    : accessibleLabel;

  const scheduleIdle = () => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2000);
  };

  useEffect(() => {
    scheduleIdle();
    return () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    };
  }, []);

  const handleMouseEnter = () => {
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    setIdle(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onActivate();
  };

  const pointerHandlers = usePointerDrag ? {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary) return;
      suppressPointerClick.current = false;
      pointerGesture.current = { id: event.pointerId, x: event.screenX, y: event.screenY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const gesture = pointerGesture.current;
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.screenX - gesture.x;
      const dy = event.screenY - gesture.y;
      if (!gesture.drag && Math.hypot(dx, dy) < 3) return;
      gesture.drag ??= onPointerDrag();
      suppressPointerClick.current = true;
      gesture.drag.move(dx, dy);
    },
    onPointerUp: finishPointerDrag,
    onPointerCancel: finishPointerDrag,
    onLostPointerCapture: finishPointerDrag,
  } : {};

  function finishPointerDrag(event: ReactPointerEvent<HTMLElement>) {
    const gesture = pointerGesture.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    pointerGesture.current = null;
    if (event.type === "pointerup") gesture.drag?.move(event.screenX - gesture.x, event.screenY - gesture.y);
    gesture.drag?.finish();
  }

  const handleMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (usePointerDrag || event.button !== 0) return;
    dragGesture.current = { screenX: event.screenX, screenY: event.screenY, started: !deferNativeDrag };
    // Hand the press to the native window immediately. Waiting for a WebView
    // mousemove creates a dead zone and makes short corner drags lag behind.
    if (!deferNativeDrag) void onDrag();
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const gesture = dragGesture.current;
    // Windows and Linux native move loops can consume a stationary click or
    // race its expansion. Keep presses in the WebView until an actual drag.
    if (!deferNativeDrag || !gesture || gesture.started || !(event.buttons & 1)) return;
    if (Math.hypot(event.screenX - gesture.screenX, event.screenY - gesture.screenY) < 6) return;
    gesture.started = true;
    void onDrag();
  };

  const handleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const gesture = dragGesture.current;
    dragGesture.current = null;
    const moved = gesture
      ? (deferNativeDrag && gesture.started) || Math.hypot(event.screenX - gesture.screenX, event.screenY - gesture.screenY) >= 6
      : false;
    if (moved || (event.detail > 0 && suppressPointerClick.current)) {
      suppressPointerClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onActivate();
  };

  const splitValue = resolvedLayout && "split" in resolvedLayout ? resolvedLayout.split : aiCapsule?.split ?? null;
  const orbAriaLabel = resolvedLayout?.shape === "pair-gemini"
    ? geminiCapsuleLabel
    : resolvedLayout?.shape === "corner-l"
      ? `${geminiCapsuleLabel}; ${resolvedLayout.companion === "claude" ? claudeCapsuleLabel : (available ? capsuleAccessibleLabel : t.unavailableStatus)}`
      : resolvedLayout?.shape === "quad-all"
        ? `${geminiCapsuleLabel}; ${available ? capsuleAccessibleLabel : t.unavailableStatus}; ${claudeCapsuleLabel}`
        : capsuleMode === "claude"
          ? claudeCapsuleLabel
          : capsuleMode === "ai"
            ? `${available ? capsuleAccessibleLabel : t.unavailableStatus}; ${claudeCapsuleLabel}`
            : `${available ? capsuleAccessibleLabel : localizedBackendMessage(snapshot.message, activeLanguage, snapshot.displayName) ?? t.unavailableStatus}${visibleWatch ? `; ${resetWatchLabel(visibleWatch, activeLanguage)}` : ""}`;

  if (resolvedLayout?.shape === "corner-l") {
    const companionNode = resolvedLayout.companion === "claude" ? claudeCapsule : codexCapsuleCell;
    return (
      <main
        className={`quota-orb quota-orb--multi-row quota-orb--corner-l cockpit-mode--ai quota-card--${geminiStatus === "ok" ? snapshot.status : geminiStatus} quota-card--${tier} quota-card--compact-${compactLayout} quota-card--style-${colorTheme} quota-card--theme-${resolvedAppearance}${idle ? " quota-orb--idle" : ""}`}
        data-capsule-corner={resolvedLayout.corner}
        data-empty-quadrant={resolvedLayout.emptyQuadrant}
        style={{
          "--accent-color": accentColor,
          "--capsule-logical-width": `${resolvedLayout.width}px`,
          "--capsule-logical-height": `${resolvedLayout.height}px`,
          "--ai-split": `${resolvedLayout.split * 100}%`,
        } as CSSProperties}
        aria-label={orbAriaLabel}
      >
        <div
          className={`capsule-tile capsule-tile--gemini-row capsule-tile--row-${resolvedLayout.geminiRow} capsule-tile--join-${resolvedLayout.companionColumn}`}
          style={{ gridColumn: "1 / -1", gridRow: resolvedLayout.geminiRow === "top" ? 1 : 2 }}
          role="button"
          tabIndex={0}
          aria-label={geminiCapsuleLabel}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={scheduleIdle}
          {...pointerHandlers}
        onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
        >
          {geminiPairCells}
        </div>
        <div
          className={`capsule-tile capsule-tile--companion capsule-tile--companion-${resolvedLayout.companion} capsule-tile--row-${resolvedLayout.geminiRow === "top" ? "bottom" : "top"} capsule-tile--col-${resolvedLayout.companionColumn}`}
          style={{
            gridColumn: resolvedLayout.companionColumn === "left" ? 1 : 2,
            gridRow: resolvedLayout.geminiRow === "top" ? 2 : 1,
          }}
          role="button"
          tabIndex={0}
          aria-label={resolvedLayout.companion === "claude" ? claudeCapsuleLabel : capsuleAccessibleLabel}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={scheduleIdle}
          {...pointerHandlers}
        onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
        >
          {companionNode}
        </div>
      </main>
    );
  }

  if (resolvedLayout?.shape === "quad-all") {
    return (
      <main
        ref={glassRef}
        className={`quota-orb quota-orb--multi-row quota-orb--quad-all cockpit-mode--ai quota-card--${snapshot.status} quota-card--${tier} quota-card--compact-${compactLayout} quota-card--style-${colorTheme} quota-card--theme-${resolvedAppearance}${idle ? " quota-orb--idle" : ""}`}
        style={{
          "--accent-color": accentColor,
          "--capsule-logical-width": `${resolvedLayout.width}px`,
          "--capsule-logical-height": `${resolvedLayout.height}px`,
          "--ai-split": `${resolvedLayout.split * 100}%`,
        } as CSSProperties}
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={scheduleIdle}
        {...pointerHandlers}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        title={capsuleWatch ? resetWatchLabel(capsuleWatch, activeLanguage) : undefined}
        aria-label={orbAriaLabel}
      >
        <div className="capsule-tile capsule-tile--gemini-row capsule-tile--quad-top">
          {geminiPairCells}
        </div>
        <div className="capsule-tile capsule-tile--bottom-pair capsule-tile--quad-bottom">
          <span className="capsule-ai-pair">
            {codexCapsuleCell}
            {claudeCapsule}
          </span>
        </div>
      </main>
    );
  }

  return (
    <main
      ref={glassRef}
      className={`quota-orb cockpit-mode--${resolvedLayout?.shape === "pair-gemini" ? "gemini" : capsuleMode} quota-card--${snapshot.status} quota-card--${tier} quota-card--compact-${compactLayout} quota-card--style-${colorTheme} quota-card--theme-${resolvedAppearance}${idle ? " quota-orb--idle" : ""}`}
      style={{
        "--accent-color": accentColor,
        "--quota-progress-angle": `${Math.round(compactProgress * 36) / 10}deg`,
        ...(compactCapsuleWidth === null ? {} : { "--capsule-logical-width": `${compactCapsuleWidth}px` }),
        ...(compactCapsuleHeight === null ? {} : { "--capsule-logical-height": `${compactCapsuleHeight}px` }),
        ...(splitValue !== null ? { "--ai-split": `${splitValue * 100}%` } : {}),
      } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={scheduleIdle}
      {...pointerHandlers}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      title={capsuleWatch ? resetWatchLabel(capsuleWatch, activeLanguage) : undefined}
      aria-label={orbAriaLabel}
    >
      <div className="aurora" aria-hidden="true" />
      {resolvedLayout?.shape === "pair-gemini" ? geminiPairCells : capsuleMode === "claude" ? claudeCapsule : capsuleMode === "ai" ? (
        <span className="capsule-ai-pair">
          {codexCapsuleCell}
          {claudeCapsule}
        </span>
      ) : available && compactLayout === "capsule" && remaining !== null ? (
        <CapsuleQuotaRings remaining={hasFiveHour ? snapshot.weeklyWindow?.remainingPercent ?? 0 : remaining} dailyRatio={capsuleValue} valueKind={plus ? "remaining" : "used"} shortRemaining={hasFiveHour ? shortRemaining : undefined} watchActive={visibleWatch !== null} />
      ) : available ? (
        <section className="orb-metric">
          <span>{remaining ?? compactBalance}</span>
          <small>{remaining !== null ? "%" : !unlimited && snapshot.balanceUnit === "credits" ? "cr" : ""}</small>
        </section>
      ) : (
        <section className="orb-unavailable">
          <StatusIcon status={snapshot.status} />
        </section>
      )}
      {visibleWatch && capsuleMode === "codex" && !(available && compactLayout === "capsule" && remaining !== null) ? <span className="capsule-watch-badge quota-orb-watch-badge" aria-hidden="true"><Bell weight="fill" /></span> : null}
    </main>
  );
});

function compactResetTime(value: string | null, now = new Date(), language: Language = "en"): string {
  if (!value) return "—";
  const remaining = Math.max(0, new Date(value).getTime() - now.getTime());
  if (!Number.isFinite(remaining)) return "—";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const hours = Math.floor(minutes / 60);
  if (language !== "en") {
    if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24 ? `${hours % 24}小时` : ""}`;
    if (hours > 0) return `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ""}`;
    return `${minutes}分`;
  }
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function compactFreshness(value: string, now = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - new Date(value).getTime());
  if (!Number.isFinite(elapsed)) return "—";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

interface QuotaIslandProps {
  snapshot: ProviderSnapshot;
  snapshots: ProviderSnapshot[];
  language?: Language;
  colorTheme?: ColorTheme;
  accentColor?: string;
  resolvedAppearance?: ResolvedAppearance;
  onSelectProvider: (provider: ProviderId) => void;
  onDrag: () => void;
  onActivate?: () => void;
}

export const QuotaIsland = memo(function QuotaIsland({
  snapshot,
  snapshots,
  language = "zh-CN",
  colorTheme = "aurora",
  accentColor = "#397ae0",
  resolvedAppearance = "dark",
  onSelectProvider,
  onDrag,
  onActivate = () => undefined,
}: QuotaIslandProps) {
  const activeLanguage = normalizeLanguage(language);
  const quotaWindows = trackedQuotaWindows(snapshot);
  const quota = quotaWindows.find(({ period }) => period === "weekly") ?? quotaWindows[0] ?? null;
  const remaining = quota ? clampPercent(quota.window.remainingPercent) : null;
  const balance = snapshot.balanceRemaining ?? null;
  const unlimited = snapshot.balanceUnit === "unlimited";
  const compactBalance = balance === null
    ? null
    : new Intl.NumberFormat(activeLanguage === "en" ? "en-US" : "zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(balance);
  const value = remaining !== null ? `${remaining}%` : unlimited ? "∞" : compactBalance ?? "—";
  const suffix = remaining !== null
    ? (activeLanguage === "en" ? "left" : "剩余")
    : snapshot.balanceUnit === "credits"
      ? "cr"
      : "";
  const healthy = snapshot.status === "ok";
  const status = healthy
    ? (activeLanguage === "en" ? "On track" : "正常")
    : snapshot.status === "stale"
      ? (activeLanguage === "en" ? "Stale" : "过期")
      : activeLanguage === "en" ? "Attention" : "需处理";
  const providers = snapshots.map((item) => ({ id: item.provider, label: item.displayName }));
  const progress = remaining ?? (unlimited ? 100 : 0);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onActivate();
  };

  return (
    <main
      className={`quota-island quota-card--${snapshot.status} quota-card--${quotaTier(remaining)} quota-card--compact-bar quota-card--style-${colorTheme} quota-card--theme-${resolvedAppearance}`}
      style={{ "--accent-color": accentColor } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest(".provider-logo-slider")) return;
        onActivate();
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => { if (event.button === 0) void onDrag(); }}
      aria-label={`${snapshot.displayName} ${value} ${suffix} ${status}`.trim()}
    >
      <ProviderLogoSlider
        providers={providers}
        selected={snapshot.provider}
        onSelect={(provider) => {
          onSelectProvider(provider);
        }}
        ariaLabel={activeLanguage === "en" ? "Choose provider" : "选择平台"}
        compact
      />
      <span className="island-divider" aria-hidden="true" />
      <section className="island-metric">
        <strong>{snapshot.displayName}</strong>
        <b>{value}</b>
        {suffix ? <small>{suffix}</small> : null}
      </section>
      <span className="island-reset">{quota ? compactResetTime(quota.window.resetsAt) : snapshot.balanceUnit ?? "—"}</span>
      <span className={`island-status island-status--${healthy ? "ok" : "attention"}`}><i />{status}</span>
      <span className="island-freshness">{compactFreshness(snapshot.updatedAt)}</span>
      <span className="island-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
    </main>
  );
});
