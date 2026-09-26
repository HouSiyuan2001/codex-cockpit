import type { DailyPersonCosts } from "../lib/dailyPersonCosts";

export function PersonCostArcs({ data, progress }: { data: DailyPersonCosts; progress: number }) {
  const filled = Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0;
  let offset = 0;
  if (!data.people.length) return <circle className="person-cost-arc" style={{ stroke: "#929baa" }} cx="70" cy="70" r="53" pathLength="100" strokeDasharray={`${filled} ${100 - filled}`} />;
  return <>{data.people.map(person => {
    const length = filled * person.share;
    const start = offset;
    offset += length;
    return <circle key={person.id} className="person-cost-arc" data-person-id={person.id} style={{ stroke: person.color }} cx="70" cy="70" r="53" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} />;
  })}</>;
}

export function PersonCostLegend({ data, english }: { data: DailyPersonCosts; english: boolean }) {
  const percent = new Intl.NumberFormat(english ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
  return <div className="person-cost-legend" aria-label={english ? "Estimated cost allocation" : "按金额估算分摊"} title={english ? "Shares use today's known calendar-day model costs, not token counts or official per-user quota. Missing prices cannot be quantified; unassigned costs are gray. Cost and quota day boundaries may differ." : "按当日自然日的已知模型金额分摊，不按 Token 数，也不是官方个人额度。缺价部分无法量化；未归属金额用灰色。金额与额度的日界可能不同。"}>
    <small>{data.people.length ? (english ? "Cost-based estimate" : "按金额估算分摊") : (english ? "Waiting for cost data" : "等待金额数据")}{data.people.length && data.partial ? (english ? " · known costs only" : " · 仅已知金额") : ""}</small>
    <div>{data.people.map(person => <span key={person.id}>
      <i style={{ background: person.color }} aria-hidden="true" />
      <span>{person.unassigned ? (english ? "Unassigned" : "未归属") : person.name}</span>
      <strong>{percent.format(person.share * 100)}%</strong>
      <small>${person.cost.toFixed(2)}</small>
    </span>)}</div>
  </div>;
}
