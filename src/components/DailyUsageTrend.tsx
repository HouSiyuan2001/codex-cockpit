import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent, useEffect, useMemo, useRef, useState } from "react";
import { formatCost, formatTokens, localDateKey, metricValue, type TokeiDevice, type UsageMetric } from "../lib/tokeiUsage";
import "./DailyUsageTrend.css";
import "./DailyUsageTrend.theme.css";

export type TrendGranularity = "day" | "week" | "month";

export interface UsageTrendPoint {
  key: string;
  start: string;
  end: string;
  value: number | null;
  partial: boolean;
}

interface TrendBucket {
  key: string;
  start: string;
  end: string;
}

interface DailyUsageTrendProps {
  devices: TokeiDevice[];
  metric: UsageMetric;
  zh: boolean;
  now?: Date;
  /** Move the visible window so that this local calendar date is its newest bucket. */
  anchorDate?: string | null;
  /** Explicitly return to the latest window when the surrounding scope changes. */
  resetKey?: string | number | null;
}

const GRANULARITIES: readonly TrendGranularity[] = ["day", "week", "month"];
const DAY_MS = 86_400_000;

function localNoon(date: string): Date {
  return new Date(`${date}T12:00:00`);
}

function validDateKey(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return localDateKey(localNoon(value)) === value;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
}

function startOfWeek(date: Date): Date {
  return addDays(date, -((date.getDay() + 6) % 7));
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
}

function clampAnchor(value: string | null | undefined, today: string): string {
  return validDateKey(value) ? [value, today].sort()[0] : today;
}

function bucketDates(bucket: TrendBucket): string[] {
  const start = localNoon(bucket.start);
  const end = localNoon(bucket.end);
  const length = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
  return Array.from({ length: Math.max(0, length) }, (_, index) => localDateKey(addDays(start, index)));
}

export function buildTrendBuckets(granularity: TrendGranularity, anchorDate: string, now = new Date()): TrendBucket[] {
  const today = localDateKey(now);
  const anchor = localNoon(clampAnchor(anchorDate, today));
  if (granularity === "day") {
    const first = addDays(anchor, -6);
    return Array.from({ length: 7 }, (_, index) => {
      const date = localDateKey(addDays(first, index));
      return { key: date, start: date, end: date };
    });
  }
  if (granularity === "week") {
    const lastWeek = startOfWeek(anchor);
    const first = addDays(lastWeek, -42);
    return Array.from({ length: 7 }, (_, index) => {
      const start = localDateKey(addDays(first, index * 7));
      const naturalEnd = localDateKey(addDays(first, index * 7 + 6));
      return { key: start, start, end: [naturalEnd, today].sort()[0] };
    });
  }
  const lastMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const first = addMonths(lastMonth, -5);
  return Array.from({ length: 6 }, (_, index) => {
    const cursor = addMonths(first, index);
    const start = localDateKey(cursor);
    const naturalEnd = localDateKey(endOfMonth(cursor));
    return { key: start.slice(0, 7), start, end: [naturalEnd, today].sort()[0] };
  });
}

function newestDevices(devices: readonly TokeiDevice[]): TokeiDevice[] {
  const result = new Map<string, TokeiDevice>();
  for (const device of devices) {
    const previous = result.get(device.id);
    if (!previous || (Date.parse(device.updatedAt ?? "") || 0) >= (Date.parse(previous.updatedAt ?? "") || 0)) result.set(device.id, device);
  }
  return [...result.values()];
}

function knownMetric(day: TokeiDevice["daily"][string], metric: UsageMetric): { value: number | null; partial: boolean } {
  const direct = metricValue(day, metric);
  if (direct !== null) return { value: direct, partial: metric === "cost" && day.models.some((model) => model.costIncomplete) };
  if (metric !== "cost") return { value: null, partial: true };
  const modelCosts = day.models.flatMap((model) => model.estimatedCostUsd === null ? [] : [model.estimatedCostUsd]);
  return { value: modelCosts.length ? modelCosts.reduce((sum, value) => sum + value, 0) : null, partial: true };
}

export function aggregateUsageTrend(
  devices: TokeiDevice[],
  granularity: TrendGranularity,
  metric: UsageMetric,
  now = new Date(),
  anchorDate = localDateKey(now),
): UsageTrendPoint[] {
  const today = localDateKey(now);
  const unique = newestDevices(devices);
  return buildTrendBuckets(granularity, anchorDate, now).map((bucket) => {
    let value = 0;
    let known = false;
    let partial = bucket.end === today;
    for (const device of unique) {
      if (device.stale || device.collectionPartial) partial = true;
      for (const date of bucketDates(bucket)) {
        const day = device.daily[date];
        if (!day) {
          partial = true;
          continue;
        }
        const metricResult = knownMetric(day, metric);
        if (metricResult.value === null) {
          partial = true;
          continue;
        }
        known = true;
        value += metricResult.value;
        if (metricResult.partial) partial = true;
      }
    }
    return { ...bucket, value: known ? value : null, partial };
  });
}

function shiftAnchor(anchorDate: string, granularity: TrendGranularity, direction: -1 | 1, today: string): string {
  const anchor = localNoon(anchorDate);
  const shifted = granularity === "month"
    ? addMonths(anchor, direction)
    : addDays(anchor, direction * (granularity === "week" ? 7 : 1));
  return clampAnchor(localDateKey(shifted), today);
}

function axisLabel(point: UsageTrendPoint, granularity: TrendGranularity, zh: boolean): string {
  const [, month, day] = point.start.split("-");
  if (granularity === "month") return zh ? `${Number(month)}月` : `${month}/${point.start.slice(2, 4)}`;
  return `${Number(month)}/${Number(day)}`;
}

function intervalLabel(point: UsageTrendPoint, granularity: TrendGranularity, zh: boolean): string {
  if (granularity === "day") return point.start;
  if (granularity === "week") return `${point.start} – ${point.end}`;
  const [year, month] = point.start.split("-");
  return zh ? `${year}年${Number(month)}月` : `${year}-${month}`;
}

function visibleRangeLabel(points: readonly UsageTrendPoint[]): string {
  if (!points.length) return "—";
  const first = points[0].start;
  const last = points[points.length - 1].end;
  const short = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  return first.slice(0, 4) === last.slice(0, 4)
    ? `${short(first)}–${short(last)}`
    : `${first.slice(0, 4)}/${short(first)}–${last.slice(0, 4)}/${short(last)}`;
}

export function DailyUsageTrend({ devices, metric, zh, now = new Date(), anchorDate, resetKey }: DailyUsageTrendProps) {
  const today = localDateKey(now);
  const [granularity, setGranularity] = useState<TrendGranularity>("day");
  const [windowAnchor, setWindowAnchor] = useState(() => clampAnchor(anchorDate, today));
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; lastX: number } | null>(null);
  const wheelDelta = useRef(0);
  const priorInputs = useRef({ anchorDate, resetKey, today });

  useEffect(() => {
    const resetChanged = priorInputs.current.resetKey !== resetKey;
    const anchorChanged = priorInputs.current.anchorDate !== anchorDate;
    const previousToday = priorInputs.current.today;
    const todayChanged = previousToday !== today;
    priorInputs.current = { anchorDate, resetKey, today };
    if (resetChanged) setWindowAnchor(clampAnchor(anchorDate, today));
    else if (anchorChanged) setWindowAnchor(clampAnchor(anchorDate, today));
    else if (todayChanged) setWindowAnchor((current) => current === previousToday ? today : current);
    setActivePoint(null);
  }, [anchorDate, resetKey, today]);

  const points = useMemo(
    () => aggregateUsageTrend(devices, granularity, metric, now, windowAnchor),
    [devices, granularity, metric, now, windowAnchor],
  );
  const values = points.flatMap((point) => point.value === null ? [] : [point.value]);
  const peak = values.length ? Math.max(...values) : null;
  const scaleMax = peak !== null && peak > 0 ? peak : 1;
  const firstLedgerDate = newestDevices(devices).flatMap((device) => Object.keys(device.daily)).filter(validDateKey).sort()[0] ?? null;
  const visibleStart = points[0]?.start ?? windowAnchor;
  const visibleEnd = points.at(-1)?.end ?? windowAnchor;
  // Allow one empty window before the oldest known entry, without inventing data.
  const canMoveEarlier = firstLedgerDate === null || visibleEnd >= firstLedgerDate;
  const canMoveLater = visibleEnd < today;
  const latestWindow = !canMoveLater;

  const moveWindow = (direction: -1 | 1, steps = 1) => {
    if ((direction < 0 && !canMoveEarlier) || (direction > 0 && !canMoveLater)) return;
    setWindowAnchor((current) => {
      let next = current;
      for (let step = 0; step < steps; step++) {
        const end = buildTrendBuckets(granularity, next, now).at(-1)?.end;
        if (direction < 0 && firstLedgerDate !== null && end !== undefined && end < firstLedgerDate) break;
        const shifted = shiftAnchor(next, granularity, direction, today);
        if (shifted === next) break;
        next = shifted;
      }
      return next;
    });
    setActivePoint(null);
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (!horizontal) return;
    event.preventDefault();
    event.stopPropagation();
    wheelDelta.current += horizontal;
    const steps = Math.floor(Math.abs(wheelDelta.current) / 48);
    if (!steps) return;
    moveWindow(wheelDelta.current > 0 ? 1 : -1, steps);
    wheelDelta.current -= Math.sign(wheelDelta.current) * steps * 48;
  };

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  const width = 620;
  const height = 190;
  const left = 76;
  const right = 14;
  const top = 18;
  const bottom = 32;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const x = (index: number) => left + index / (points.length - 1) * innerWidth;
  const y = (value: number) => top + innerHeight * (1 - value / scaleMax);
  const segments: string[] = [];
  const missingBridges: string[] = [];
  let previousKnown: { index: number; value: number } | null = null;
  points.forEach((point, index) => {
    if (point.value === null) return;
    if (previousKnown !== null) {
      const line = `M${x(previousKnown.index).toFixed(1)},${y(previousKnown.value).toFixed(1)} L${x(index).toFixed(1)},${y(point.value).toFixed(1)}`;
      (index - previousKnown.index > 1 ? missingBridges : segments).push(line);
    }
    previousKnown = { index, value: point.value };
  });

  const format = (value: number) => metric === "cost" ? formatCost(value, zh) : formatTokens(value, zh);
  const unitTitle = metric === "cost" ? (zh ? "估算金额" : " estimated cost") : " Token";
  const grainTitle = ({ day: zh ? "每日" : "Daily", week: zh ? "每周" : "Weekly", month: zh ? "每月" : "Monthly" })[granularity];
  const title = `${grainTitle}${unitTitle}`;
  const active = activePoint === null ? null : points[activePoint];
  const tooltipWidth = 190;
  const tooltipHeight = 43;
  const activeX = activePoint === null ? 0 : x(activePoint);
  const activeY = active?.value === null || active?.value === undefined ? 0 : y(active.value);
  const tooltipX = Math.min(width - right - tooltipWidth, Math.max(left, activeX - tooltipWidth / 2));
  const tooltipY = activeY - tooltipHeight - 10 < top ? activeY + 10 : activeY - tooltipHeight - 10;

  return <section className="daily-usage-trend" aria-label={title}>
    <header>
      <div className="daily-trend-heading">
        <strong>{title}</strong>
      </div>
    </header>
    <div className="daily-trend-toolbar">
      <div className="daily-trend-granularity" role="group" aria-label={zh ? "曲线周期" : "Trend interval"}>
        {GRANULARITIES.map((value) => <button key={value} type="button" aria-pressed={granularity === value} onClick={() => { setGranularity(value); setActivePoint(null); }}>{({ day: zh ? "日" : "Day", week: zh ? "周" : "Week", month: zh ? "月" : "Month" })[value]}</button>)}
      </div>
      <div className="daily-trend-navigation" role="group" aria-label={zh ? "历史窗口" : "History window"}>
        <button type="button" aria-label={zh ? "往前" : "Earlier"} disabled={!canMoveEarlier} onClick={() => moveWindow(-1)}><CaretLeft weight="bold" /></button>
        <strong title={`${visibleStart} – ${visibleEnd}`}>{visibleRangeLabel(points)}</strong>
        <button type="button" aria-label={zh ? "往后" : "Later"} disabled={!canMoveLater} onClick={() => moveWindow(1)}><CaretRight weight="bold" /></button>
        {!latestWindow && <button type="button" className="daily-trend-latest" onClick={() => { setWindowAnchor(today); setActivePoint(null); }}>{zh ? "今天" : "Today"}</button>}
      </div>
    </div>
    <div
      className="daily-trend-viewport"
      aria-label={zh ? "拖动或横向滚动浏览历史" : "Drag or scroll horizontally through history"}
      onWheel={onWheel}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag.current = { pointerId: event.pointerId, lastX: event.clientX };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.pointerId !== event.pointerId) return;
        const distance = event.clientX - current.lastX;
        const steps = Math.floor(Math.abs(distance) / 48);
        if (!steps) return;
        moveWindow(distance > 0 ? -1 : 1, steps);
        current.lastX += Math.sign(distance) * steps * 48;
      }}
      onPointerUp={finishDrag}
      onPointerCancel={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
      }}
    >
      {peak !== null ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={zh ? `${title}曲线图` : `${title} chart`} onMouseLeave={() => setActivePoint(null)}>
        <line x1={left} y1={top} x2={left} y2={top + innerHeight} className="daily-trend-grid" />
        {[0, .5, 1].map((fraction) => <line key={fraction} x1={left} y1={top + innerHeight * fraction} x2={width - right} y2={top + innerHeight * fraction} className="daily-trend-grid" />)}
        <text className="daily-trend-axis-value" x={left - 10} y={top + 5} textAnchor="end">{zh ? "峰" : "max"} {format(peak)}</text>
        <text className="daily-trend-axis-value" x={left - 10} y={top + innerHeight + 5} textAnchor="end">0</text>
        <path d={segments.join(" ")} className="daily-trend-line" />
        <path d={missingBridges.join(" ")} className="daily-trend-line daily-trend-line--missing" />
        {points.map((point, index) => point.value === null ? null : <g key={point.key}>
          <circle cx={x(index)} cy={y(point.value)} r="12" className="daily-trend-hit" tabIndex={0} aria-label={`${intervalLabel(point, granularity, zh)} · ${format(point.value)}${point.partial ? (zh ? " · 部分记录" : " · Partial") : ""}`} onMouseEnter={() => setActivePoint(index)} onFocus={() => setActivePoint(index)} onBlur={() => setActivePoint(null)} />
          <circle cx={x(index)} cy={y(point.value)} r={point.partial ? 4.5 : 3.5} className={point.partial ? "daily-trend-point daily-trend-point--partial" : "daily-trend-point"} pointerEvents="none" />
        </g>)}
        {points.map((point, index) => <text key={point.key} className="daily-trend-axis-date" x={x(index)} y={height - 8} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{axisLabel(point, granularity, zh)}</text>)}
        {active?.value !== null && active?.value !== undefined && <g className="daily-trend-tooltip" transform={`translate(${tooltipX} ${tooltipY})`} pointerEvents="none">
          <rect width={tooltipWidth} height={tooltipHeight} rx="8" />
          <text x="10" y="16">{intervalLabel(active, granularity, zh)}</text>
          <text className="daily-trend-tooltip-value" x="10" y="34">{format(active.value)}{active.partial ? (zh ? " · 部分记录" : " · Partial") : ""}</text>
        </g>}
      </svg> : <p className="daily-trend-empty">{zh ? "暂无记录" : "No data"}</p>}
    </div>
  </section>;
}
