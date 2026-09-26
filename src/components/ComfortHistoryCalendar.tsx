import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { localDateKey } from "../lib/comfortFeedback";
import { buildTokenComfortSnapshot } from "../lib/tokenComfort";
import { formatTokens, type TokeiUsage } from "../lib/tokeiUsage";
import type { CodexDailyUsage, ComfortCode, ComfortFeedbackRecord, ComfortQuotaAllocation, DailyUsageSummary, Language } from "../types";
import "./ComfortHistoryCalendar.css";

interface ComfortHistoryCalendarProps {
  records: readonly ComfortFeedbackRecord[];
  dailyUsage?: readonly DailyUsageSummary[];
  dailyUsageHistory?: readonly CodexDailyUsage[];
  language: Language;
  onChange: (localDate: string, comfort: ComfortCode) => void;
  tokenMode?: boolean;
  personPercentMode?: boolean;
  percentByDate?: Record<string, ComfortQuotaAllocation>;
  personId?: string | null;
  usageData?: TokeiUsage | null;
  saving?: boolean;
  onRefreshSnapshot?: (localDate: string) => void;
}

export const COMFORT_EMOJI: Record<ComfortCode, string> = {
  overloaded: "😣",
  comfortable: "🙂",
  idle: "😌",
};

const COMFORT_CODES: readonly ComfortCode[] = ["overloaded", "comfortable", "idle"];
type CalendarView = "week" | "month";

function dateFromLocalDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

function calendarDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function recentWeekDays(end: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end);
    date.setDate(end.getDate() - 6 + index);
    return date;
  });
}

function formatMonth(month: Date, language: Language): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "long" }).format(month);
}

function formatSelectedDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { month: "short", day: "numeric", weekday: "short" }).format(dateFromLocalDate(value));
}

function formatWeekday(value: Date, language: Language): string {
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { weekday: "short" }).format(value);
}

function formatWeekRange(days: readonly Date[], language: Language): string {
  const locale = language === "en" ? "en-US" : "zh-CN";
  const start = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(days[0]);
  const end = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(days[days.length - 1]);
  return `${start}–${end}`;
}

function formatUsagePercent(value: number, language: Language, coverage: CodexDailyUsage["coverage"] | "legacy" = "complete"): string {
  const formatted = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 }).format(value);
  return `${coverage === "partial" ? "≥" : ""}${formatted}%`;
}

export function ComfortHistoryCalendar({ records, dailyUsage = [], dailyUsageHistory = [], language, onChange, tokenMode = false, personPercentMode = false, percentByDate = {}, personId = null, usageData = null, saving = false, onRefreshSnapshot }: ComfortHistoryCalendarProps) {
  const today = localDateKey(new Date());
  const [view, setView] = useState<CalendarView>("week");
  const [visibleWeekEnd, setVisibleWeekEnd] = useState(() => dateFromLocalDate(today));
  const followsCurrentWeek = useRef(true);
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12));
  const [selectedDate, setSelectedDate] = useState(today);
  const labels = language === "en"
    ? {
        title: "Experience history",
        range: "History range",
        week: "Last 7 days",
        month: "Month",
        previousWeek: "Previous 7 days",
        nextWeek: "Next 7 days",
        previous: "Previous month",
        next: "Next month",
        today: "Today",
        editor: "Set experience",
        noRecord: "No entry",
        recorded: "Recorded",
        weeklyUsage: "weekly quota used",
        options: { overloaded: "Too much", comfortable: "Just right", idle: "Easy" } as Record<ComfortCode, string>,
      }
    : {
        title: "体验记录",
        range: "记录范围",
        week: "最近一周",
        month: "一月",
        previousWeek: "前 7 天",
        nextWeek: "后 7 天",
        previous: "上个月",
        next: "下个月",
        today: "今天",
        editor: "选择当天体验",
        noRecord: "未记录",
        recorded: "已记录",
        weeklyUsage: "周额度用量",
        options: { overloaded: "有点撑", comfortable: "刚刚好", idle: "很轻松" } as Record<ComfortCode, string>,
      };
  const monthWeekdays = language === "en" ? ["M", "T", "W", "T", "F", "S", "S"] : ["一", "二", "三", "四", "五", "六", "日"];
  const weekDays = useMemo(() => recentWeekDays(visibleWeekEnd), [visibleWeekEnd]);
  const days = useMemo(() => view === "week" ? weekDays : calendarDays(visibleMonth), [view, weekDays, visibleMonth]);
  const weekdays = view === "week" ? days.map(date => formatWeekday(date, language)) : monthWeekdays;
  const periodLabel = view === "week" ? formatWeekRange(days, language) : formatMonth(visibleMonth, language);
  const recordsByDate = useMemo(() => new Map(records.map((record) => [record.localDate, record])), [records]);
  const dailyUsageByDate = useMemo(() => {
    const result = new Map<string, Omit<Pick<CodexDailyUsage, "localDate" | "observedUsedPercent" | "sampleCount" | "coverage">, "coverage"> & { coverage: CodexDailyUsage["coverage"] | "legacy" }>();
    if (dailyUsageHistory.length > 0) {
      for (const usage of dailyUsageHistory) {
        if (usage.coverage === "unavailable" || usage.sampleCount <= 0 || !Number.isFinite(usage.observedUsedPercent)) continue;
        result.set(usage.localDate, usage);
      }
      return result;
    }
    for (const usage of dailyUsage) {
      if (usage.provider !== "codex" || usage.sampleCount <= 0 || !Number.isFinite(usage.observedUsedPercent)) continue;
      const existing = result.get(usage.localDate);
      if (!existing || existing.observedUsedPercent !== usage.observedUsedPercent) result.set(usage.localDate, { ...usage, coverage: "legacy" });
    }
    return result;
  }, [dailyUsage, dailyUsageHistory]);
  const selectedRecord = selectedDate ? recordsByDate.get(selectedDate) : undefined;
  const selectedIsFuture = selectedDate > today;
  const snapshotFor = (date: string) => recordsByDate.get(date)?.tokenSnapshot ?? (personId && usageData ? buildTokenComfortSnapshot(usageData, personId, date) : null);
  const tokenText = (date: string) => {
    const snapshot = snapshotFor(date);
    return snapshot && snapshot.coverage !== "unavailable" ? `${snapshot.coverage === "partial" ? "≥" : ""}${formatTokens(snapshot.totalTokens, language !== "en")}` : null;
  };
  const allocationFor = (date: string) => recordsByDate.get(date)?.quotaAllocation ?? percentByDate[date] ?? null;
  const percentText = (date: string) => {
    const record = recordsByDate.get(date);
    if (!personId && !record?.personId) return record?.observedUsedPercent != null ? formatUsagePercent(record.observedUsedPercent, language) : null;
    const allocation = allocationFor(date);
    return allocation?.allocatedUsedPercent != null && allocation.coverage !== "unavailable" ? `≈${formatUsagePercent(allocation.allocatedUsedPercent, language)}${allocation.coverage === "partial" ? "*" : ""}` : null;
  };
  const selectedSnapshot = tokenMode || personPercentMode ? snapshotFor(selectedDate) : null;
  const selectedTokenText = tokenMode ? tokenText(selectedDate) : null;

  useEffect(() => {
    if (followsCurrentWeek.current) setVisibleWeekEnd(dateFromLocalDate(today));
  }, [today]);

  const moveMonth = (offset: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));
  };

  const moveWeek = (offset: number) => {
    followsCurrentWeek.current = false;
    setVisibleWeekEnd((current) => {
      const next = new Date(current);
      next.setDate(current.getDate() + offset * 7);
      return next;
    });
  };

  const goToday = () => {
    const now = new Date();
    followsCurrentWeek.current = true;
    setVisibleWeekEnd(dateFromLocalDate(localDateKey(now)));
    setVisibleMonth(new Date(now.getFullYear(), now.getMonth(), 1, 12));
    setSelectedDate(localDateKey(now));
  };

  return (
    <section className="comfort-history-panel" aria-label={labels.title}>
      <header className="comfort-history-header">
        <div className="comfort-history-heading">
          <strong>{labels.title}</strong>
          <div className="comfort-history-view-toggle" role="group" aria-label={labels.range}>
            <button type="button" aria-pressed={view === "week"} onClick={() => setView("week")}>{labels.week}</button>
            <button type="button" aria-pressed={view === "month"} onClick={() => setView("month")}>{labels.month}</button>
          </div>
        </div>
        <div className="comfort-history-nav">
          <button type="button" aria-label={view === "week" ? labels.previousWeek : labels.previous} title={view === "week" ? labels.previousWeek : labels.previous} onMouseDown={(event) => event.stopPropagation()} onClick={() => view === "week" ? moveWeek(-1) : moveMonth(-1)}><CaretLeft weight="bold" /></button>
          <strong>{periodLabel}</strong>
          <button type="button" aria-label={view === "week" ? labels.nextWeek : labels.next} title={view === "week" ? labels.nextWeek : labels.next} onMouseDown={(event) => event.stopPropagation()} onClick={() => view === "week" ? moveWeek(1) : moveMonth(1)}><CaretRight weight="bold" /></button>
          <button type="button" className="comfort-history-today" onMouseDown={(event) => event.stopPropagation()} onClick={goToday}>{labels.today}</button>
        </div>
      </header>

      <div className="comfort-history-weekdays" role="row" aria-hidden="true">
        {weekdays.map((weekday, index) => <span key={`${weekday}-${index}`}>{weekday}</span>)}
      </div>
      <div className={`comfort-history-grid${view === "week" ? " comfort-history-grid--week" : ""}`} role="grid" aria-label={periodLabel}>
        {days.map((date) => {
          const dateKey = localDateKey(date);
          const record = recordsByDate.get(dateKey);
          const usage = dailyUsageByDate.get(dateKey);
          const usagePercent = personPercentMode ? percentText(dateKey) : tokenMode ? tokenText(dateKey) : usage ? formatUsagePercent(usage.observedUsedPercent, language, usage.coverage) : null;
          const usageLabel = tokenMode ? "Token" : labels.weeklyUsage;
          const isOutside = view === "month" && date.getMonth() !== visibleMonth.getMonth();
          const isFuture = dateKey > today;
          const isSelected = dateKey === selectedDate;
          return (
            <button
              key={dateKey}
              type="button"
              role="gridcell"
              className={`comfort-history-day${tokenMode || personPercentMode ? " is-token-day" : ""}${isOutside ? " is-outside" : ""}${isSelected ? " is-selected" : ""}${dateKey === today ? " is-today" : ""}${isFuture ? " is-future" : ""}`}
              aria-label={`${formatSelectedDate(dateKey, language)} · ${record ? labels.options[record.comfort] : labels.noRecord}${usagePercent !== null ? ` · ${usageLabel} ${usagePercent}` : ""}`}
              title={usagePercent !== null ? `${usageLabel} ${usagePercent}` : undefined}
              aria-selected={isSelected}
              disabled={isFuture}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setSelectedDate(dateKey)}
            >
              <span className="comfort-history-day-number">{date.getDate()}</span>
              <span className="comfort-history-day-detail" aria-hidden="true">
                {record ? <span className="comfort-history-day-emoji">{COMFORT_EMOJI[record.comfort]}</span> : null}
                {usagePercent !== null ? <small className="comfort-history-day-usage">{tokenMode ? usagePercent.replace(/(\d+)\.\d{2}M$/, (_, whole: string) => Number(whole) >= 10 ? `${whole}M` : usagePercent.replace(/0M$/, "M")) : usagePercent}</small> : null}
              </span>
            </button>
          );
        })}
      </div>

      {selectedDate ? (
        <div className="comfort-history-editor" aria-label={labels.editor}>
          {!personPercentMode && <div className="comfort-history-editor-heading">
            <strong>{formatSelectedDate(selectedDate, language)}</strong>
            <small>{selectedRecord ? labels.recorded : labels.noRecord}</small>
          </div>}
          {tokenMode && <div className="comfort-token-detail">
            <p>{selectedTokenText ? `${selectedRecord?.tokenSnapshot ? (language === "en" ? "Saved snapshot" : "已保存快照") : (language === "en" ? "Current daily ledger" : "当前日账")} · ${selectedTokenText} Token` : (language === "en" ? "No token snapshot for this day" : "这一天暂无 Token 快照")}</p>
            {selectedSnapshot && selectedSnapshot.coverage !== "unavailable" && <details>
              <summary>{language === "en" ? "Usage breakdown and coverage" : "用量明细与覆盖情况"}</summary>
              <dl>
                <div><dt>{language === "en" ? "Uncached input" : "非缓存输入"}</dt><dd>{formatTokens(selectedSnapshot.inputTokens, language !== "en")}</dd></div>
                <div><dt>{language === "en" ? "Cached input" : "缓存输入"}</dt><dd>{formatTokens(selectedSnapshot.cachedInputTokens, language !== "en")}</dd></div>
                <div><dt>{language === "en" ? "Output" : "输出"}</dt><dd>{formatTokens(selectedSnapshot.outputTokens, language !== "en")}</dd></div>
                <div><dt>{language === "en" ? "Reasoning (within output)" : "推理（已含在输出中）"}</dt><dd>{formatTokens(selectedSnapshot.reasoningTokens, language !== "en")}</dd></div>
              </dl>
              <p>{language === "en" ? "Devices" : "设备"}：{selectedSnapshot.deviceIds.length} · {selectedSnapshot.coverage === "complete" ? (language === "en" ? "Complete" : "完整日账") : (language === "en" ? "Partial; not used for fitting" : "部分记录，不参与拟合")}</p>
              {selectedSnapshot.missingDeviceIds.length > 0 && <p>{language === "en" ? "Missing devices" : "缺失设备"}：{selectedSnapshot.missingDeviceIds.join("、")}</p>}
              <p>{language === "en" ? "Captured" : "采集时间"}：{new Date(selectedSnapshot.observedAt).toLocaleString(language === "en" ? "en-US" : "zh-CN")}</p>
              <ul>{selectedSnapshot.models.map(model => <li key={model.id}>{model.name} · {formatTokens(model.totalTokens, language !== "en")}</li>)}</ul>
            </details>}
            {selectedRecord?.observedUsedPercent !== null && selectedRecord?.observedUsedPercent !== undefined && <p>{language === "en" ? "Quota reference (04:00 day boundary, not token conversion)" : "额度参考（04:00 日界，不与 Token 换算）"}：{selectedRecord.observedUsedPercent.toFixed(1)}%</p>}
            {personId && selectedRecord && onRefreshSnapshot && <button type="button" className="usage-text-button" disabled={saving} onClick={() => onRefreshSnapshot(selectedDate)}>{language === "en" ? "Update this day's token snapshot" : "更新该日 Token 快照"}</button>}
          </div>}
          <div className="comfort-history-options" role="radiogroup" aria-label={labels.editor}>
            {COMFORT_CODES.map((comfort) => (
              <button
                key={comfort}
                type="button"
                className={selectedRecord?.comfort === comfort ? "is-active" : ""}
                role="radio"
                aria-checked={selectedRecord?.comfort === comfort}
                aria-label={labels.options[comfort]}
                disabled={selectedIsFuture || saving || ((tokenMode || personPercentMode) && !personId && !selectedRecord)}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => onChange(selectedDate, comfort)}
              >
                <span aria-hidden="true">{COMFORT_EMOJI[comfort]}</span>
                <small>{labels.options[comfort]}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
