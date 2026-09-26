import { ArrowClockwise, ArrowsInSimple, ArrowsOutSimple, Bell, CaretRight, CheckCircle, ClockCounterClockwise, CloudArrowDown, CloudSlash, DotsSixVertical, Gauge, GearSix, Pulse, PushPin, PushPinSlash, SignIn, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { memo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { clampPercent, formatDateTime, formatResetDate, formatResetTime, quotaTier } from "../lib/format";
import { copy, normalizeLanguage, resetForecastLabel, resetForecastTitle } from "../lib/i18n";
import { useModalDialog } from "../lib/modalDialog";
import { normalizeProviderOrder, PROVIDER_CATALOG, type ProviderDefinition } from "../lib/providers";
import { recentPercentageHistory, sortProviderIdsByRisk } from "../lib/providerPresentation";
import { calculateQuotaPace, paceBaselineKey, trackedQuotaWindows, type NamedQuotaWindow, type QuotaPace, type QuotaPeriod } from "../lib/quotaPace";
import type { DailyRecommendation } from "../lib/dynamicQuota";
import type { PersonalUsageCalibration } from "../lib/personalUsageModel";
import type { RecentCodexReset } from "../lib/resetDetection";
import { buildTodayQuotaAdvice, dailyUsageRatio, type TodayQuotaAdvice } from "../lib/todayQuota";
import type { CodexDailyUsage, ColorTheme, ComfortCode, ComfortPrompt, DailyPaceBaseline, DailyUsageSummary, Language, ProviderId, ProviderSnapshot, QuotaHistoryPoint, ResetForecast, ResolvedAppearance, VolcengineDiagnostics, WidgetPreferences, WindowCompactLayout } from "../types";
import { ComfortFeedbackPanel } from "./ComfortFeedbackPanel";
import { ProviderMark } from "./ProviderMark";
import { ProviderLogoSlider } from "./ProviderLogoSlider";
import { RangeSlider } from "./RangeSlider";
import { EMPTY_UPDATE_STATE, UpdatePanel, type UpdateViewState } from "./UpdatePanel";
import { UsageInsightsPanel } from "./UsageInsightsPanel";
import { ResetWatchBell } from "./ResetWatchBell";
import { resetWatchLabel } from "../lib/resetWatch";
import { isCodexPlus, fiveHourRemaining, fiveHourWindow } from "../lib/plusQuota";
import type { ResetWatch } from "../types";

import { PersonCostArcs } from "./PersonCostRing";
import type { DailyPersonCosts } from "../lib/dailyPersonCosts";

interface Props {
  snapshot: ProviderSnapshot;
  snapshots: ProviderSnapshot[];
  preferences: WidgetPreferences;
  sharedBudgetPercent?: number;
  planningNote?: string;
  codexDailyUsage?: CodexDailyUsage | null;
  dailyPersonCosts?: DailyPersonCosts;
  dailyRecommendation?: DailyRecommendation | null;
  personalUsageCalibration?: PersonalUsageCalibration | null;
  comfortPrompt?: ComfortPrompt | null;
  comfortSaving?: boolean;
  comfortSaveError?: string | null;
  onComfortSelect?: (comfort: ComfortCode) => void;
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
  onDiagnostics?: () => void;
  onCloseDiagnostics?: () => void;
  onReconnect?: () => void;
  diagnostics?: VolcengineDiagnostics | null;
  diagnosticsOpen?: boolean;
  diagnosticsLoading?: boolean;
  reconnecting?: boolean;
  recentCodexReset?: RecentCodexReset | null;
  resetWatch?: ResetWatch | null;
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
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
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
  resetWatch,
  manualRisk,
  onRiskChange,
  onInteractionChange,
}: {
  advice: TodayQuotaAdvice;
  language: Language;
  resetWatch: ResetWatch | null;
  manualRisk: boolean;
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
  const websiteProbability = advice.resetRiskPercent;
  const websiteLabel = language === "en" ? "Reset risk" : "重置风险";
  const websiteHint = language === "en"
    ? "Planning scenario: website community vote by default, with manual adjustment; not an official or calibrated 24h probability."
    : "配额规划情景：默认网站公众投票，可手动微调；不是官方或校准后的24小时概率。";
  return (
    <section className={`today-quota-advice today-quota-advice--${advice.state}`} aria-label={t.officialSnapshot}>
      <header>
        <strong>{t.officialSnapshot}</strong>
        <small>{stateLabel}</small>
      </header>
      <div className="today-quota-advice-grid">
        <div><span>{language === "en" ? "Suggested day total" : "今日总建议"}</span><strong>{display(advice.todaySuggestedPercent)}</strong></div>
        <div><span>{t.todayUsed}</span><strong>{display(advice.todayUsedPercent)}</strong></div>
        <div className="today-quota-advice-risk" title={websiteHint}>
          <span>{websiteLabel} · {manualRisk ? (language === "en" ? "Manual" : "手动") : resetWatch ? (language === "en" ? "Website" : "网站") : (language === "en" ? "Fallback" : "备用")}</span>
          <div className="reset-risk-value"><strong>{display(websiteProbability)}</strong><button type="button" aria-label={language === "en" ? "Restore website risk" : "恢复网站风险"} title={language === "en" ? "Follow website risk" : "恢复并跟随网站风险"} onClick={() => onRiskChange(null)}><ArrowClockwise /></button></div>
          <RangeSlider aria-label={websiteLabel} min={0} max={100} step={1} value={websiteProbability ?? 0} onChange={(event) => onRiskChange(Number(event.target.value))} onInteractionChange={onInteractionChange} />
        </div>
      </div>
    </section>
  );
}

function QuotaRing({ label, value, progress, tone, caption, detail, footer, overPace = false, innerProgress, personCosts }: {
  label: string;
  value: string;
  progress: number;
  tone: "weekly" | "daily";
  caption: string;
  detail: string;
  footer?: ReactNode;
  overPace?: boolean;
  innerProgress?: number | null;
  personCosts?: DailyPersonCosts;
}) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  const weeklyBand = tone === "weekly"
    ? safeProgress >= 50 ? "high" : safeProgress >= 20 ? "mid" : "low"
    : null;
  const dailyBand = tone === "daily"
    ? progress > 100 ? "over" : progress >= 80 ? "warning" : null
    : null;
  return (
    <section className={`codex-ring-card codex-ring-card--${tone}${weeklyBand ? ` codex-ring-card--quota-${weeklyBand}` : ""}${dailyBand ? ` codex-ring-card--daily-${dailyBand}` : ""}${overPace ? " codex-ring-card--over_pace" : ""}`} role="group" aria-label={value === "—" ? label : `${label} ${value}%`}>
      <header className="codex-ring-header">
        <span><i aria-hidden="true" />{label}</span>
        <small>{tone === "weekly" ? "LIVE" : "PLAN"}</small>
      </header>
      <div className="codex-ring-visual">
        <svg viewBox="0 0 140 140" aria-hidden="true">
          <circle className="codex-ring-track" cx="70" cy="70" r="53" pathLength="100" />
          {personCosts ? <PersonCostArcs data={personCosts} progress={safeProgress} /> : <circle className="codex-ring-progress" cx="70" cy="70" r="53" pathLength="100" strokeDasharray={`${safeProgress} ${100 - safeProgress}`} />}
          {innerProgress !== undefined ? <>
            <circle className="codex-ring-track" cx="70" cy="70" r="42" pathLength="100" />
            <circle className="codex-ring-progress codex-ring-progress--five-hour" cx="70" cy="70" r="42" pathLength="100" strokeDasharray={`${innerProgress ?? 0} ${100 - (innerProgress ?? 0)}`} />
          </> : null}
        </svg>
        <div className="codex-ring-value"><strong>{value}</strong>{value === "—" ? null : <span>%</span>}</div>
      </div>
      <div className="codex-ring-caption"><span>{caption}</span><strong>{detail}</strong></div>
      {footer ? <footer className="codex-ring-footer">{footer}</footer> : null}
    </section>
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
  planningNote,
  codexDailyUsage = null,
  dailyPersonCosts,
  dailyRecommendation = null,
  personalUsageCalibration = null,
  comfortPrompt = null,
  comfortSaving = false,
  comfortSaveError = null,
  onComfortSelect = () => undefined,
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
  onDiagnostics = () => undefined,
  onCloseDiagnostics = () => undefined,
  onReconnect = () => undefined,
  diagnostics = null,
  diagnosticsOpen = false,
  diagnosticsLoading = false,
  reconnecting = false,
  recentCodexReset = null,
  resetWatch = null,
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
    const budgetLeftLabel = sharedBudgetPercent === undefined ? (language === "en" ? "Cap left" : "上限余量") : (language === "en" ? "Shared plan left" : "共享计划余量");
    const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
    const dailyBudgetUsageRatio = dailyUsageRatio(dailyUsed, accountBudget);
    const dailyBudgetExhausted = dailyBudgetUsageRatio !== null && dailyBudgetUsageRatio >= 100;
    const dailyBudgetDetail = dailyBudgetExhausted
      ? `${language === "en" ? "Over cap" : "超出上限"} ${number.format(Math.max(0, (dailyBudgetUsageRatio ?? 100) - 100))}%`
      : dailyUsed === null
        ? (language === "en" ? "No usage recorded" : "今日未记录用量")
        : `${budgetLeftLabel} ${number.format(Math.max(0, accountBudget - dailyUsed))}%`;
    const weeklyLabel = language === "en" ? "Weekly remaining" : "本周剩余";
    const dailyLabel = language === "en" ? "Today's used" : "今日已用";
    const resetCreditsLabel = snapshot.resetCredits === null || snapshot.resetCredits <= 0
      ? (language === "en" ? "None" : "暂无")
      : snapshot.resetCredits;
    const firstObservedLabel = codexDailyUsage?.coverage === "partial" && codexDailyUsage.firstObservedAt
      ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(codexDailyUsage.firstObservedAt))
      : null;
    const usedLabel = dailyUsed === null
      ? (language === "en" ? "Not recorded today" : "今日未记录")
      : dailyRecommendation?.dayPlan
        ? `${language === "en" ? "Used since baseline" : "基准后已用"} ${number.format(dailyUsed)}%`
      : codexDailyUsage?.coverage === "partial"
        ? `${language === "en" ? "Recorded" : "已记录"} ${number.format(dailyUsed)}%${firstObservedLabel ? ` · ${firstObservedLabel} ${language === "en" ? "onward" : "起"}` : ""}`
        : `${language === "en" ? "Used" : "已用"} ${number.format(dailyUsed)}%`;

    return (
      <main
        className={`quota-card codex-focus-card quota-card--${snapshot.status} quota-card--${tier} quota-card--style-${preferences.colorTheme} quota-card--theme-${resolvedAppearance}${controlOpen ? " quota-card--overlay-open" : ""}`}
        style={{ "--accent-color": preferences.accentColor } as CSSProperties}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onMouseDown={(event) => { if (event.button === 0) void onDrag(); }}
      >
        <div className="aurora" aria-hidden="true" />
        {notice ? <div className="operation-notice" role="status">{notice}</div> : null}
        {controlOpen ? controlCenter : null}
        <div className="codex-focus-content" aria-hidden={controlOpen || undefined} inert={controlOpen || undefined}>
          <header className="codex-focus-header">
            <div className="codex-focus-brand"><ProviderMark provider="codex" label="Codex" /><span className="codex-focus-brand-copy"><span className="codex-focus-title-row"><strong>{cockpitName}</strong>{resetWatch ? <ResetWatchBell watch={resetWatch} language={language} onOpen={onOpenResetForecast} /> : null}</span></span></div>
            <span className="codex-focus-live"><i aria-hidden="true" />{language === "en" ? "LIVE" : "实时"}</span>
            {!preferences.locked ? (
              <button type="button" className="codex-focus-more" onMouseDown={(event) => event.stopPropagation()} onClick={onControlOpen} aria-label={language === "en" ? "Settings" : "设置"}>
                <CaretRight weight="bold" />
              </button>
            ) : null}
          </header>

          {comfortPrompt ? <ComfortFeedbackPanel prompt={comfortPrompt} language={language} onSelect={onComfortSelect} saving={comfortSaving} error={comfortSaveError} /> : null}

          {available && focusWindow && focusRemaining !== null ? (
            <>
              <div className="codex-focus-ring-grid">
                <QuotaRing
                  label={plus ? (language === "en" ? "5h remaining" : "5 小时剩余") : weeklyLabel}
                  value={plus ? (shortRemaining === null ? "—" : number.format(shortRemaining)) : String(focusRemaining)}
                  progress={plus ? snapshot.weeklyWindow?.remainingPercent ?? 0 : focusRemaining}
                  innerProgress={plus ? shortRemaining : undefined}
                  tone="weekly"
                  caption={plus ? (short ? formatResetTime(short.resetsAt, new Date(), language) : (language === "en" ? "5h data unavailable" : "5 小时额度暂不可用")) : formatResetTime(focusWindow.window.resetsAt, new Date(), language)}
                  detail={plus ? (language === "en" ? "Inner 5h · outer week" : "内环 5h · 外环周") : (language === "en" ? "weekly cycle" : "周额度周期")}
                  footer={(
                    <div className="weekly-reset-footer">
                      {plus ? <span>{weeklyLabel} <strong>{snapshot.weeklyWindow ? number.format(snapshot.weeklyWindow.remainingPercent) + "%" : "—"}</strong></span> : null}
                      <span>{plus ? (language === "en" ? "5h reset" : "5h 重置") : (language === "en" ? "Next reset" : "下次重置")} <strong>{focusResetDate(plus ? short?.resetsAt ?? null : focusWindow.window.resetsAt, language)}</strong></span>
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
                  caption={dailyUsed === null || dailySuggested === null
                    ? (language === "en" ? "Waiting for today's guide" : "等待今日建议")
                    : `${language === "en" ? "Used" : "已用"} ${number.format(dailyUsed)}% / ${language === "en" ? "day total" : "总建议"} ${number.format(dailySuggested)}%`}
                  detail={dailyBudgetDetail}
                  footer={(
                    <div className="daily-budget-control" onMouseDown={(event) => event.stopPropagation()}>
                      {planningNote && <small>{planningNote}</small>}
                      <div className="daily-budget-heading">
                        <label htmlFor="daily-budget-range"><span>{language === "en" ? "Personal cap" : "个人上限"}</span><output>{number.format(dailyBudget)}%</output></label>
                        <button
                          type="button"
                          className="daily-budget-refresh"
                          onClick={onResetDailyBudget}
                          disabled={dailySuggested === null}
                          aria-label={t.restoreDailyBudget}
                          title={t.restoreDailyBudget}
                        >
                          <ArrowClockwise weight="bold" />
                        </button>
                      </div>
                      {dailySuggested !== null ? (
                        <small className="daily-budget-recommendation">
                          {language === "en" ? "Day total" : "今日总建议"} {number.format(dailySuggested)}%
                          {todayAdvice.safetyCapPercent !== null ? ` · ${language === "en" ? "cycle cap" : "周期上限"} ${number.format(todayAdvice.safetyCapPercent)}%` : ""}
                        </small>
                      ) : null}
                      <RangeSlider
                        id="daily-budget-range"
                        min="1"
                        max="100"
                        step="0.1"
                        value={dailyBudget}
                        aria-label={language === "en" ? "Personal cap" : "个人上限"}
                        onChange={(event) => onDailyBudgetChange(Number(event.target.value))}
                        onInteractionChange={onSliderInteraction}
                      />
                      <p><span>{usedLabel}</span><span>{budgetLeftLabel} {dailyUsed === null ? "—" : `${number.format(Math.max(0, accountBudget - dailyUsed))}%`}</span></p>
                    </div>
                  )}
                />
              </div>

              <div className="codex-focus-insights">
                <TodayQuotaAdvicePanel
                  advice={todayAdvice}
                  language={language}
                  resetWatch={resetWatch}
                  manualRisk={preferences.resetRiskManualEnabled === true}
                  onRiskChange={onResetRiskChange}
                  onInteractionChange={onSliderInteraction}
                />
              </div>
            </>
          ) : (
            <section className="codex-focus-unavailable" role="status"><strong>{language === "en" ? "Quota unavailable" : "未读取到额度"}</strong></section>
          )}
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
      {updateOpen ? (
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
      ) : null}
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

function compactPercent(value: number | null): string {
  if (value === null) return "—";
  const percent = Math.max(0, value);
  const rounded = Math.round(percent * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, "");
}

export function capsuleLogicalWidth(dailyRatio: number | null, fontScale = 1.15): number {
  if (dailyRatio === null) return 88;
  const label = `${compactPercent(dailyRatio)}%`;
  const scale = Number.isFinite(fontScale) ? Math.min(2, Math.max(1, fontScale)) : 1.15;
  return Math.ceil(Math.min(196, Math.max(88, 88 + Math.max(0, label.length - 3) * 10 * scale)));
}

function CapsuleQuotaRings({ remaining, dailyRatio, watchActive = false, shortRemaining }: { remaining: number; dailyRatio: number | null; watchActive?: boolean; shortRemaining?: number | null }) {
  const dailyTone = shortRemaining !== undefined
    ? shortRemaining !== null && shortRemaining <= 5 ? "over" : shortRemaining !== null && shortRemaining <= 20 ? "warning" : "normal"
    : dailyRatio !== null && dailyRatio > 100
    ? "over"
    : dailyRatio !== null && dailyRatio >= 80
      ? "warning"
      : "normal";
  const remainingBand = remaining >= 50 ? "high" : remaining >= 20 ? "mid" : "low";
  const ringStyle = {
    "--remaining-ring-angle": `${Math.round(clampPercent(remaining) * 36) / 10}deg`,
    "--short-ring-angle": `${(shortRemaining ?? 0) * 3.6}deg`,
  } as CSSProperties;
  return (
    <section className={`capsule-quota-readout capsule-quota-readout--${dailyTone}`} style={ringStyle} aria-hidden="true">
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

export const QuotaOrb = memo(function QuotaOrb({ snapshot, onDrag, onActivate = () => undefined, language = "zh-CN", compactLayout = "float", colorTheme = "aurora", accentColor = "#397ae0", resolvedAppearance = "light", dailyUsage = null, dailyRecommendation = null, dailyBudgetPercent = null, fontScale = 1.15, resetWatch = null }: Pick<Props, "snapshot" | "onDrag" | "dailyRecommendation"> & { onActivate?: () => void; language?: Language; compactLayout?: WindowCompactLayout; colorTheme?: ColorTheme; accentColor?: string; resolvedAppearance?: ResolvedAppearance; dailyUsage?: CodexDailyUsage | null; dailyBudgetPercent?: number | null; fontScale?: number; resetWatch?: ResetWatch | null }) {
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const dragGesture = useRef<{ screenX: number; screenY: number; started: boolean } | null>(null);
  const deferNativeDrag = /^Win/i.test(navigator.platform);
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
  const capsuleValue = plus ? shortRemaining : dailyBudgetUsageRatio;
  const compactCapsuleWidth = compactLayout === "capsule" ? capsuleLogicalWidth(capsuleValue, fontScale) : null;
  const accessibleLabel = remaining !== null && orbQuota
    ? quotaAvailableLabel(orbQuota.period, remaining, activeLanguage)
    : unlimited
      ? (activeLanguage === "en" ? "Unlimited" : "不限量")
    : `${balance} ${snapshot.balanceUnit ?? ""}`.trim();
  const capsuleAccessibleLabel = compactLayout === "capsule" && plus
    ? `${activeLanguage === "en" ? "5h remaining" : "5 小时剩余"} ${compactPercent(shortRemaining)}${shortRemaining === null ? "" : "%"}; ${accessibleLabel}`
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

  const handleMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    dragGesture.current = { screenX: event.screenX, screenY: event.screenY, started: !deferNativeDrag };
    // Hand the press to the native window immediately. Waiting for a WebView
    // mousemove creates a dead zone and makes short corner drags lag behind.
    if (!deferNativeDrag) void onDrag();
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLElement>) => {
    const gesture = dragGesture.current;
    // Windows' native move loop can consume mouse-up/click even without a
    // movement. Keep stationary presses in the WebView; hand off only a drag.
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
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onActivate();
  };

  return (
    <main
      className={`quota-orb quota-card--${snapshot.status} quota-card--${tier} quota-card--compact-${compactLayout} quota-card--style-${colorTheme} quota-card--theme-${resolvedAppearance}${idle ? " quota-orb--idle" : ""}`}
      style={{
        "--accent-color": accentColor,
        "--quota-progress-angle": `${Math.round(compactProgress * 36) / 10}deg`,
        ...(compactCapsuleWidth === null ? {} : { "--capsule-logical-width": `${compactCapsuleWidth}px` }),
      } as CSSProperties}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={scheduleIdle}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      title={visibleWatch ? resetWatchLabel(visibleWatch, activeLanguage) : undefined}
      aria-label={`${available ? capsuleAccessibleLabel : localizedBackendMessage(snapshot.message, activeLanguage, snapshot.displayName) ?? t.unavailableStatus}${visibleWatch ? `; ${resetWatchLabel(visibleWatch, activeLanguage)}` : ""}`}
    >
      <div className="aurora" aria-hidden="true" />
      {available && compactLayout === "capsule" && remaining !== null ? (
        <CapsuleQuotaRings remaining={plus ? snapshot.weeklyWindow?.remainingPercent ?? 0 : remaining} dailyRatio={capsuleValue} shortRemaining={plus ? shortRemaining : undefined} watchActive={visibleWatch !== null} />
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
      {visibleWatch && !(available && compactLayout === "capsule" && remaining !== null) ? <span className="capsule-watch-badge quota-orb-watch-badge" aria-hidden="true"><Bell weight="fill" /></span> : null}
    </main>
  );
});

function compactResetTime(value: string | null, now = new Date()): string {
  if (!value) return "—";
  const remaining = Math.max(0, new Date(value).getTime() - now.getTime());
  if (!Number.isFinite(remaining)) return "—";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const hours = Math.floor(minutes / 60);
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
