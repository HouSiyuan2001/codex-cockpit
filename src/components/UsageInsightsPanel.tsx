import { CalendarDots, ChartLineUp, Gauge, X } from "@phosphor-icons/react";
import { useMemo } from "react";
import { clampPercent, formatResetTime } from "../lib/format";
import {
  buildQuotaTrendGeometry,
  buildUsageCalendar,
  mondayWeekdayIndex,
  observedTrendUse,
  recentQuotaTrend,
  usageSummary,
} from "../lib/usageInsights";
import { calculateQuotaPace, paceBaselineKey, trackedQuotaWindows } from "../lib/quotaPace";
import type { DailyRecommendation } from "../lib/dynamicQuota";
import type { PersonalUsageCalibration, PersonalUsageFallbackReason } from "../lib/personalUsageModel";
import type { DailyPaceBaseline, DailyUsageSummary, Language, ProviderSnapshot, QuotaHistoryPoint, ResetForecast } from "../types";

interface Props {
  snapshot: ProviderSnapshot;
  history: QuotaHistoryPoint[];
  dailyUsage: DailyUsageSummary[];
  paceBaselines: Record<string, DailyPaceBaseline>;
  language: Language;
  resetForecast?: ResetForecast | null;
  dailyRecommendation?: DailyRecommendation | null;
  personalUsageCalibration?: PersonalUsageCalibration | null;
  onOpenResetForecast?: (url: string) => void;
  onClose?: () => void;
}

function percent(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits).replace(/\.0$/, "")}%`;
}

function fallbackLabel(reason: PersonalUsageFallbackReason, english: boolean): string {
  const labels: Record<PersonalUsageFallbackReason, [string, string]> = {
    none: ["personal pattern verified", "个人模式已验证"],
    "insufficient-calendar-span": ["less than 3 weeks", "不足 3 周"],
    "insufficient-planned-days": ["too few planned days", "建议日样本不足"],
    "insufficient-active-days": ["too few active days", "活跃日样本不足"],
    "insufficient-weekday-weekend-balance": ["weekday/weekend imbalance", "工作日/周末样本失衡"],
    "stale-history": ["local history is stale", "本地历史已过期"],
    "distribution-drift": ["recent pattern drift", "近期模式漂移"],
    "no-holdout-gain": ["no holdout improvement", "留出集没有改善"],
  };
  return labels[reason][english ? 0 : 1];
}

export function UsageInsightsPanel({ snapshot, history, dailyUsage, paceBaselines, language, resetForecast = null, dailyRecommendation = null, personalUsageCalibration = null, onOpenResetForecast, onClose }: Props) {
  const english = language === "en";
  const now = new Date();
  const windows = trackedQuotaWindows(snapshot);
  const primaryWindow = windows.find((item) => item.period === "weekly") ?? windows[0] ?? null;
  const remaining = primaryWindow ? clampPercent(primaryWindow.window.remainingPercent) : null;
  const pace = primaryWindow
    ? calculateQuotaPace(primaryWindow.window, now, paceBaselines[paceBaselineKey(snapshot.provider, primaryWindow.period)] ?? null)
    : null;
  const calendar = useMemo(
    () => buildUsageCalendar(dailyUsage, history, snapshot.provider, now),
    [dailyUsage, history, snapshot.provider],
  );
  const summary = useMemo(() => usageSummary(calendar), [calendar]);
  const trend = useMemo(
    () => recentQuotaTrend(history, snapshot.provider, remaining, now),
    [history, remaining, snapshot.provider],
  );
  const geometry = buildQuotaTrendGeometry(trend, now);
  const trendUse = observedTrendUse(trend);
  const guide = dailyRecommendation?.targetPercent ?? (pace ? pace.averageRate : null);
  const guideLabel = dailyRecommendation
    ? (english ? "Suggested today" : "今日建议")
    : pace?.unit === "hour"
    ? (english ? "Hourly guide" : "每小时建议")
    : (english ? "Daily guide" : "每日建议");
  const cycleUsed = remaining === null ? null : 100 - remaining;
  const leadingCells = calendar[0] ? mondayWeekdayIndex(calendar[0].date) : 0;
  const dateFormatter = new Intl.DateTimeFormat(english ? "en-US" : "zh-CN", { month: "short", day: "numeric" });
  const forecastWindow = resetForecast?.windowHours ?? 48;
  const forecastHistoryCount = resetForecast?.historySampleCount ?? resetForecast?.historyResetDates?.length ?? 0;
  const forecastMeta = resetForecast?.resetAnnounced
    ? (english ? "Provider reset announced" : "平台已宣布重置")
    : forecastHistoryCount > 0
      ? (english ? `calibrated ${forecastWindow}h · ${forecastHistoryCount} clean records` : `校准 ${forecastWindow} 小时 · ${forecastHistoryCount} 条清洗记录`)
      : (english ? `calibrated ${forecastWindow}h · local fallback` : `校准 ${forecastWindow} 小时 · 本地回退`);

  return (
    <section className="usage-insights-panel" aria-label={english ? "Usage insights" : "用量洞察"} onMouseDown={(event) => event.stopPropagation()}>
      <header className="usage-insights-header">
        <div>
          <p><ChartLineUp weight="bold" />{english ? "LOCAL SIGNAL" : "本地信号"}</p>
          <h2>{snapshot.displayName} {english ? "usage rhythm" : "用量节奏"}</h2>
          <small>{english ? "Provider quota + local observations" : "平台额度 + 本地观测"}</small>
        </div>
        {onClose ? <button type="button" onClick={onClose} aria-label={english ? "Close usage insights" : "关闭用量洞察"}><X /></button> : null}
      </header>

      <div className={`usage-summary-strip${resetForecast ? " usage-summary-strip--forecast" : ""}`}>
        <article className="usage-stat-card">
          <span>{english ? "Remaining" : "剩余额度"}</span>
          <strong>{percent(remaining, 0)}</strong>
          <small>{primaryWindow ? formatResetTime(primaryWindow.window.resetsAt, now, language) : (english ? "Quota unavailable" : "暂无额度")}</small>
        </article>
        <article className="usage-stat-card">
          <span>{english ? "Used this cycle" : "本周期已用"}</span>
          <strong>{percent(cycleUsed, 0)}</strong>
          <small>{english ? "provider quota" : "平台额度"}</small>
        </article>
        <article className="usage-stat-card">
          <span>{english ? "Today observed" : "今日观测"}</span>
          <strong>{percent(summary.todayUsedPercent)}</strong>
          <small>{english ? "local history" : "本地历史"}</small>
        </article>
        <article className="usage-stat-card">
          <span>{guideLabel}</span>
          <strong>{percent(guide)}</strong>
          <small>{dailyRecommendation ? `${english ? "safe cap" : "安全上限"} ${dailyRecommendation.safetyCapPercent}% · ${dailyRecommendation.historySampleCount || 0} ${english ? "history" : "历史样本"}` : pace?.status === "over_pace" ? (english ? "currently over guide" : "当前高于建议") : (english ? "based on this cycle" : "按本周期计算")}</small>
        </article>
        {resetForecast ? (
          <button
            type="button"
            className={`usage-stat-card usage-stat-card--forecast${resetForecast.resetAnnounced ? " usage-stat-card--announced" : ""}`}
            onClick={() => onOpenResetForecast?.(resetForecast.sourceUrl)}
            title={english ? "Unofficial calibrated reset likelihood. Open dashboard." : "非官方校准重置概率。打开仪表盘。"}
          >
            <span><Gauge weight="bold" />{english ? "Reset outlook" : "重置展望"}</span>
            <strong>{resetForecast.resetAnnounced ? (english ? "Announced" : "已宣布") : `${Math.round(resetForecast.score)}%`}</strong>
            <small>{forecastMeta}</small>
          </button>
        ) : null}
      </div>

      <div className="usage-insights-detail-grid">
        <article className="usage-trend-card">
          <header><span>{english ? "24H QUOTA TRAJECTORY" : "24 小时额度轨迹"}</span><strong>{trend.length > 1 ? `${trendUse.toFixed(1)}%` : "—"}</strong></header>
          <svg viewBox="0 0 220 74" preserveAspectRatio="none" role="img" aria-label={english ? "Remaining quota trajectory" : "剩余额度轨迹"}>
            <defs><linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".24" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
            <path className="usage-trend-grid" d="M 4 14 H 216 M 4 42 H 216 M 4 70 H 216" />
            {geometry ? <><path className="usage-trend-area" d={geometry.area} /><path className="usage-trend-line" d={geometry.line} /></> : null}
          </svg>
          <footer><span>{english ? "24h ago" : "24 小时前"}</span><span>{english ? "now" : "现在"}</span></footer>
        </article>

        <article className="usage-calendar-card">
          <header>
            <span><CalendarDots weight="duotone" />{english ? "Last 90 days" : "近 90 天"}</span>
            <small>{english ? `${summary.activeDays} active days · ${percent(summary.averageActiveDayPercent)} avg` : `${summary.activeDays} 个活跃日 · 日均 ${percent(summary.averageActiveDayPercent)}`}</small>
          </header>
          <div className="usage-calendar-body">
            <div className="usage-weekdays" aria-hidden="true"><span>{english ? "M" : "一"}</span><span>{english ? "W" : "三"}</span><span>{english ? "F" : "五"}</span><span>{english ? "S" : "日"}</span></div>
            <div className="usage-calendar-grid" role="img" aria-label={english ? "90 day observed usage heatmap" : "90 天已观测用量热力图"}>
              {Array.from({ length: leadingCells }, (_, index) => <i className="usage-day usage-day--spacer" key={`spacer-${index}`} />)}
              {calendar.map((day) => (
                <i
                  className={`usage-day usage-day--${day.level}${day.observedUsedPercent === null ? " usage-day--unknown" : ""}`}
                  key={day.localDate}
                  title={`${dateFormatter.format(day.date)} · ${day.observedUsedPercent === null ? (english ? "no local sample" : "无本地样本") : percent(day.observedUsedPercent)}`}
                />
              ))}
            </div>
            <div className="usage-calendar-legend" aria-hidden="true"><span>{english ? "less" : "少"}</span>{[0, 1, 2, 3, 4].map((level) => <i className={`usage-day usage-day--${level}`} key={level} />)}<span>{english ? "more" : "多"}</span></div>
          </div>
        </article>
      </div>
      {personalUsageCalibration ? (
        <article className={`usage-personal-model${personalUsageCalibration.mode === "personalized" ? " is-personalized" : ""}`}>
          <header>
            <div>
              <span>{english ? "LOCAL WEEK PATTERN" : "本机星期模式"}</span>
              <strong>{personalUsageCalibration.mode === "personalized" ? (english ? "Personal guide" : "个人校准") : (english ? "Generic fallback" : "通用策略回退")}</strong>
            </div>
            <small>{fallbackLabel(personalUsageCalibration.reason, english)} · {personalUsageCalibration.plannedDays} {english ? "planned days" : "个建议日"}</small>
          </header>
          <div className="usage-personal-weekdays">
            {personalUsageCalibration.weekdayStats.map((stat) => (
              <div key={stat.weekday}>
                <span>{(english ? ["M", "T", "W", "T", "F", "S", "S"] : ["一", "二", "三", "四", "五", "六", "日"])[stat.weekday]}</span>
                <strong>{stat.plannedDays > 0 ? `${Math.round(stat.rememberRate * 100)}%` : "—"}</strong>
                <small>{stat.plannedDays > 0 ? `${english ? "use" : "利用"} ${Math.round(stat.meanUtilization * 100)}% · ${english ? "over" : "超用"} ${stat.meanOverusePercent.toFixed(1)}%` : (english ? "no sample" : "无样本")}</small>
              </div>
            ))}
          </div>
          <footer>
            {personalUsageCalibration.validation
              ? `${english ? "holdout MAE" : "留出误差"} ${personalUsageCalibration.validation.genericMae.toFixed(1)} → ${personalUsageCalibration.validation.personalizedMae.toFixed(1)} · ${english ? "waste" : "过期浪费"} ${personalUsageCalibration.validation.genericExpiredWaste.toFixed(1)} → ${personalUsageCalibration.validation.personalizedExpiredWaste.toFixed(1)} · ${english ? "effective" : "有效产出"} ${personalUsageCalibration.validation.genericEffectiveOutput.toFixed(1)} → ${personalUsageCalibration.validation.personalizedEffectiveOutput.toFixed(1)}`
              : (english ? "Needs 21 planned days, 12 active days, balanced weekdays/weekends, and a fresh 7-day holdout." : "至少需要 21 个建议日、12 个活跃日、平衡的工作日/周末样本和新鲜的 7 日留出集。")}
          </footer>
        </article>
      ) : null}
      <footer className="usage-insights-footnote">{english ? "Local history only · no prompt or token content is collected" : "仅使用本地历史 · 不收集提示词或 token 内容"}</footer>
    </section>
  );
}
