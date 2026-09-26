import { formatCost, formatTokens, metricValue, type AggregatedTaskUsage, type TaskUsageDetail, type UsageMetric } from "../lib/tokeiUsage";
import "./taskUsage.css";

function Cost({ detail, zh }: { detail: { estimatedCostUsd: number | null; knownCostUsd?: number | null; totalTokens: number }; zh: boolean }) {
  const cost = detail.estimatedCostUsd ?? detail.knownCostUsd ?? null;
  return <>{cost === null ? formatTokens(detail.totalTokens, zh) : formatCost(cost, zh)}
    {detail.estimatedCostUsd === null && <small className="usage-share">{cost === null ? (zh ? "已记录用量 · 计价资料不足" : "Usage recorded · pricing data incomplete") : (zh ? "仅已知金额" : "Known amount only")}</small>}
  </>;
}

function Detail({ detail, metric, zh, self }: { detail: TaskUsageDetail; metric: UsageMetric; zh: boolean; self: boolean }) {
  const identity = [detail.agentNickname, detail.agentRole].filter(Boolean).join(" · ");
  return <li className="task-usage-detail">
    <div>
      <span>{self ? (zh ? "当前任务" : "Task itself") : detail.name}</span>
      {identity && <small>{identity}</small>}
    </div>
    <strong>{metric === "cost" ? <Cost detail={detail} zh={zh} /> : formatTokens(detail.totalTokens, zh)}</strong>
    {detail.models.length > 0 && <small className="task-usage-models">{detail.models.map((model) => `${model.name} ${formatTokens(model.totalTokens, zh)}`).join(" · ")}</small>}
  </li>;
}

export function TaskUsageRow({ task, max, color, zh, metric, total }: { task: AggregatedTaskUsage; max: number; color: string; zh: boolean; metric: UsageMetric; total: number }) {
  const value = metricValue(task, metric);
  const childValue = task.children.reduce<number | null>((sum, child) => {
    const next = metricValue(child, metric);
    return sum === null || next === null ? null : sum + next;
  }, 0);
  const childCost = {
    estimatedCostUsd: metric === "cost" ? childValue : null,
    knownCostUsd: task.children.reduce<number | null>((sum, child) => {
      const cost = child.estimatedCostUsd ?? child.knownCostUsd;
      return cost == null ? sum : (sum ?? 0) + cost;
    }, null),
    totalTokens: task.children.reduce((sum, child) => sum + child.totalTokens, 0),
  };
  const shortId = task.self.id.length <= 8 ? task.self.id : task.self.id.slice(-8);
  return <details className="usage-row task-usage-row">
    <summary>
      <span className="task-usage-heading">
        <span className="usage-row-name"><i className="usage-color-key" style={{ background: color }} />{task.rawName}</span>
        <small>{task.projectName ? `${task.projectName} · ` : ""}{shortId}{task.children.length ? ` · ${zh ? `含 ${task.children.length} 个子 Agent` : `${task.children.length} subagent${task.children.length === 1 ? "" : "s"}`}` : ""}</small>
        {task.sourceDevice && <small>{zh ? "来自 " : "From "}{task.sourceDevice}</small>}
      </span>
      <strong>{metric === "cost" ? <Cost detail={task} zh={zh} /> : formatTokens(task.totalTokens, zh)}
        {metric === "cost" && value !== null && total > 0 && <small className="usage-share">{(value / total * 100).toFixed(1)}%</small>}
        {metric === "cost" && task.costIncomplete && value !== null && <small className="usage-share">{zh ? "仅已知金额" : "Known amount only"}</small>}
      </strong>
      <span className="usage-bar" aria-hidden="true"><i style={{ background: color, width: `${max && value !== null ? Math.min(100, value / max * 100) : 0}%` }} /></span>
    </summary>
    <ul className="task-usage-details">
      <Detail detail={task.self} metric={metric} zh={zh} self />
      {task.children.length > 0 && <li className="task-usage-subtotal"><span>{zh ? "子 Agent 合计" : "Subagent subtotal"}</span><strong>{metric === "cost" ? <Cost detail={childCost} zh={zh} /> : formatTokens(childValue ?? 0, zh)}</strong></li>}
      {task.children.map((child) => <Detail key={child.id} detail={child} metric={metric} zh={zh} self={false} />)}
    </ul>
  </details>;
}
