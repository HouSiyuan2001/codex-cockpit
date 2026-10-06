import { useEffect, useMemo, useRef, useState } from "react";
import { GearSix } from "@phosphor-icons/react";
import { isTauri } from "../lib/bridge";
import { getProjectUsage, getTokeiUsage } from "../lib/tokeiBridge";
import { aggregateGroupUsage, aggregateGlobalUsage, aggregateProjectUsage, aggregateTaskUsage, aggregateSyncedTaskUsage, formatTokens, metricValue, reconcileTaskUsage, type AggregatedTaskUsage, type UsageMetrics, type UsageMetric, type ProjectUsageSnapshot, type ModelUsage, type TokeiUsage, type UsagePeriod } from "../lib/tokeiUsage";
import { UsageChart, usageColor, usageRankColor } from "./UsageChart";
import { modelUsageColors, UNRANKED_MODEL_COLOR } from "../lib/modelUsageColors";
import { TaskUsageRow } from "./TaskUsageRow";
import { UsageCalendar } from "./UsageCalendar";
import { CustomTaskStatistics } from "./CustomTaskStatistics";
import { DailyUsageTrend } from "./DailyUsageTrend";
import { newestDevices, rangeLabel, tasksInRange, usageInRange, type UsageDateRange } from "../lib/usageCalendar";

const PERIODS: readonly UsagePeriod[] = ["today", "7d", "30d", "all"];
const periodLabel = (period: UsagePeriod, zh: boolean) => ({ today: zh ? "今日" : "Today", "7d": zh ? "近 7 天" : "Last 7 days", "30d": zh ? "近 30 天" : "Last 30 days", week: zh ? "本周" : "This week", month: zh ? "本月" : "This month", all: zh ? "全部时间" : "All time" })[period];
const costLabel = (value: number | null, zh: boolean) => value === null ? (zh ? "暂无估算" : "Estimate unavailable") : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function ModelRow({ model, max, zh, color, metric, total }: { model: ModelUsage; max: number; zh: boolean; color: string; metric: UsageMetric; total: number }) {
  const value = metricValue(model, metric);
  return <details className="usage-row">
    <summary>
      <span className="usage-row-name"><i className="usage-color-key" style={{ background: color }} />{model.name}</span>
      <strong>{metric === "cost" ? costLabel(value, zh) : formatTokens(model.totalTokens, zh)}
        {metric === "cost" && value !== null && total > 0 && <small className="usage-share">{(value / total * 100).toFixed(1)}%</small>}
        {metric === "cost" && model.costIncomplete && value !== null && <small className="usage-share">{zh ? "仅已知金额" : "Known amount only"}</small>}
      </strong>
      <span className="usage-bar" aria-hidden="true"><i style={{ background: color, width: `${max && value !== null ? Math.min(100, value / max * 100) : 0}%` }} /></span>
    </summary>
    <dl className="usage-metric-details">
      <div><dt>{zh ? "输入（非缓存）" : "Input (uncached)"}</dt><dd>{formatTokens(model.inputTokens, zh)}</dd></div>
      <div><dt>{zh ? "缓存输入" : "Cached input"}</dt><dd>{formatTokens(model.cachedInputTokens, zh)}</dd></div>
      <div><dt>{zh ? "输出" : "Output"}</dt><dd>{formatTokens(model.outputTokens, zh)}</dd></div>
      <div><dt>{zh ? "估算成本" : "Estimated cost"}</dt><dd>{costLabel(model.estimatedCostUsd, zh)}</dd></div>
    </dl>
  </details>;
}

export function CodexUsagePanel({ zh, onOpenSettings = () => undefined, calendarOpen, onCalendarOpenChange, calendarPortalTarget }: { zh: boolean; onOpenSettings?: () => void; calendarOpen?: boolean; onCalendarOpenChange?: (open: boolean) => void; calendarPortalTarget?: HTMLElement | null }) {
  const [data, setData] = useState<TokeiUsage | null>(null);
  const [error, setError] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [global, setGlobal] = useState(false);
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [period, setPeriod] = useState<UsagePeriod>("today");
  const [dateRange, setDateRange] = useState<UsageDateRange | null>(null);
  const [view, setView] = useState<"tasks" | "models" | "projects" | "users">("tasks");
  const [projects, setProjects] = useState<ProjectUsageSnapshot | null>(null);
  const [projectError, setProjectError] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const mounted = useRef(false);
  const scopeInitialized = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let busy = false;
    async function refresh() {
      if (busy || !active) return;
      busy = true;
      try {
        const next = await getTokeiUsage();
        if (active) {
          setData(next); setError(false);
          if (!scopeInitialized.current) {
            setGroupId(next.localGroupId ?? null);
            setGlobal(!next.localGroupId);
            scopeInitialized.current = true;
          } else {
            setGroupId((current) => next.groups.some((group) => group.id === current) ? current : next.localGroupId ?? null);
          }
        }
      } catch { if (active) setError(true); } finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 30000);
    return () => { active = false; mounted.current = false; window.clearInterval(timer); };
  }, []);

  const scopedData = useMemo(() => data && dateRange ? usageInRange(data, dateRange) : data, [data, dateRange]);
  const scopedProjects = useMemo(() => projects && dateRange ? tasksInRange(projects, dateRange) : projects, [projects, dateRange]);
  const selectedPeriod = dateRange ? "all" : period;
  const all = useMemo(() => scopedData ? aggregateGlobalUsage(scopedData, selectedPeriod) : null, [scopedData, selectedPeriod]);
  const summary = useMemo(() => global ? all : scopedData ? aggregateGroupUsage(scopedData, groupId, selectedPeriod) : null, [scopedData, groupId, selectedPeriod, global, all]);
  const fullDevices = useMemo(() => {
    if (!data) return [];
    const ids = new Set(global ? [...data.devices.map(device => device.id), ...data.groups.flatMap(group => group.deviceIds)] : data.groups.find(group => group.id === groupId)?.deviceIds ?? []);
    const available = new Map(newestDevices(data.devices).map(device => [device.id, device]));
    // A configured peer with no snapshot is unknown, not silently absent from historical coverage.
    return [...ids].map(id => available.get(id) ?? { id, updatedAt: null, stale: true, collectionPartial: true, daily: {}, ranges: {} });
  }, [data, global, groupId]);
  useEffect(() => {
    let active = true;
    let busy = false;
    let timer: number | undefined;
    async function refresh() {
      if (busy || !active) return;
      busy = true;
      let delay = 60000;
      try {
        const next = await getProjectUsage();
        if (active) { setProjects(next); setProjectError(false); }
        if (next.warnings.includes("scan_limit")) delay = 1500;
      }
      catch { if (active) setProjectError(true); }
      finally { busy = false; if (active) timer = window.setTimeout(() => { void refresh(); }, delay); }
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [view, period]);
  const localScope = useMemo(() => global
    ? { groups: [{ id: "global", name: "global", deviceIds: summary?.devices.map(device => device.id) ?? [] }], defaultGroupId: "global" }
    : data, [data, global, summary]);
  const localScopeId = global ? "global" : groupId;
  const projectRows = useMemo(() => scopedProjects && localScope ? aggregateProjectUsage(scopedProjects, localScope, localScopeId, selectedPeriod) : [], [scopedProjects, localScope, localScopeId, selectedPeriod]);
  const taskUsage = useMemo(() => scopedProjects && localScope ? aggregateSyncedTaskUsage(scopedProjects, localScope, localScopeId, selectedPeriod) : null, [scopedProjects, localScope, localScopeId, selectedPeriod]);
  const localTaskUsage = useMemo(() => scopedProjects && localScope ? aggregateTaskUsage(scopedProjects, localScope, localScopeId, selectedPeriod) : null, [scopedProjects, localScope, localScopeId, selectedPeriod]);
  const localSummary = useMemo(() => {
    if (!projects?.deviceId || !scopedData || !taskUsage?.localIncluded) return null;
    return aggregateGroupUsage({ ...scopedData, groups: [{ id: "__local_task_device", name: "local", deviceIds: [projects.deviceId] }] }, "__local_task_device", selectedPeriod);
  }, [projects, scopedData, taskUsage, selectedPeriod]);
  const taskReconciliation = useMemo(() => summary && localSummary && localTaskUsage ? reconcileTaskUsage(summary, localSummary, localTaskUsage.attributed) : null, [summary, localSummary, localTaskUsage]);
  // Presentation only: partial known amounts participate in ranking and the donut.
  // Keep the original task ledger above unchanged for strict reconciliation.
  const displayTasks = taskUsage?.rows.map(task => ({ ...task, estimatedCostUsd: task.estimatedCostUsd ?? task.knownCostUsd ?? null })) ?? [];
  const rows = [...(view === "projects" ? projectRows : view === "users" ? all?.users ?? [] : view === "models" ? summary?.models ?? [] : displayTasks)].sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1) || a.name.localeCompare(b.name));
  const colorIds = useMemo(() => view === "users" ? (all?.users.map(user => user.id) ?? []).sort() : view === "projects" ? [...(projects?.projects.map(project => project.id) ?? [])].sort() : view === "tasks" ? [...(projects?.tasks?.map(task => task.id) ?? [])].sort() : [...new Set(data?.devices.flatMap(device => Object.values(device.daily).flatMap(day => day.models.map(model => model.id))) ?? [])].sort(), [data, projects, view, all]);
  const knownTotal = rows.reduce((sum, row) => sum + (metricValue(row, metric) ?? 0), 0);
  const taskCostIncomplete = rows.some(row => row.estimatedCostUsd === null || row.costIncomplete);
  const taskTotal = !projects || metric === "cost" && taskCostIncomplete ? null : knownTotal;
  const chartTotal = summary ? metricValue(summary, metric) : null;
  const denominator = Math.max(chartTotal ?? 0, metric === "cost" ? summary?.knownCostUsd ?? 0 : 0, knownTotal);
  const unknownCost = metric === "cost" && (chartTotal === null || rows.some(row => row.estimatedCostUsd === null));
  const totalCostUnavailable = metric === "cost" && Boolean(summary?.hasData) && chartTotal === null;
  const summaryOnly = Boolean(dateRange || summary?.rangeDeviceIds.length);
  const donut = view === "tasks" || (view === "models" || view === "users") && (period === "today" || view === "users" || summaryOnly);
  const toggleMetric = () => setMetric(current => current === "tokens" ? "cost" : "tokens");
  const visibleRows = showAll ? rows : rows.slice(0, 5);
  const taskColors = Object.fromEntries(visibleRows.map((row, rank) => [row.id, usageRankColor(rank, visibleRows.length)]));
  const modelColors = view === "models" ? modelUsageColors(visibleRows) : undefined;
  const group = data?.groups.find((item) => item.id === groupId);
  const stale = summary?.devices.some((device) => device.stale) ?? false;
  const partial = Boolean(summary?.missingDeviceIds.length || summary?.unavailablePeriodDeviceIds.length || summary?.incompleteModels || summary?.devices.some(device => device.collectionPartial) || data?.status === "partial");
  const latest = summary?.devices.map((device) => device.updatedAt).filter((date): date is string => Boolean(date)).sort().at(-1);
  const scopeValue = (value: UsageMetrics | null) => metric === "cost" ? costLabel(value?.estimatedCostUsd ?? null, zh) : formatTokens(value?.totalTokens ?? 0, zh);

  if (!data) return <section className="codex-usage-panel"><p className={error ? "usage-error" : "usage-note"} role="status">{error ? (zh ? "暂时无法读取用量，请稍后重试。" : "Usage is unavailable. Try again shortly.") : (zh ? "正在读取用量…" : "Loading usage…")}</p></section>;

  return <section className="codex-usage-panel" aria-label={zh ? "Codex 用量" : "Codex usage"}>
    <div className="usage-toolbar">
      <select aria-label={zh ? "用量分组" : "Usage group"} value={global ? "global" : groupId === null ? "" : `group:${groupId}`} onChange={(event) => { const isGlobal = event.target.value === "global"; setGlobal(isGlobal); if (isGlobal) { setView("users"); setMetric("cost"); } else { setGroupId(event.target.value.slice(6) || null); if (view === "users") setView("models"); } setShowAll(false); }}>
        <option value="" disabled>{zh ? "选择分组" : "Choose group"}</option>
        <option value="global">{zh ? "全局" : "Global"}</option>
        {data.groups.map((item) => <option key={item.id} value={`group:${item.id}`}>{item.name}</option>)}
      </select>
      <select aria-label={zh ? "统计时间" : "Usage period"} value={dateRange ? "calendar" : period} onChange={(event) => { setDateRange(null); setPeriod(event.target.value as UsagePeriod); setShowAll(false); }}>
        {dateRange && <option value="calendar" disabled>{rangeLabel(dateRange)}</option>}
        {PERIODS.map((value) => <option key={value} value={value}>{periodLabel(value, zh)}</option>)}
      </select>
      <select aria-label={zh ? "查看方式" : "Usage view"} value={view} onChange={(event) => { setView(event.target.value as typeof view); setShowAll(false); }}>
        {global && <option value="users">{zh ? "按用户" : "By user"}</option>}
        <option value="tasks">{zh ? "按任务" : "By task"}</option><option value="models">{zh ? "按模型" : "By model"}</option>
      </select>
      <UsageCalendar devices={fullDevices} metric={metric} zh={zh} selection={dateRange} open={calendarOpen} onOpenChange={onCalendarOpenChange} portalTarget={calendarPortalTarget} onMetricChange={setMetric} onSelect={range => { setDateRange(range); setShowAll(false); }} />
      <button type="button" className="usage-settings-button" aria-label={zh ? "打开组员设置" : "Open member settings"} title={zh ? "打开组员设置" : "Open member settings"} onClick={onOpenSettings}><GearSix /></button>
    </div>

    <CustomTaskStatistics key={[global ? "global" : groupId, period, dateRange?.start, dateRange?.end, view, metric].join("|")} rows={taskUsage?.rows ?? []} zh={zh} loading={!projects && !projectError} error={projectError} partial={projects?.status === "partial" || projects?.peerTasks?.some(peer => peer.partial)} periodLabel={dateRange ? rangeLabel(dateRange) : periodLabel(period, zh)} />

    {!group && !global ? <p className="usage-empty">{zh ? "选择一名组员，或到设置中分配设备。" : "Choose a member, or assign devices in settings."}</p> : <>
        <div className="usage-total">{!donut && <><span>{metric === "tokens" ? (zh ? "Token 用量" : "Token usage") : (zh ? "估算成本" : "Estimated cost")}</span><strong aria-label={totalCostUnavailable ? costLabel(null, zh) : undefined}>{summary?.hasData ? totalCostUnavailable ? "—" : metric === "cost" ? costLabel(chartTotal, zh) : formatTokens(summary.totalTokens, zh) : "—"}</strong></>}<small>{metric === "tokens" ? `${zh ? "估算成本" : "Estimated cost"} ${costLabel(summary?.estimatedCostUsd ?? null, zh)}` : `${totalCostUnavailable ? `${costLabel(null, zh)} · ` : ""}${formatTokens(summary?.totalTokens ?? 0, zh)} Tokens`}</small><button type="button" className="usage-text-button" onClick={toggleMetric}>{metric === "tokens" ? (zh ? "看成本" : "Costs") : (zh ? "看 Token" : "Tokens")}</button>{view === "tasks" && <small className="usage-inline-status">{[projects?.warnings.includes("scan_limit") ? (zh ? "补扫中" : "Scanning") : null, metric === "cost" && taskCostIncomplete ? (zh ? "成本不全" : "Partial cost") : null, taskReconciliation?.mismatch ? (zh ? "待对账" : "Ledger mismatch") : null].filter(Boolean).join(" · ")}</small>}</div>
        <div className={donut ? "usage-model-today" : undefined}>
        {view === "tasks" && <UsageChart rows={rows} total={taskTotal} knownTotal={knownTotal} period={period} devices={[]} ids={[]} zh={zh} metric={metric} onToggle={toggleMetric} tasks colors={taskColors} />}
        {(view === "models" || view === "users") && summary && <UsageChart rows={rows} total={chartTotal} knownTotal={metric === "cost" ? summary.knownCostUsd : undefined} period={period} devices={summary.devices} ids={colorIds} zh={zh} metric={metric} onToggle={toggleMetric} users={view === "users"} summaryOnly={summaryOnly} colors={modelColors} />}
        <div className="usage-ranking">
          {view === "tasks" ? (visibleRows as AggregatedTaskUsage[]).map((task) => <TaskUsageRow key={task.id} task={task} max={metricValue(rows[0], metric) ?? 0} color={taskColors[task.id]} zh={zh} metric={metric} total={knownTotal} />) : visibleRows.map((model) => <ModelRow key={model.id} model={model as ModelUsage} max={metricValue(rows[0], metric) ?? 0} color={modelColors ? modelColors[model.id] ?? UNRANKED_MODEL_COLOR : usageColor(model.id, colorIds)} zh={zh} metric={metric} total={view === "projects" ? knownTotal : denominator} />)}
          {!rows.length && <p className="usage-empty">{view === "tasks" ? projectError ? (zh ? "任务统计暂不可用。" : "Task statistics unavailable.") : !projects ? (zh ? "正在读取任务统计…" : "Loading task statistics…") : (zh ? "这段时间暂无可归属的任务记录。" : "No attributed task records in this period.") : view === "projects" ? projectError ? (zh ? "项目统计暂不可用。" : "Project statistics unavailable.") : !projects ? (zh ? "正在读取本机项目统计…" : "Loading local project statistics…") : !projects.deviceId || !(global ? summary?.devices.some(device => device.id === projects.deviceId) : group?.deviceIds.includes(projects.deviceId)) ? (zh ? "此分组未包含本机，暂无项目明细。" : "This group does not include this device.") : (zh ? "这段时间暂无可归属的项目记录。" : "No attributed project records in this period.") : (zh ? "这段时间暂无模型用量记录。" : "No model usage recorded in this period.")}</p>}
          {projectError && rows.length > 0 && (view === "tasks" || view === "projects") && <p className="usage-note">{zh ? "本机明细刷新失败，暂显示上次统计。" : "Local details refresh failed; showing previous results."}</p>}
          {rows.length > 5 && <button type="button" className="usage-text-button" onClick={() => setShowAll((value) => !value)}>{showAll ? (zh ? "收起" : "Show less") : (zh ? `其余 ${rows.length - 5} 项` : `${rows.length - 5} more`)}</button>}
        </div>
        </div>
    </>}
    <DailyUsageTrend devices={fullDevices} metric={metric} zh={zh} anchorDate={dateRange?.end} resetKey={global ? "global" : groupId} />
    {(error || stale || partial) && <p className="usage-note" role="status">{error ? (zh ? "刷新失败 · 上次快照" : "Refresh failed · Last snapshot") : stale ? (zh ? "含离线快照" : "Includes offline snapshots") : (zh ? "部分数据缺失" : "Partial data")}</p>}
    <footer className="usage-footer"><span>{!isTauri() ? (zh ? "示例数据" : "Sample data") : latest ? `${zh ? "最近同步" : "Last synced"} ${new Date(latest).toLocaleTimeString(zh ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}` : !summary ? (zh ? "尚未选择分组" : "No group selected") : (zh ? "尚无同步记录" : "Not synced yet")}</span>
        <details className="usage-explanation"><summary>{zh ? "统计说明" : "Usage details"}</summary><div>
        {unknownCost && <p className="usage-note">{zh ? "成本不完整 · 占比仅计已知金额" : "Incomplete costs · Shares use known amounts only"}</p>}
        {Boolean(summary?.unavailablePeriodDeviceIds.length) && <p className="usage-note">{zh ? `部分设备没有${periodLabel(period, true)}数据。` : `Some devices lack ${periodLabel(period, false).toLowerCase()} data.`}</p>}
        {view === "tasks" && metric === "cost" && taskCostIncomplete && !unknownCost && <p className="usage-note">{zh ? "任务成本不完整 · 占比仅计已知金额" : "Incomplete task costs · Shares use known amounts only"}</p>}
        {view === "projects" && <p className="usage-note">{zh ? "分组全部设备总量 ↑ · 本机项目 ↓" : "All grouped devices total ↑ · Local projects ↓"}{projects?.status === "partial" ? (zh ? " · Token 补扫中" : " · Token scan partial") : ""}</p>}
        {view === "tasks" && <p className="usage-note">
          {zh ? `${dateRange ? rangeLabel(dateRange) : periodLabel(period, true)} · 跨设备任务 ${rows.length} 项` : `${dateRange ? rangeLabel(dateRange) : periodLabel(period, false)} · ${rows.length} synced tasks`}
          {projects?.warnings.includes("scan_limit") ? (zh ? " · 正在补全历史…" : " · Loading history…") : projects?.status === "partial" ? (zh ? " · 部分记录" : " · Partial") : ""}
        </p>}
        {view === "tasks" && taskReconciliation && (taskReconciliation.mismatch
          ? <p className="usage-note" role="status">{taskReconciliation.mismatch === "tasks-exceed-local"
            ? (zh ? "可归属任务账超过本机设备账，可能来自扫描时点或来源差异；不显示负数差额。" : "Attributed tasks exceed the local device ledger, possibly due to scan timing or source differences; no negative remainder is shown.")
            : (zh ? "本机设备账超过当前分组总账，可能来自同步覆盖或时点差异；不显示负数差额。" : "The local device ledger exceeds the current group total, possibly due to sync coverage or timing; no negative remainder is shown.")}</p>
          : <p className="usage-note">{zh
            ? `本机未归属 ${scopeValue(taskReconciliation.outstandingLocal)} · 其他设备 ${scopeValue(taskReconciliation.nonLocal)}`
            : `Unattributed local ${scopeValue(taskReconciliation.outstandingLocal)} · Other devices ${scopeValue(taskReconciliation.nonLocal)}`}</p>)}
          <p>{global ? (zh ? "全局按现有用户分组汇总，每台设备只计一次；未分组设备单列。" : "Global combines configured user groups, counting each device once; unassigned devices are separate.") : (zh ? "仅计所选分组的 Codex 用量。" : "Only Codex usage from this group.")}{zh ? "Token 包含输入、缓存输入和输出，推理不重复累加。" : "Tokens include uncached input, cache and output; reasoning is not added twice."}</p>
          <p>{zh ? "成本来自本地价格表或兼容的历史快照估算，不是订阅实际扣费，也不是官方剩余额度。" : "Costs use a local price catalog or compatible historical estimates, not subscription charges or remaining quota."}</p>
          <p>{zh ? "日账与时段汇总不重复累加。仅在时间边界匹配时使用汇总；本周不等于近7天。离线设备保留截至快照时的统计。" : "Daily ledgers and range totals are never added twice. Ranges require matching date bounds; this week is not rolling seven days. Offline totals stop at their snapshot time."}</p>
          {view === "models" && <p>{zh ? "颜色按GPT数字代际从新到旧等间隔取红到蓝；同代按名称固定排序。隐藏或代际不明的模型为灰色；展开更多时重新均分色带。仅有名称的旧快照按原名称汇总，不猜测具体变体。" : "Visible GPT generations are spaced evenly from new/red to old/blue, with name-based ties. Hidden or unversioned models are gray; expanding resamples the palette. Name-only legacy rows stay name-grouped without guessing variants."}</p>}
          {view === "tasks" && <p>{zh ? "任务标题、每日用量及子 Agent 归属通过 Cloudflare 同步；不上传消息正文或项目路径。任务按设备与任务 ID 区分，只在同一设备内合并已证实的子 Agent。其他设备需升级并上传后才有任务明细；离线时保留上次快照。" : "Task titles, daily usage and subagent relationships sync via Cloudflare, without messages or project paths. Identity combines device and task IDs; subagents fold only within one device. Peers need to upgrade and upload task details; offline snapshots remain available."}</p>}
          {view === "tasks" && projects?.peerTasks?.some(peer => peer.partial) && <p>{zh ? "部分设备任务快照不完整，当前只计已接收明细。" : "Some peer task snapshots are partial; only received details are counted."}</p>}
          {view === "projects" && <p>{zh ? "项目按本机工作目录归属，Git worktree 合并至主仓库。成本使用本地价格表；价格或上下文无法确认时不估算。" : "Projects follow local working directories; Git worktrees share their main repository. Costs use a local catalog and remain unavailable when rates or context are unknown."}</p>}
          {(view === "tasks" || view === "projects") && projects && <p>{zh ? `已扫描 ${projects.scannedFiles} 份本机记录；缺失、超长或计数重置的记录可能无法完整归属。` : `${projects.scannedFiles} local files scanned; missing, oversized or reset-counter records may not be fully attributed.`}{projects.pricingUpdatedAt ? ` ${zh ? "价格表时间" : "Catalog date"}: ${projects.pricingUpdatedAt}` : ""}</p>}
          {summary?.missingDeviceIds.length ? <p>{zh ? `有 ${summary.missingDeviceIds.length} 台设备尚无可读快照。` : `${summary.missingDeviceIds.length} devices have no readable snapshot.`}</p> : null}
          {summary?.incompleteModels && <p>{zh ? "部分 Token 未能归属到模型，排行可能小于总量。" : "Some tokens have no model attribution; ranked totals may be smaller."}</p>}
          <ul>{summary?.devices.map((device) => <li key={device.id}>{device.id} · {device.updatedAt ? new Date(device.updatedAt).toLocaleString(zh ? "zh-CN" : "en-US") : (zh ? "时间未知" : "Unknown time")}</li>)}</ul>
        </div></details>
    </footer>
  </section>;
}
