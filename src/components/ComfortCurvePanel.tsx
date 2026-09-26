import type { ReactNode } from "react";
import { comfortFeedbackScore, smoothKneeEfficiency } from "../lib/comfortFeedback";
import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import type { Language, PersonalizedComfortCurve } from "../types";
import "./ComfortCurvePanel.css";

interface ComfortCurvePanelProps {
  curve: PersonalizedComfortCurve;
  language: Language;
  estimated?: boolean;
  personSelector?: ReactNode;
}

const LEFT = 88, RIGHT = 523, TOP = 25, BOTTOM = 169;
const codes = ["idle", "comfortable", "overloaded"] as const;
/** Expand for cumulative daily usage; never confuse it with remaining balance. */
export function comfortCurveAxis(values: readonly number[]): { maxPercent: number; ticks: number[] } {
  const valid = values.filter(value => Number.isFinite(value) && value >= 0 && value <= MAX_DAILY_OBSERVED_PERCENT);
  const required = Math.max(125, Math.max(0, ...valid) * 1.1);
  const step = [25, 50, 100, 250, 500, 1000, 2500, 5000].find(value => required / value <= 6) ?? 5000;
  const maxPercent = Math.ceil(required / step) * step;
  return { maxPercent, ticks: Array.from({ length: Math.round(maxPercent / step) + 1 }, (_, index) => index * step) };
}
const yPosition = (value: number) => BOTTOM - value * (BOTTOM - TOP);

export function ComfortCurvePanel({ curve, language, estimated = false, personSelector }: ComfortCurvePanelProps) {
  const fitted = curve.mode === "personalized";
  const zh = language !== "en";
  const labels = zh
    ? { title: "舒适曲线", fit: "仅拟合 k", empty: "默认参考", y: "相对效率（评分）", x: estimated ? "个人估算用量（%）" : "当天实际使用额度（%）", raw: "反馈位置", idle: "很轻松", comfortable: "刚刚好", overloaded: "有点撑" }
    : { title: "Comfort curve", fit: "Fit k only", empty: "Default reference", y: "Relative efficiency (score)", x: estimated ? "Personal estimated usage (%)" : "Actual quota used today (%)", raw: "Feedback positions", idle: "Light", comfortable: "Just right", overloaded: "Too much" };
  const observations = curve.observations.filter(item => Number.isFinite(item.usedPercent) && item.usedPercent >= 0 && item.usedPercent <= MAX_DAILY_OBSERVED_PERCENT && (item.fitWeight ?? 1) > 0);
  const axis = comfortCurveAxis(observations.map(item => item.usedPercent));
  const xPosition = (value: number) => LEFT + Math.max(0, value) / axis.maxPercent * (RIGHT - LEFT);
  const plotPoints = Array.from({ length: 201 }, (_, index) => {
    const usedPercent = index / 200 * axis.maxPercent;
    return { usedPercent, score: smoothKneeEfficiency(usedPercent, curve.xStarPercent) };
  });
  return <section className="comfort-curve-panel comfort-efficiency-panel comfort-experience-panel" aria-label={labels.title}>
    <header><strong>{labels.title}</strong>{personSelector}<span title={fitted ? labels.fit : labels.empty}>{(fitted ? "k = " : (zh ? "默认 k = " : "Default k = ")) + curve.xStarPercent.toFixed(1) + "%"}</span></header>
    <>
      <svg className="comfort-curve-chart comfort-efficiency-chart comfort-compact-chart" viewBox="0 0 548 230" role="img" aria-label={labels.title + "; " + labels.y + "; " + labels.x + "; " + labels.raw}>
        <title>{labels.title}</title>
        <desc>{zh ? "固定原有效率函数形式，仅根据主观反馈拟合 k。散点评分固定为轻松100%、刚好80%、撑25%，不是实测效率。横轴允许累计用量超过100%。" : "Original fixed efficiency function, fitting only k from subjective feedback. Scatter scores: light 100%, just right 80%, too much 25%; not measured efficiency. Cumulative usage may exceed 100%."}</desc>
        {[0, 25, 50, 75, 100].map(tick => <g key={tick}>
          <line className="comfort-curve-gridline" x1={LEFT} x2={RIGHT} y1={yPosition(tick / 100)} y2={yPosition(tick / 100)} />
          <text className="comfort-curve-tick" x={LEFT - 10} y={yPosition(tick / 100) + 5} textAnchor="end">{tick}%</text>
        </g>)}
        {axis.ticks.map(tick => <g key={"x-" + tick}>
          <line className="comfort-curve-gridline" x1={xPosition(tick)} x2={xPosition(tick)} y1={TOP} y2={BOTTOM} />
          <text className="comfort-curve-tick" x={xPosition(tick)} y={BOTTOM + 20} textAnchor={tick === axis.maxPercent ? "end" : tick === 0 ? "start" : "middle"}>{tick}%</text>
        </g>)}
        <polyline className="comfort-curve-line comfort-curve-line--personalized" points={plotPoints.map(point => xPosition(point.usedPercent).toFixed(1) + "," + yPosition(point.score).toFixed(1)).join(" ")} />
        {fitted && <line className="comfort-curve-fit-guide" x1={xPosition(curve.xStarPercent)} x2={xPosition(curve.xStarPercent)} y1={yPosition(smoothKneeEfficiency(curve.xStarPercent, curve.xStarPercent))} y2={BOTTOM} />}
        <text className="comfort-curve-axis-label" transform={"translate(20 " + (TOP + BOTTOM) / 2 + ") rotate(-90)"} textAnchor="middle">{labels.y}</text>
        {observations.map((observation, index) => {
          // User-defined subjective score: independent of k, with no invented jitter.
          return <circle key={observation.localDate + "-" + index} className={"comfort-curve-observation comfort-curve-observation--" + observation.comfort} data-category={observation.comfort} cx={xPosition(observation.usedPercent)} cy={yPosition(comfortFeedbackScore(observation.comfort))} r="4" opacity={0.25 + 0.75 * Math.min(1, observation.fitWeight ?? 1)}>
            <title>{observation.localDate + " · " + observation.usedPercent + "% · " + labels[observation.comfort] + (zh ? " · 约定评分 " : " · assigned score ") + comfortFeedbackScore(observation.comfort) * 100 + "%" + (observation.usageCoverage === "partial" ? (zh ? " · 用量不完整" : " · partial usage") : "")}</title>
          </circle>;
        })}
        <text className="comfort-curve-axis-label" x={(LEFT + RIGHT) / 2} y="221" textAnchor="middle">{labels.x}</text>
      </svg>
      <footer>{codes.map(code => <span key={code}><i className={"comfort-probability-swatch comfort-probability-swatch--" + code} />{labels[code]}</span>)}</footer>
      <details className="comfort-model-details"><summary>{curve.sampleCount + (zh ? " 条反馈 · 模型说明" : " observations · Model details")}</summary>
        <p>{zh ? "轻松=100%，刚好=80%，撑=25%。这些是约定的主观评分，不是实测效率。保持原函数形式，用加权最小二乘仅拟合 k（0.1–100%）；近期反馈权重更高，不完整用量降低权重。横轴随累计用量扩展，100%以上保持原来的20%下限；固定模型无法拟合的偏差会保留。无有效反馈时显示默认 k=25%。" : "Light=100%, just right=80%, too much=25%: assigned subjective scores, not measured efficiency. Weighted least squares fits only k (0.1–100%) in the original function. Recent feedback weighs more; partial usage weighs less. X expands with cumulative usage; above 100% the original 20% floor remains. Model mismatch is not hidden. No usable data uses default k=25%."}</p>
      </details>
    </>
  </section>;
}
