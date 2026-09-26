import { formatTokens, formatCost, metricValue, localDateKey, periodStart, type UsageMetric, type ModelUsage, type TokeiDevice, type UsagePeriod } from "../lib/tokeiUsage";
import { UNRANKED_MODEL_COLOR } from "../lib/modelUsageColors";
import { canonicalModelId } from "../lib/tokeiUsage";

// Shared by chart marks and text labels; sampled from the research warm-to-cool palette.
const COLORS = ["#e76254", "#ef8a47", "#f7aa58", "#ffd06f", "#ffe6b7", "#aadce0", "#72bcd5", "#528fad", "#376795", "#1e466e"];
export function usageRankColor(rank: number, count: number) {
  const position = Math.min(1, Math.max(0, rank) / Math.max(1, count - 1)) * (COLORS.length - 1);
  const left = Math.floor(position);
  const right = Math.min(COLORS.length - 1, left + 1);
  const fraction = position - left;
  const channel = (offset: number) => {
    const a = parseInt(COLORS[left].slice(offset, offset + 2), 16);
    const b = parseInt(COLORS[right].slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * fraction).toString(16).padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}
export function usageColor(id: string, ids: string[]) {
  const index = Math.max(0, ids.indexOf(id));
  return COLORS[ids.length <= COLORS.length ? Math.round(index * (COLORS.length - 1) / Math.max(1, ids.length - 1)) : index % COLORS.length];
}

export function UsageChart({ rows, total, knownTotal, period, devices, ids, zh, metric = "tokens", onToggle, users = false, tasks = false, summaryOnly = false, colors }: { rows: ModelUsage[]; total: number | null; knownTotal?: number | null; period: UsagePeriod; devices: TokeiDevice[]; ids: string[]; zh: boolean; metric?: UsageMetric; onToggle?: () => void; users?: boolean; tasks?: boolean; summaryOnly?: boolean; colors?: Record<string, string> }) {
  const format = (value: number) => metric === "cost" ? formatCost(value, zh) : formatTokens(value, zh);
  const color = (id: string) => colors ? colors[id] ?? UNRANKED_MODEL_COLOR : usageColor(id, ids);
  if (total !== null && total <= 0 && !onToggle) return null;
  if (period === "today" || users || tasks || summaryOnly) {
    let offset = 0;
    const known = Math.max(knownTotal ?? 0, rows.reduce((sum, row) => sum + (metricValue(row, metric) ?? 0), 0));
    const denominator = Math.max(total ?? 0, known);
    const label = metric === "cost" ? (total === null ? (zh ? "已知成本" : "Known cost") : (zh ? "估算成本" : "Est. cost")) : "Tokens";
    const content = <><svg viewBox="0 0 160 160" role="img" aria-label={tasks ? (zh ? "任务用量占比" : "Task usage share") : users ? (zh ? "用户成本与用量占比" : "User usage share") : (zh ? "模型用量占比" : "Model usage share")}>
      <circle cx="80" cy="80" r="65" fill="none" stroke="var(--glass-edge)" strokeWidth="15" />
      {rows.map(row => { const value = metricValue(row, metric); if (value === null || value <= 0 || !denominator) return null; const share = value / denominator * 100; const start = offset; offset += share; return <circle key={row.id} cx="80" cy="80" r="65" fill="none" stroke={color(row.id)} strokeWidth="15" pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 80 80)"><title>{row.name}: {format(value)}</title></circle>; })}
    </svg><div><strong>{total === null && !known ? "—" : format(total ?? known)}</strong><small>{tasks ? `${zh ? "任务用量" : "Task usage"} · ${label}` : label}</small></div></>;
    return onToggle ? <button type="button" className="usage-donut usage-donut-toggle" onClick={onToggle} aria-label={metric === "tokens" ? (zh ? "切换为成本" : "Show costs") : (zh ? "切换为Token" : "Show tokens")} title={zh ? "点击切换 Token / 成本" : "Click to switch tokens / costs"}>{content}</button> : <div className="usage-donut">{content}</div>;
  }
  const now = new Date();
  const end = localDateKey(now);
  const start = periodStart(period, now);
  const days = new Map<string, { total: number; models: Map<string, number> }>();
  for (const device of devices) for (const [date, day] of Object.entries(device.daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) continue;
    const key = period === "all" ? date.slice(0, 7) : date;
    const bin = days.get(key) ?? { total: 0, models: new Map<string, number>() };
    const value = metricValue(day, metric);
    bin.total = value === null || bin.total < 0 ? -1 : bin.total + value;
    for (const model of day.models) {
      const id = canonicalModelId(model.id);
      bin.models.set(id, (bin.models.get(id) ?? 0) + (metricValue(model, metric) ?? 0));
    }
    days.set(key, bin);
  }
  if (period !== "all") {
    const cursor = new Date(`${start}T12:00:00`);
    while (localDateKey(cursor) <= end) { const key = localDateKey(cursor); if (!days.has(key)) days.set(key, { total: -1, models: new Map() }); cursor.setDate(cursor.getDate() + 1); }
  }
  const bins = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(1, ...bins.map(([, day]) => day.total));
  return <div className="usage-trend" role="img" aria-label={zh ? "用量趋势" : "Usage trend"}><div className="usage-trend-caption"><span>{zh ? (period === "all" ? "每月" : "每日") : (period === "all" ? "Monthly " : "Daily ")}{metric === "cost" ? (zh ? "成本" : "cost") : (zh ? "用量" : "usage")}</span><span>{format(max)}</span></div><div className="usage-columns">
    {bins.map(([date, day], index) => <div className="usage-column" key={date} title={`${date} · ${day.total < 0 ? (zh ? "暂无数据" : "No data") : format(day.total)}`}><div className="usage-column-track">{day.total < 0 ? <span className="usage-chart-gap">·</span> : <div className="usage-column-stack" style={{ height: `${day.total / max * 100}%` }}>{[...day.models].map(([id, count]) => <i key={id} style={{ background: color(id), flex: count }} />)}{day.total > [...day.models.values()].reduce((a, b) => a + b, 0) && <i style={{ background: "var(--glass-edge)", flex: day.total - [...day.models.values()].reduce((a, b) => a + b, 0) }} />}</div>}</div><small>{index === 0 || index === bins.length - 1 || bins.length <= 7 ? date.slice(5) : ""}</small></div>)}
  </div></div>;
}
