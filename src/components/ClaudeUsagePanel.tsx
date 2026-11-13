import { useEffect, useMemo, useState } from "react";
import { fetchClaudeUsage, isTauri } from "../lib/bridge";
import { formatTokens, metricValue, type ModelUsage, type UsageMetric, type UsagePeriod } from "../lib/tokeiUsage";
import { aggregateClaudeRows, claudeTaskAsCodexTask, claudeUsageDevice, type ClaudeUsageView } from "../lib/claudeUsageRows";
import { rangeLabel, type UsageDateRange } from "../lib/usageCalendar";
import type { ClaudeUsageReport } from "../types";
import { DailyUsageTrend } from "./DailyUsageTrend";
import { UsageCalendar } from "./UsageCalendar";
import { UsageChart, usageRankColor } from "./UsageChart";
import { CustomTaskStatistics } from "./CustomTaskStatistics";

const PERIODS: readonly UsagePeriod[] = ["today", "7d", "30d", "all"];
const periodLabel = (period: UsagePeriod, zh: boolean) => ({ today: zh ? "今日" : "Today", "7d": zh ? "近 7 天" : "Last 7 days", "30d": zh ? "近 30 天" : "Last 30 days", week: zh ? "本周" : "This week", month: zh ? "本月" : "This month", all: zh ? "全部时间" : "All time" })[period];
const costLabel = (value: number | null, zh: boolean) => value === null ? (zh ? "暂无估算" : "Estimate unavailable") : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const HISTORY_DAYS = 400;

function ClaudeUsageRow({ row, detail, max, color, metric, total, zh }: { row: ModelUsage; detail?: string; max: number; color: string; metric: UsageMetric; total: number; zh: boolean }) {
  const value = metricValue(row, metric);
  return <details className="usage-row">
    <summary>
      <span className="usage-row-name"><i className="usage-color-key" style={{ background: color }} />{row.name}{detail ? <small className="claude-usage-detail">{detail}</small> : null}</span>
      <strong>{metric === "cost" ? costLabel(value, zh) : formatTokens(row.totalTokens, zh)}
        {metric === "cost" && value !== null && total > 0 && <small className="usage-share">{(value / total * 100).toFixed(1)}%</small>}
        {metric === "cost" && value !== null && row.costIncomplete && <small className="usage-share">{zh ? "仅已知金额" : "Known amount only"}</small>}
      </strong>
      <span className="usage-bar" aria-hidden="true"><i style={{ background: color, width: `${max && value !== null ? Math.min(100, value / max * 100) : 0}%` }} /></span>
    </summary>
    <dl className="usage-metric-details">
      <div><dt>{zh ? "输入（含缓存写入）" : "Input (incl. cache writes)"}</dt><dd>{formatTokens(row.inputTokens, zh)}</dd></div>
      <div><dt>{zh ? "缓存读取" : "Cache reads"}</dt><dd>{formatTokens(row.cachedInputTokens, zh)}</dd></div>
      <div><dt>{zh ? "输出" : "Output"}</dt><dd>{formatTokens(row.outputTokens, zh)}</dd></div>
      <div><dt>{zh ? "估算成本" : "Estimated cost"}</dt><dd>{costLabel(row.estimatedCostUsd, zh)}</dd></div>
    </dl>
  </details>;
}

interface ClaudeUsagePanelProps {
  zh: boolean;
  initialReport?: ClaudeUsageReport | null;
  calendarOpen?: boolean;
  onCalendarOpenChange?: (open: boolean) => void;
  calendarPortalTarget?: HTMLElement | null;
}

export function ClaudeUsagePanel({ zh, initialReport = null, calendarOpen, onCalendarOpenChange, calendarPortalTarget }: ClaudeUsagePanelProps) {
  const [report, setReport] = useState<ClaudeUsageReport | null>(initialReport);
  const [error, setError] = useState(false);
  const [period, setPeriod] = useState<UsagePeriod>("today");
  const [dateRange, setDateRange] = useState<UsageDateRange | null>(null);
  const [view, setView] = useState<ClaudeUsageView>("tasks");
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void fetchClaudeUsage(HISTORY_DAYS)
        .then((next) => { if (active) { setReport(next); setError(false); } })
        .catch(() => { if (active) setError(true); });
    };
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const result = useMemo(() => report?.status === "ok" ? aggregateClaudeRows(report, period, view, new Date(), dateRange) : null, [report, period, view, dateRange]);
  const devices = useMemo(() => report?.status === "ok" ? [claudeUsageDevice(report, error)] : [], [report, error]);
  const rows = useMemo(() => [...(result?.rows ?? [])].sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1) || a.name.localeCompare(b.name)), [result, metric]);
  const tasks = useMemo(() => {
    if (report?.status !== "ok") return [];
    const taskData = view === "tasks" && result ? result : aggregateClaudeRows(report, period, "tasks", new Date(), dateRange);
    return taskData.rows.map(row => claudeTaskAsCodexTask(row, taskData.projects[row.id]));
  }, [report, result, view, period, dateRange]);
  const toggleMetric = () => setMetric((current) => current === "tokens" ? "cost" : "tokens");

  if (!report) return <section className="codex-usage-panel"><p className={error ? "usage-error" : "usage-note"} role="status">{error ? (zh ? "暂时无法读取 Claude 用量，请稍后重试。" : "Claude usage is unavailable. Try again shortly.") : (zh ? "正在读取 Claude 用量…" : "Loading Claude usage…")}</p></section>;
  if (!result) return <section className="codex-usage-panel"><p className="usage-note" role="status">{zh ? "未找到 Claude Code 的本机记录。" : "No local Claude Code records found."}</p></section>;

  const summary = result.summary;
  const costTitle = summary.costIncomplete && summary.estimatedCostUsd !== null
    ? (zh ? "已知成本" : "Known cost")
    : (zh ? "估算成本" : "Estimated cost");
  const total = metricValue(summary, metric);
  const knownTotal = rows.reduce((sum, row) => sum + (metricValue(row, metric) ?? 0), 0);
  const visibleRows = showAll ? rows : rows.slice(0, 5);
  const colors = Object.fromEntries(visibleRows.map((row, rank) => [row.id, usageRankColor(rank, visibleRows.length)]));
  const max = metricValue(rows[0] ?? summary, metric) ?? 0;
  const latest = report.latestActivityAt;

  return <section className="codex-usage-panel claude-usage-panel" aria-label={zh ? "Claude 用量" : "Claude usage"}>
    <div className="usage-toolbar">
      <select aria-label={zh ? "用量分组" : "Usage group"} value="local" disabled><option value="local">{zh ? "本机" : "This device"}</option></select>
      <select aria-label={zh ? "统计时间" : "Usage period"} value={dateRange ? "calendar" : period} onChange={(event) => { setDateRange(null); setPeriod(event.target.value as UsagePeriod); setShowAll(false); }}>
        {dateRange && <option value="calendar" disabled>{rangeLabel(dateRange)}</option>}
        {PERIODS.map((value) => <option key={value} value={value}>{periodLabel(value, zh)}</option>)}
      </select>
      <select aria-label={zh ? "查看方式" : "Usage view"} value={view} onChange={(event) => { setView(event.target.value as ClaudeUsageView); setShowAll(false); }}>
        <option value="tasks">{zh ? "按任务" : "By task"}</option>
        <option value="projects">{zh ? "按项目" : "By project"}</option>
        <option value="models">{zh ? "按模型" : "By model"}</option>
      </select>
      <UsageCalendar
        devices={devices}
        palette="claude"
        metric={metric}
        zh={zh}
        selection={dateRange}
        open={calendarOpen}
        onOpenChange={onCalendarOpenChange}
        portalTarget={calendarPortalTarget}
        onMetricChange={setMetric}
        onSelect={(range) => { setDateRange(range); setShowAll(false); }}
      />
    </div>
    <CustomTaskStatistics rows={tasks} zh={zh} error={error} provider="claude" periodLabel={dateRange ? rangeLabel(dateRange) : periodLabel(period, zh)} />
    <div className="usage-total"><small>{metric === "tokens" ? `${costTitle} ${costLabel(summary.estimatedCostUsd, zh)}` : `${formatTokens(summary.totalTokens, zh)} Tokens`}</small><button type="button" className="usage-text-button" onClick={toggleMetric}>{metric === "tokens" ? (zh ? "看成本" : "Costs") : (zh ? "看 Token" : "Tokens")}</button></div>
    <div className="usage-model-today usage-task-today">
      {rows.length > 0 && <UsageChart rows={rows} total={total} knownTotal={knownTotal} period={period} devices={devices} ids={[]} zh={zh} metric={metric} onToggle={toggleMetric} tasks={view !== "models"} summaryOnly colors={colors} />}
      <div className="usage-ranking">
        {visibleRows.map((row) => <ClaudeUsageRow key={row.id} row={row} detail={result.details[row.id]} max={max} color={colors[row.id]} metric={metric} total={knownTotal} zh={zh} />)}
        {!rows.length && <p className="usage-empty">{zh ? "这段时间暂无 Claude 用量。" : "No Claude usage in this period."}</p>}
        {rows.length > 5 && <button type="button" className="usage-text-button" onClick={() => setShowAll((value) => !value)}>{showAll ? (zh ? "收起" : "Show less") : (zh ? `其余 ${rows.length - 5} 项` : `${rows.length - 5} more`)}</button>}
      </div>
    </div>
    {report.days.length > 0 && <DailyUsageTrend devices={devices} metric={metric} zh={zh} anchorDate={dateRange?.end} />}
    <footer className="usage-footer"><span>{!isTauri() ? (zh ? "示例数据" : "Sample data") : latest ? `${zh ? "最近活动" : "Last activity"} ${new Date(latest).toLocaleString(zh ? "zh-CN" : "en-US", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : (zh ? "尚无用量记录" : "No usage records yet")}{` · ${zh ? "API 价核对" : "Prices checked"} ${report.priceCheckedAt}`}</span></footer>
  </section>;
}
