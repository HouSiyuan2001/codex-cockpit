import { buildTokenComfortModel } from "../lib/tokenComfort";
import { formatTokens } from "../lib/tokeiUsage";
import type { ComfortCode, ComfortFeedbackRecord, Language } from "../types";

const score: Record<ComfortCode, number> = { idle: 0, comfortable: 1, overloaded: 2 };
const LEFT = 98, TOP = 34, WIDTH = 420, HEIGHT = 128;

export function TokenComfortCurvePanel({ records, personId, language }: {
  records: readonly ComfortFeedbackRecord[]; personId: string | null; language: Language;
}) {
  const zh = language !== "en";
  const model = buildTokenComfortModel(records, personId);
  const max = Math.max(1, ...model.observations.map(point => point.tokenMillions)) * 1.08;
  const x = (millions: number) => LEFT + millions / max * WIDTH;
  const y = (value: number) => TOP + HEIGHT - value / 2 * HEIGHT;
  const labels = zh ? { idle: "很轻松", comfortable: "刚刚好", overloaded: "有点撑" } : { idle: "Easy", comfortable: "Just right", overloaded: "Too much" };
  return <section className="comfort-curve-panel token-comfort-panel" aria-label={zh ? "舒适曲线" : "Comfort curve"}>
    <header><strong>{zh ? "舒适曲线" : "Comfort curve"}</strong><span>{model.mode === "empirical-fit" ? (zh ? "趋势" : "Trend") : (zh ? "散点" : "Points")}</span></header>
    <svg className="token-comfort-chart" viewBox="0 0 548 222" role="img" aria-label={zh ? "每日 Token与主观舒适度" : "Daily tokens (M) and subjective comfort"}>
      <desc>{zh ? "纵轴是三档主观感受，不是工作效率或产出；空心点表示部分用量，不参与趋势拟合。" : "The vertical axis contains three subjective categories, not productivity. Hollow points have partial usage and are excluded from the trend."}</desc>
      {(["idle", "comfortable", "overloaded"] as const).map(code => <g key={code}>
        <line className="comfort-curve-gridline" x1={LEFT} x2={LEFT + WIDTH} y1={y(score[code])} y2={y(score[code])} />
        <text className="token-comfort-axis-text" x={LEFT - 10} y={y(score[code])} textAnchor="end" dominantBaseline="middle">{labels[code]}</text>
      </g>)}
      <path className="token-comfort-axis" d={`M${LEFT} ${TOP}V${TOP + HEIGHT}H${LEFT + WIDTH}`} />
      {[0, .25, .5, .75, 1].map(fraction => <text key={fraction} className="token-comfort-axis-text" x={x(max * fraction)} y={TOP + HEIGHT + 20} textAnchor="middle">{zh ? formatTokens(max * fraction * 1e6, true) : (max * fraction).toLocaleString("en-US", { maximumFractionDigits: 1 })}</text>)}
      <text className="token-comfort-axis-text" x={LEFT + WIDTH / 2} y="211" textAnchor="middle">{zh ? "每日 Token" : "Daily tokens (M)"}</text>
      <text className="token-comfort-axis-text" transform="translate(17 98) rotate(-90)" textAnchor="middle">{zh ? "主观舒适度" : "Subjective comfort"}</text>
      {model.trend && <polyline className="token-comfort-trend" points={model.trend.points.map(point => `${x(point.tokenMillions)},${y(point.comfortScore)}`).join(" ")} />}
      {model.observations.map(point => <circle key={point.localDate} className={`token-comfort-dot${point.eligibleForFit ? "" : " is-partial"}`} cx={x(point.tokenMillions)} cy={y(score[point.comfort])} r="4.5"><title>{`${point.localDate} · ${formatTokens(point.tokenMillions * 1e6, zh)} · ${labels[point.comfort]}${point.coverage === "partial" ? (zh ? " · 部分记录" : " · Partial") : ""}`}</title></circle>)}
    </svg>
    {model.sampleCount === 0 && <p className="comfort-person-note">{personId ? (zh ? "还没有这位用户的 Token 体验记录。记录后会显示散点。" : "No token feedback for this person yet. Check-ins will appear as points.") : (zh ? "旧记录没有所属用户或 Token 快照，保留在下方日历，不参与拟合。" : "Legacy entries remain in the calendar; no person or token usage is inferred.")}</p>}
    <footer><span><i className="token-comfort-key" />{zh ? "完整日账" : "Complete day"}</span><span><i className="token-comfort-key is-partial" />{zh ? "部分记录" : "Partial day"}</span><span>{zh ? `完整样本 ${model.completeSampleCount} 天` : `${model.completeSampleCount} complete days`}</span></footer>
    <details className="comfort-person-note"><summary>{zh ? "说明" : "About"}</summary><p>{model.trend ? (zh ? "虚线仅描述本人反馈，不代表效率或因果。" : "The trend describes feedback, not productivity or causation.") : (zh ? "趋势需要至少 7 个完整日、3 档用量且跨度 ≥10万；部分记录不参与。" : "A trend needs 7 complete days, 3 usage levels and a span of 0.1M. Partial days are excluded.")}</p></details>
  </section>;
}
