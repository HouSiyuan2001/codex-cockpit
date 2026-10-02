import { ArrowClockwise, ArrowSquareOut, GearSix, Monitor, Moon, Sun, X } from "@phosphor-icons/react";
import { useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { personalFeedbackView } from "../lib/personComfort";
import { personalizeComfortCurve } from "../lib/comfortFeedback";
import { useModalDialog } from "../lib/modalDialog";
import { setControlCenterCalendarOpen } from "../lib/bridge";
import type { DailyRecommendation } from "../lib/dynamicQuota";
import type { CodexDailyUsage, ComfortCode, ComfortFeedbackRecord, DailyUsageSummary, Language, PersonalizedComfortCurve, WidgetPreferences } from "../types";
import { PersonComfortSection } from "./PersonComfortSection";
import type { TokeiUsage } from "../lib/tokeiUsage";
import { RangeSlider } from "./RangeSlider";
import { ResetRiskQuotaHeatmap } from "./ResetRiskQuotaHeatmap";
import { CodexUsagePanel } from "./CodexUsagePanel";
import { TeamMemberSettings } from "./TeamMemberSettings";
import { CloudSyncSettings } from "./CloudSyncSettings";

interface Props {
  preferences: WidgetPreferences;
  language: Language;
  comfortFeedback?: readonly ComfortFeedbackRecord[];
  dailyUsage?: readonly DailyUsageSummary[];
  dailyUsageHistory?: readonly CodexDailyUsage[];
  dailyRecommendation?: DailyRecommendation | null;
  weeklyRemainingPercent?: number | null;
  carryInPercent?: number;
  onComfortFeedback?: (localDate: string, comfort: ComfortCode) => void;
  comfortUsage?: TokeiUsage | null;
  comfortPersonId?: string | null;
  comfortUsageError?: boolean;
  comfortSaving?: boolean;
  comfortSaveError?: string | null;
  onComfortPersonChange?: (personId: string | null) => void;
  onComfortSnapshotRefresh?: (localDate: string) => void;
  onUsageGroupsChange?: () => Promise<unknown> | void;
  onCheckUpdate?: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onOpenCodexResets?: () => void;
  onDrag?: () => void;
  onPreferences: (value: WidgetPreferences) => void;
  onSliderInteraction?: (active: boolean) => void;
  autostartEnabled: boolean;
  onAutostart: (enabled: boolean) => void;
}

export function ControlCenter({ preferences, language, comfortFeedback = [], dailyUsage = [], dailyUsageHistory = [], dailyRecommendation = null, weeklyRemainingPercent = null, carryInPercent = 0, onComfortFeedback = () => undefined, comfortUsage = null, comfortPersonId = null, comfortUsageError = false, comfortSaving = false, comfortSaveError = null, onComfortPersonChange = () => undefined, onComfortSnapshotRefresh = () => undefined, onUsageGroupsChange = () => undefined, onCheckUpdate = () => undefined, onClose, onRefresh, onOpenCodexResets = () => undefined, onDrag = () => undefined, onPreferences, onSliderInteraction = () => undefined, autostartEnabled, onAutostart }: Props) {
  const dialogRef = useModalDialog<HTMLElement>(onClose);
  const selectedPersonCurve = useMemo(() => personalizeComfortCurve(
    comfortFeedback.filter(record => (record.personId ?? null) === comfortPersonId)
      .map(record => personalFeedbackView(record, comfortUsage, dailyUsageHistory, dailyUsage)),
  ), [comfortFeedback, comfortPersonId, comfortUsage, dailyUsageHistory, dailyUsage]);
  const [page, setPage] = useState<"quota" | "usage" | "settings">("quota");
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarPortalTarget, setCalendarPortalTarget] = useState<HTMLElement | null>(null);
  const zh = language !== "en";
  const selectedPersonName = comfortUsage?.groups.find(group => group.id === comfortPersonId)?.name
    ?? comfortFeedback.find(record => (record.personId ?? null) === comfortPersonId)?.personName
    ?? comfortPersonId
    ?? (zh ? "未归属旧记录" : "Unassigned legacy");
  const labels = zh ? {
    title: "控制中心",
    status: "双圆环仪表盘",
    refresh: "刷新额度",
    codexResets: "打开 Codex Resets",
    settings: "设置",
    display: "显示",
    fontSize: "字大小",
    language: "语言",
    appearance: "主题",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    behavior: "行为",
    notifications: "额度提醒",
    notificationsHint: "重置与恢复时提示",
    stayExpanded: "保持展开",
    stayExpandedHint: "鼠标移开后仍保留大面板",
    autostart: "开机启动",
    autostartHint: "登录系统后自动打开",
    source: "额度来自官方本地快照",
    done: "完成",
  } : {
    title: "Control center",
    status: "Dual-ring dashboard",
    refresh: "Refresh quota",
    codexResets: "Open Codex Resets",
    settings: "Settings",
    display: "Display",
    fontSize: "Text size",
    language: "Language",
    appearance: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    behavior: "Behavior",
    notifications: "Quota alerts",
    notificationsHint: "Notify on reset and recovery",
    stayExpanded: "Keep expanded",
    stayExpandedHint: "Keep the large panel after the pointer leaves",
    autostart: "Launch at login",
    autostartHint: "Open automatically after sign-in",
    source: "Quota comes from the official local snapshot",
    done: "Done",
  };
  const updatePreferences = (patch: Partial<WidgetPreferences>) => onPreferences({ ...preferences, ...patch });
  const productName = zh ? "Codex 驾驶舱" : "Codex Cockpit";
  const changeCalendarOpen = (open: boolean) => {
    setCalendarOpen(open);
    void setControlCenterCalendarOpen(open).catch(() => undefined);
  };
  const changePage = (next: typeof page) => {
    if (next !== "usage" && calendarOpen) changeCalendarOpen(false);
    setPage(next);
  };

  const handleHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || (event.target as Element).closest("button, input, select, textarea, a, summary, label, [role='radio'], [role='checkbox'], [role='slider']")) return;
    event.preventDefault();
    onDrag();
  };

  return (
    <section ref={dialogRef} className={`control-center control-center--minimal${page === "usage" && calendarOpen ? " control-center--calendar-open" : ""}`} role="dialog" aria-modal="true" aria-labelledby="control-center-title" tabIndex={-1} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      <header
        className="control-header control-header--draggable"
        onPointerDown={handleHeaderPointerDown}
      >
        <div><h2 id="control-center-title">{labels.title}</h2></div>
        <button type="button" onClick={onClose} aria-label={zh ? "关闭" : "Close"} data-dialog-initial-focus><X /></button>
      </header>

      <div className="control-body control-body--minimal">
        <nav className="usage-page-tabs" aria-label={zh ? "控制中心页面" : "Control center pages"}>
          <button type="button" aria-pressed={page === "quota"} onClick={() => changePage("quota")}>{zh ? "额度" : "Quota"}</button>
          <button type="button" aria-pressed={page === "usage"} onClick={() => changePage("usage")}>{zh ? "用量" : "Usage"}</button>
          <button type="button" aria-pressed={page === "settings"} onClick={() => changePage("settings")}><GearSix aria-hidden="true" />{labels.settings}</button>
        </nav>
        {page === "usage" ? <CodexUsagePanel zh={zh} onOpenSettings={() => changePage("settings")} calendarOpen={calendarOpen} onCalendarOpenChange={changeCalendarOpen} calendarPortalTarget={calendarPortalTarget} /> : page === "settings" ? <div className="control-settings-page" aria-label={labels.settings}>
        <TeamMemberSettings usage={comfortUsage} loadingError={comfortUsageError} preferences={preferences} zh={zh} onPreferences={onPreferences} onSaved={onUsageGroupsChange} />
        <CloudSyncSettings usage={comfortUsage} zh={zh} onSynced={onUsageGroupsChange} />

        <section className="minimal-section" aria-labelledby="minimal-display-title">
          <header className="minimal-section-header"><strong id="minimal-display-title">{labels.display}</strong></header>
          <label className="minimal-slider-field">
            <span>{labels.fontSize}<output>{Math.round(preferences.fontScale * 100)}%</output></span>
            <RangeSlider min="1" max="2" step="0.05" value={preferences.fontScale} onChange={(event) => updatePreferences({ fontScale: Number(event.target.value) })} onInteractionChange={onSliderInteraction} aria-label={labels.fontSize} />
          </label>
        </section>

        <section className="minimal-section" aria-labelledby="minimal-appearance-title">
          <header className="minimal-section-header"><strong id="minimal-appearance-title">{labels.appearance}</strong></header>
          <div className="minimal-appearance-options" role="radiogroup" aria-label={labels.appearance}>
            {([
              ["system", Monitor, labels.system],
              ["light", Sun, labels.light],
              ["dark", Moon, labels.dark],
            ] as const).map(([id, Icon, label]) => (
              <button key={id} type="button" role="radio" aria-checked={preferences.appearanceMode === id} className={preferences.appearanceMode === id ? "is-active" : ""} onClick={() => updatePreferences({ appearanceMode: id })}>
                <Icon /><span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="minimal-section" aria-labelledby="minimal-language-title">
          <header className="minimal-section-header"><strong id="minimal-language-title">{labels.language}</strong></header>
          <div className="minimal-language-options" role="radiogroup" aria-label={labels.language}>
            {([
              ["zh-CN", "中文"],
              ["en", "English"],
            ] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={preferences.language === id} className={preferences.language === id ? "is-active" : ""} onClick={() => updatePreferences({ language: id })}>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="minimal-section" aria-labelledby="minimal-behavior-title">
          <header className="minimal-section-header"><strong id="minimal-behavior-title">{labels.behavior}</strong></header>
          <div className="minimal-toggle-list">
            <label className="minimal-toggle-row">
              <span><strong>{labels.notifications}</strong><small>{labels.notificationsHint}</small></span>
              <span className="switch"><input type="checkbox" aria-label={labels.notifications} checked={preferences.notificationsEnabled} onChange={(event) => updatePreferences({ notificationsEnabled: event.target.checked })} /><i /></span>
            </label>
            <label className="minimal-toggle-row">
              <span><strong>{labels.stayExpanded}</strong><small>{labels.stayExpandedHint}</small></span>
              <span className="switch"><input type="checkbox" aria-label={labels.stayExpanded} checked={preferences.stayExpanded} onChange={(event) => updatePreferences({ stayExpanded: event.target.checked })} /><i /></span>
            </label>
            <label className="minimal-toggle-row">
              <span><strong>{labels.autostart}</strong><small>{labels.autostartHint}</small></span>
              <span className="switch"><input type="checkbox" aria-label={labels.autostart} checked={autostartEnabled} onChange={(event) => onAutostart(event.target.checked)} /><i /></span>
            </label>
          </div>
        </section>

        <section className="minimal-section">
          <header className="minimal-section-header"><strong>{zh ? "应用更新" : "App updates"}</strong><button type="button" onClick={onCheckUpdate}>{zh ? "检查更新" : "Check for updates"}</button></header>
          <label className="minimal-toggle-row"><span>{zh ? "版本通道" : "Release channel"}</span><select aria-label={zh ? "版本通道" : "Release channel"} value={preferences.updateChannel} onChange={event => updatePreferences({ updateChannel: event.target.value === "beta" ? "beta" : "stable", skippedUpdateVersion: null })}><option value="stable">{zh ? "正式版" : "Stable"}</option><option value="beta">{zh ? "测试版" : "Beta"}</option></select></label>
          <label className="minimal-toggle-row">
            <span><strong>{zh ? "自动下载更新" : "Download updates automatically"}</strong><small>{zh ? "后台检查并下载，准备好后提醒你重启安装。" : "Checks in the background and asks you to restart when ready."}</small></span>
            <span className="switch"><input type="checkbox" aria-label={zh ? "自动下载更新" : "Download updates automatically"} checked={preferences.automaticUpdates} onChange={event => updatePreferences({ automaticUpdates: event.target.checked })} /><i /></span>
          </label>
        </section>
        <footer className="minimal-footer"><span>{labels.source}</span><button type="button" onClick={onClose}>{labels.done}</button></footer>
        </div> : <>
        <section className="minimal-status-card" aria-label={labels.status}>
          <div className="minimal-status-mark" aria-hidden="true"><span /></div>
          <div><strong>{productName}</strong></div>
          <div className="minimal-status-actions">
            <button type="button" className="minimal-external-link" onClick={onOpenCodexResets} aria-label={labels.codexResets} title={labels.codexResets}><ArrowSquareOut weight="bold" /></button>
            <button type="button" className="minimal-refresh" onClick={onRefresh}><ArrowClockwise /><span>{labels.refresh}</span></button>
          </div>
        </section>

        <ResetRiskQuotaHeatmap
          language={language}
          comfortPersonName={selectedPersonName}
          comfortCurve={selectedPersonCurve}
          currentRemainingPercent={dailyRecommendation?.dayPlan?.remainingPercent ?? weeklyRemainingPercent}
          currentRiskPercent={dailyRecommendation?.resetRiskPercent ?? null}
          daysLeftInCycle={dailyRecommendation?.futureDays ?? null}
          todayUsedPercent={dailyRecommendation?.dayPlan ? 0 : dailyRecommendation?.todayUsedPercent ?? 0}
          dayPlan={dailyRecommendation?.dayPlan}
          todayFractionRemaining={dailyRecommendation?.todayFractionRemaining ?? 1}
          isWeekend={(dailyRecommendation?.weekday ?? 0) >= 5}
        />

        <PersonComfortSection curve={selectedPersonCurve} data={comfortUsage} personId={comfortPersonId} records={comfortFeedback} dailyUsage={dailyUsage} dailyUsageHistory={dailyUsageHistory} language={language} loadingError={comfortUsageError} saving={comfortSaving} error={comfortSaveError} onPersonChange={onComfortPersonChange} onChange={onComfortFeedback} onRefreshSnapshot={onComfortSnapshotRefresh} />

        <footer className="minimal-footer"><span>{labels.source}</span><button type="button" onClick={onClose}>{labels.done}</button></footer>
        </>}
      </div>
      <aside className="usage-calendar control-calendar-side" ref={setCalendarPortalTarget} aria-label={zh ? "日历侧栏" : "Calendar side panel"} />
    </section>
  );
}
