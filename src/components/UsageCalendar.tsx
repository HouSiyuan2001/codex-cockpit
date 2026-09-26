import { useId, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { calendarMonthCellCount, calendarRange, calendarValue, dateAtNoon, isoWeekNumber, rangeLabel, shiftDate, type CalendarScale, type UsageDateRange } from "../lib/usageCalendar";
import { formatCost, formatTokens, localDateKey, type TokeiDevice, type UsageMetric } from "../lib/tokeiUsage";
import { calendarHeatmapColor, calendarHeatmapTextColor } from "../lib/usageHeatmapColor";
import "./UsageCalendar.css";

const scales: CalendarScale[] = ["day", "week", "month", "quarter", "year"];
const scaleName = (scale: CalendarScale, zh: boolean) => ({ day: zh ? "日" : "Day", week: zh ? "周" : "Week", month: zh ? "月" : "Month", quarter: zh ? "季" : "Quarter", year: zh ? "年" : "Year" })[scale];
export function UsageCalendar({ devices, metric, zh, selection, onSelect, onMetricChange, now = new Date(), open: controlledOpen, onOpenChange, portalTarget }: { devices: TokeiDevice[]; metric: UsageMetric; zh: boolean; selection: UsageDateRange | null; onSelect: (range: UsageDateRange | null) => void; onMetricChange: (metric: UsageMetric) => void; now?: Date; open?: boolean; onOpenChange?: (open: boolean) => void; portalTarget?: HTMLElement | null }) {
  const id = useId();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => { if (onOpenChange) onOpenChange(next); else setInternalOpen(next); };
  const [scale, setScale] = useState<CalendarScale>("day");
  const [cursor, setCursor] = useState(() => selection ? dateAtNoon(selection.start) : now);
  const today = localDateKey(now), year = cursor.getFullYear(), month = cursor.getMonth();
  const cells = useMemo(() => {
    if (scale === "day") {
      const first = calendarRange(new Date(year, month, 1, 12), "week");
      return Array.from({ length: calendarMonthCellCount(year, month) }, (_, i) => { const date = shiftDate(dateAtNoon(first.start), i); return { range: calendarRange(date, "day"), label: String(date.getDate()), outside: date.getMonth() !== month }; });
    }
    if (scale === "week") {
      const first = calendarRange(new Date(year, month, 1, 12), "week");
      return Array.from({ length: calendarMonthCellCount(year, month) / 7 }, (_, i) => {
        const date = shiftDate(dateAtNoon(first.start), i * 7);
        return { range: calendarRange(date, "week"), label: zh ? `${isoWeekNumber(date)}周` : `W${isoWeekNumber(date)}`, outside: false };
      });
    }
    const count = scale === "month" ? 12 : scale === "quarter" ? 4 : 12;
    return Array.from({ length: count }, (_, i) => {
      const date = scale === "year" ? new Date(Math.floor(year / 12) * 12 + i, 0, 1, 12) : new Date(year, i * (scale === "quarter" ? 3 : 1), 1, 12);
      return { range: calendarRange(date, scale), label: scale === "year" ? String(date.getFullYear()) : scale === "quarter" ? `Q${i + 1}` : zh ? `${i + 1}月` : date.toLocaleDateString("en-US", { month: "short" }), outside: false };
    });
  }, [scale, year, month, zh]);
  const values = cells.map(cell => calendarValue(devices, cell.range, metric, now));
  const visibleMax = Math.max(0, ...values.map((value, index) => !cells[index].outside ? value.value ?? 0 : 0));
  const previewRange = selection ?? calendarRange(now, "day");
  const previewValue = calendarValue(devices, previewRange, metric, now);
  const displayValue = (value: number) => metric === "cost" ? formatCost(value, zh) : `${formatTokens(value, zh)} Tokens`;
  const select = (range: UsageDateRange | null) => onSelect(range);
  const navigate = (direction: number) => setCursor(new Date(year + (scale === "year" ? direction * 12 : scale === "day" || scale === "week" ? 0 : direction), month + (scale === "day" || scale === "week" ? direction : 0), 1, 12));
  const futurePage = (scale === "day" || scale === "week") ? year * 12 + month >= now.getFullYear() * 12 + now.getMonth() : scale === "year" ? Math.floor(year / 12) >= Math.floor(now.getFullYear() / 12) : year >= now.getFullYear();
  const content = <div id={id} className="usage-calendar-content" role="region" aria-label={zh ? "用量日历" : "Usage calendar"} onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}>
      <div className="usage-calendar-scales">{scales.map(value => <button type="button" key={value} aria-pressed={scale === value} onClick={() => setScale(value)}>{scaleName(value, zh)}</button>)}</div>
      <header><button type="button" aria-label={zh ? "日历上一页" : "Previous calendar page"} onClick={() => navigate(-1)}><CaretLeft /></button><strong>{scale === "day" || scale === "week" ? `${year} / ${month + 1}` : scale === "year" ? `${Math.floor(year / 12) * 12} – ${Math.floor(year / 12) * 12 + 11}` : year}</strong><button type="button" aria-label={zh ? "日历下一页" : "Next calendar page"} disabled={futurePage} onClick={() => navigate(1)}><CaretRight /></button><button type="button" className="usage-calendar-today" aria-label={zh ? "回到今天" : "Jump to today"} onClick={() => { setCursor(now); }}>{zh ? "今" : "Now"}</button><div className="usage-calendar-metric-switch" aria-label={zh ? "日历指标" : "Calendar metric"}><button type="button" aria-pressed={metric === "tokens"} onClick={() => onMetricChange("tokens")}>Token</button><button type="button" aria-pressed={metric === "cost"} onClick={() => onMetricChange("cost")}>{zh ? "成本" : "Cost"}</button></div></header>
      <div className={`usage-calendar-nav-grid usage-calendar-nav-grid--${scale}`} style={scale === "week" ? { "--calendar-week-count": cells.length } as CSSProperties : undefined}>
        {scale === "day" && [zh ? "周" : "Wk", ...(zh ? ["一", "二", "三", "四", "五", "六", "日"] : ["M", "T", "W", "T", "F", "S", "S"])].map((label, i) => <small key={`heading-${i}`}>{label}</small>)}
        {cells.map((cell, i) => {
          const value = values[i], available = value.value !== null;
          const dailyLabel = `${rangeLabel(cell.range)} · ${!available ? (zh ? "暂无数据" : "No data") : metric === "cost" ? formatCost(value.value, zh) : `${formatTokens(value.value!, zh)} Tokens`}${value.partial && available ? (zh ? " · 部分数据" : " · Partial data") : ""}`;
          const selected = selection && cell.range.start >= selection.start && cell.range.end <= selection.end;
          const week = calendarRange(dateAtNoon(cell.range.start), "week");
          const label = dailyLabel;
          return <div className="usage-calendar-cell-group" key={cell.range.start}>
            {scale === "day" && i % 7 === 0 && <button type="button" className="usage-calendar-week" disabled={week.start > today} aria-label={`${zh ? "选择周" : "Select week"} ${rangeLabel(week)}`} onClick={() => select(week)}>{isoWeekNumber(dateAtNoon(week.start))}</button>}
            <button type="button" className={`usage-calendar-cell${cell.outside ? " is-outside" : ""}${!available ? " is-missing" : ""}`} style={available ? { backgroundColor: calendarHeatmapColor(value.value!, 0, visibleMax), color: calendarHeatmapTextColor(value.value!, 0, visibleMax) } : undefined} aria-label={label} aria-pressed={Boolean(selected)} disabled={cell.range.start > today} data-tooltip={label} onClick={() => select(cell.range)}>
              <span>{cell.label}</span>{value.partial && available && <i aria-hidden="true" />}
            </button>
          </div>;
        })}
      </div>
      <div className="usage-calendar-legend" aria-label={zh ? `${metric === "cost" ? "成本" : "Token"}用量色标，橙点为部分数据，灰格为暂无数据` : `${metric === "cost" ? "Cost" : "Token"} usage color scale; amber dot means partial data, gray means unavailable`}><span>{metric === "cost" ? formatCost(0, zh) : "0"}</span><i style={visibleMax === 0 ? { background: calendarHeatmapColor(0, 0, 0) } : undefined} /><span>{metric === "cost" ? formatCost(visibleMax, zh) : formatTokens(visibleMax, zh)}</span></div>
    </div>;
  return <div className="usage-calendar">
    <button type="button" className={`usage-calendar-trigger${open || selection ? " is-active" : ""}`} aria-expanded={open} aria-controls={id} title={`${rangeLabel(previewRange)} · ${previewValue.value === null ? zh ? "暂无数据" : "No data" : displayValue(previewValue.value)}`} onClick={() => setOpen(!open)}><span className={`usage-calendar-trigger-tile${previewValue.value === null ? " is-missing" : ""}`} style={previewValue.value === null ? undefined : { backgroundColor: calendarHeatmapColor(previewValue.value, 0, visibleMax) }} aria-hidden="true" />{zh ? "日历" : "Calendar"}</button>
    {open && (portalTarget ? createPortal(content, portalTarget) : content)}
  </div>;
}
