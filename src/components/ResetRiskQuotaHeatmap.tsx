import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { planRemainingQuota, quotaConsumptionUrgency, type RemainingQuotaInput } from "../lib/dynamicQuota";
import type { Language, PersonalizedComfortCurve } from "../types";
import type { MidnightPlanBasis } from "../lib/midnightQuotaPlan";
import { usageHeatmapColor } from "../lib/usageHeatmapColor";

interface Props {
  dayPlan?: MidnightPlanBasis;
  language: Language;
  comfortPersonName?: string | null;
  comfortCurve: PersonalizedComfortCurve;
  currentRemainingPercent: number | null;
  currentRiskPercent: number | null;
  daysLeftInCycle: number | null;
  isWeekend: boolean;
  todayUsedPercent?: number;
  todayFractionRemaining?: number;
}

export function quotaHeatmapUsage(input: RemainingQuotaInput): number {
  return planRemainingQuota(input).suggestedUsagePercent;
}

// At fixed live balance, varying R/D is equivalent to varying the reset horizon.
// Zero urgency is the infinite-horizon limit, not an already expired snapshot.
export function quotaUrgencyHeatmapUsage(input: Omit<RemainingQuotaInput, "daysUntilReset"> & { urgencyPercentPerDay: number }): number {
  const { urgencyPercentPerDay, ...rest } = input;
  const horizon = urgencyPercentPerDay > 0 && input.remainingPercent > 0
    ? input.remainingPercent / urgencyPercentPerDay : Number.MAX_VALUE;
  return quotaHeatmapUsage({ ...rest, daysUntilReset: horizon });
}

// The plot keeps its established data coordinates, while the wider viewBox
// adds room for percentage ticks at the largest UI font scale.
export const HEATMAP_VIEWBOX_MIN_X = -32;
export const HEATMAP_VIEWBOX_WIDTH = 520;
export const HEATMAP_VIEWBOX_HEIGHT = 258;
export const HEATMAP_COLORBAR_FONT_SIZE_PX = 6.5;
export const HEATMAP_MAX_UI_FONT_SCALE = 2;
export const HEATMAP_VIEWBOX_SAFE_MARGIN = 8;

const LEFT = 42, TOP = 24, WIDTH = 408, HEIGHT = 170;
const COLUMNS = 40, ROWS = 28;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const HEATMAP_LOW_CONFIDENCE_THRESHOLD = 0.5;

export function heatmapComfortBasisLabel(curve: PersonalizedComfortCurve, language: Language): string {
  const zh = language !== "en";
  const fitted = curve.mode === "personalized" && curve.sampleCount > 0;
  const knee = clamp(
    Number.isFinite(curve.xStarPercent) ? curve.xStarPercent : curve.baselineXStarPercent,
    0.1,
    100,
  );
  if (!fitted) return `${zh ? "默认基准" : "Default basis"} k ${knee.toFixed(1)}% · ${zh ? "无有效反馈" : "no usable feedback"}`;
  const lowConfidence = !Number.isFinite(curve.confidence) || curve.confidence < HEATMAP_LOW_CONFIDENCE_THRESHOLD;
  return `${zh ? "热图基准" : "Heatmap basis"} k ${knee.toFixed(1)}%${lowConfidence ? ` · ${zh ? "低信心" : "low confidence"}` : ""}`;
}

/**
 * The pace axis is zero-preserving and logarithmic above a one-percent/day
 * linear threshold. Keeping the transform in one pair of functions prevents
 * the marker, cell centers, and tick labels from drifting apart.
 */
export const HEATMAP_SYMLOG_LINEAR_THRESHOLD = 1;
export const HEATMAP_BASE_URGENCY_TICKS = [0, 1, 2, 5, 10, 20, 30, 50, 100] as const;

function normalizedSymlogDomainMax(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function heatmapSymlogForward(value: number, domainMax: number): number {
  const safeMax = normalizedSymlogDomainMax(domainMax);
  if (safeMax === 0) return 0;
  const safeValue = value === Infinity
    ? safeMax
    : Number.isFinite(value)
      ? clamp(value, 0, safeMax)
      : 0;
  const scale = Math.log1p(safeMax / HEATMAP_SYMLOG_LINEAR_THRESHOLD);
  return scale > 0
    ? Math.log1p(safeValue / HEATMAP_SYMLOG_LINEAR_THRESHOLD) / scale
    : 0;
}

export function heatmapSymlogInverse(fraction: number, domainMax: number): number {
  const safeMax = normalizedSymlogDomainMax(domainMax);
  if (safeMax === 0) return 0;
  const safeFraction = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
  return HEATMAP_SYMLOG_LINEAR_THRESHOLD * Math.expm1(
    safeFraction * Math.log1p(safeMax / HEATMAP_SYMLOG_LINEAR_THRESHOLD),
  );
}

function normalizedHeatmapTickDomain(maxUrgency: number): number {
  return Number.isFinite(maxUrgency) && maxUrgency > 0 ? maxUrgency : 100;
}

export function heatmapUrgencyTickValues(maxUrgency: number): number[] {
  const domainMax = normalizedHeatmapTickDomain(maxUrgency);
  const ticks: number[] = HEATMAP_BASE_URGENCY_TICKS.filter(value => value <= domainMax);
  if (!ticks.includes(domainMax)) ticks.push(domainMax);
  return [...new Set(ticks)].sort((a, b) => a - b);
}

export function formatHeatmapUrgencyTick(value: number): string {
  const rounded = Math.abs(value - Math.round(value)) < 1e-9 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded}%`;
}

function normalizedUiFontScale(value: number): number {
  return Number.isFinite(value) ? clamp(value, 1, HEATMAP_MAX_UI_FONT_SCALE) : 1;
}

function normalizedRenderedWidth(value: number | null | undefined): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : HEATMAP_VIEWBOX_WIDTH;
}

/**
 * Return the SVG user-unit font size that renders at the same CSS-pixel size
 * as the HTML colorbar after the SVG viewBox is scaled to its actual width.
 */
export function heatmapSvgTextFontSize(renderedWidth: number | null | undefined, uiFontScale = 1): number {
  return HEATMAP_COLORBAR_FONT_SIZE_PX
    * normalizedUiFontScale(uiFontScale)
    * HEATMAP_VIEWBOX_WIDTH
    / normalizedRenderedWidth(renderedWidth);
}

export function heatmapSvgScaleCompensation(renderedWidth: number | null | undefined): number {
  return HEATMAP_VIEWBOX_WIDTH / normalizedRenderedWidth(renderedWidth);
}

interface CurrentLabelGeometryInput {
  pointX: number;
  pointY: number;
  label: string;
  language: Language;
  renderedWidth?: number | null;
  uiFontScale?: number;
}

export interface CurrentLabelGeometry {
  x: number;
  y: number;
  textAnchor: "start" | "end";
  fontSize: number;
  estimatedWidth: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface AxisTickGeometryInput {
  axis: "x" | "y";
  position: number;
  label: string;
  language: Language;
  renderedWidth?: number | null;
  uiFontScale?: number;
}

export interface AxisTickGeometry {
  x: number;
  y: number;
  textAnchor: "start" | "middle" | "end";
  fontSize: number;
  estimatedWidth: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function estimatedSvgTextWidth(label: string, fontSize: number, language: Language): number {
  const advance = [...label].reduce((total, character) => {
    if (character === " ") return total + 0.32;
    if (language !== "en" && character.codePointAt(0)! >= 0x2e80) return total + 1;
    return total + 0.62;
  }, 0);
  // A small cushion covers font-specific glyph metrics and the text outline.
  return advance * fontSize * 1.08;
}

/**
 * Position the live label with a safe viewBox margin. The placement uses the
 * largest configured UI scale so changing the preference cannot clip the
 * label before the next resize observation.
 */
export function heatmapCurrentLabelGeometry(input: CurrentLabelGeometryInput): CurrentLabelGeometry {
  const fontSize = heatmapSvgTextFontSize(input.renderedWidth, input.uiFontScale ?? 1) * 1.08;
  const estimatedWidth = estimatedSvgTextWidth(input.label, fontSize, input.language);
  const rightMargin = HEATMAP_VIEWBOX_SAFE_MARGIN;
  const preferredX = input.pointX + 9;
  const safeRight = HEATMAP_VIEWBOX_MIN_X + HEATMAP_VIEWBOX_WIDTH - rightMargin;
  const maxStartX = safeRight - estimatedWidth;
  const startsToRight = preferredX <= maxStartX;
  const textAnchor = startsToRight ? "start" : "end";
  const x = startsToRight
    ? clamp(preferredX, LEFT + 8, maxStartX)
    : safeRight;
  const y = clamp(input.pointY - 8, TOP + 13, TOP + HEIGHT - 8);
  const left = textAnchor === "start" ? x : x - estimatedWidth;
  const right = textAnchor === "start" ? x + estimatedWidth : x;
  return {
    x,
    y,
    textAnchor,
    fontSize,
    estimatedWidth,
    left,
    right,
    top: y - fontSize,
    bottom: y + fontSize * 0.25,
  };
}

/**
 * Keep every axis tick inside the expanded viewBox at the largest configured
 * UI scale. Endpoint anchors keep the x-axis labels away from the corners,
 * while the extra left viewBox margin gives y-axis labels natural glyph width.
 */
export function heatmapAxisTickGeometry(input: AxisTickGeometryInput): AxisTickGeometry {
  const fontSize = heatmapSvgTextFontSize(input.renderedWidth, input.uiFontScale ?? 1);
  const naturalWidth = estimatedSvgTextWidth(input.label, fontSize, input.language);
  const isX = input.axis === "x";
  const x = isX ? input.position : LEFT - 7;
  const textAnchor: AxisTickGeometry["textAnchor"] = isX
    ? input.position <= LEFT ? "start" : input.position >= LEFT + WIDTH ? "end" : "middle"
    : "end";
  const estimatedWidth = naturalWidth;
  const baseline = isX
    ? TOP + HEIGHT + 17
    : TOP + HEIGHT * (1 - clamp(input.position, 0, 100) / 100) + 3;
  const y = clamp(baseline, HEATMAP_VIEWBOX_SAFE_MARGIN + fontSize, HEATMAP_VIEWBOX_HEIGHT - HEATMAP_VIEWBOX_SAFE_MARGIN - fontSize * 0.25);
  const left = textAnchor === "start" ? x : textAnchor === "end" ? x - estimatedWidth : x - estimatedWidth / 2;
  const right = textAnchor === "start" ? x + estimatedWidth : textAnchor === "end" ? x : x + estimatedWidth / 2;
  return {
    x,
    y,
    textAnchor,
    fontSize,
    estimatedWidth,
    left,
    right,
    top: y - fontSize,
    bottom: y + fontSize * 0.25,
  };
}

/**
 * Select x-axis ticks that fit at the current rendered width and UI scale.
 * The zero and domain-end ticks are retained; crowded interior ticks are
 * thinned from the symlog candidates so labels never paint over one another.
 */
export function heatmapXTickValues(
  maxUrgency: number,
  renderedWidth: number | null | undefined = HEATMAP_VIEWBOX_WIDTH,
  uiFontScale = 1,
  language: Language = "en",
): number[] {
  const domainMax = normalizedHeatmapTickDomain(maxUrgency);
  const candidates = heatmapUrgencyTickValues(domainMax);
  const endpoint = candidates.at(-1) ?? domainMax;
  const geometryFor = (value: number) => heatmapAxisTickGeometry({
    axis: "x",
    position: LEFT + WIDTH * heatmapSymlogForward(value, domainMax),
    label: formatHeatmapUrgencyTick(value),
    language,
    renderedWidth,
    uiFontScale,
  });
  const hasGap = (left: AxisTickGeometry, right: AxisTickGeometry) => (
    right.left - left.right >= Math.max(3, left.fontSize * 0.2)
  );
  const selected: number[] = [];
  for (const value of candidates.slice(0, -1)) {
    const geometry = geometryFor(value);
    const previous = selected.at(-1);
    if (previous === undefined || hasGap(geometryFor(previous), geometry)) selected.push(value);
  }
  while (selected.length > 1 && !hasGap(geometryFor(selected.at(-1)!), geometryFor(endpoint))) selected.pop();
  if (selected.at(-1) !== endpoint) selected.push(endpoint);
  return selected;
}

export function ResetRiskQuotaHeatmap({ language, comfortPersonName, comfortCurve, currentRemainingPercent, currentRiskPercent, daysLeftInCycle, isWeekend, todayUsedPercent = 0, todayFractionRemaining = 1, dayPlan }: Props) {
  const panelRef = useRef<SVGSVGElement>(null);
  const [renderedWidth, setRenderedWidth] = useState(HEATMAP_VIEWBOX_WIDTH);
  const zh = language !== "en";
  const knee = clamp(comfortCurve.xStarPercent, 0.1, 100);
  const live = Number.isFinite(currentRemainingPercent) && Number.isFinite(currentRiskPercent) && Number.isFinite(daysLeftInCycle) && Number(daysLeftInCycle) > 0;
  const remaining = clamp(currentRemainingPercent ?? 0, 0, 100);
  const risk = clamp(currentRiskPercent ?? 10, 0, 100);
  const days = Math.max(0, daysLeftInCycle ?? 0);
  const urgency = quotaConsumptionUrgency(remaining, days) ?? 0;
  const maxUrgency = Number.isFinite(urgency)
    ? Math.max(100, Math.ceil(Math.max(0, urgency) / 25) * 25)
    : 100;
  const input = { tomorrowRiskPercent: risk, fatigueKneePercent: knee, isWeekend, todayUsedPercent, todayFractionRemaining };
  const amount = quotaHeatmapUsage({ ...input, remainingPercent: remaining, daysUntilReset: days });
  const x = LEFT + WIDTH * heatmapSymlogForward(urgency, maxUrgency);
  const y = TOP + HEIGHT * (1 - risk / 100);
  // Compute recommendations unchanged; color uses the personal fitted-k domain,
  // independent of the current balance or the sampled grid extrema.
  const cells = live ? Array.from({ length: ROWS }, (_, row) => Array.from({ length: COLUMNS }, (_, column) => {
    const pace = heatmapSymlogInverse((column + 0.5) / COLUMNS, maxUrgency);
    const cellRisk = (row + 0.5) * 100 / ROWS;
    const usage = quotaUrgencyHeatmapUsage({ ...input, remainingPercent: remaining, urgencyPercentPerDay: pace, tomorrowRiskPercent: cellRisk });
    return { row, column, pace, cellRisk, usage };
  })).flat() : [];
  const colorMin = 0;
  const colorMax = knee;
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = (width?: number) => {
      const nextWidth = width ?? panel.getBoundingClientRect().width;
      if (!Number.isFinite(nextWidth) || nextWidth <= 0) return;
      setRenderedWidth(previous => Math.abs(previous - nextWidth) < 0.5 ? previous : nextWidth);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      measure(entries[0]?.contentRect.width);
    });
    observer?.observe(panel);
    const measureOnResize = () => measure();
    window.addEventListener("resize", measureOnResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measureOnResize);
    };
  }, [live]);
  const label = dayPlan ? (zh ? "拟合建议" : "fit-based total") : (zh ? "拟合建议增量" : "fit-based additional use");
  const labelGeometry = heatmapCurrentLabelGeometry({
    pointX: x,
    pointY: y,
    label: label + " " + amount.toFixed(1) + "%",
    language,
    renderedWidth,
    // The label coordinate is conservative so it remains safe throughout the
    // complete 100–200% preference range, including before CSS repaints.
    uiFontScale: HEATMAP_MAX_UI_FONT_SCALE,
  });
  const heatmapStyle = {
    "--reset-risk-heatmap-svg-scale-compensation": String(heatmapSvgScaleCompensation(renderedWidth)),
  } as CSSProperties;
  return (
    <section className="reset-risk-heatmap" style={heatmapStyle} aria-labelledby="reset-risk-heatmap-title">
      <header>
        <div>
          <strong id="reset-risk-heatmap-title">{zh ? "额度配速 × 重置风险" : "Quota pace × reset risk"}</strong>
        </div>
        <span title={dayPlan ? `${dayPlan.localDate} · ${dayPlan.anchorAt} · ${zh ? "计划余额" : "plan balance"} ${dayPlan.remainingPercent}%` : undefined}>{comfortPersonName ? `${comfortPersonName} · ` : ""}{heatmapComfortBasisLabel(comfortCurve, language)}</span>
      </header>
      {live ? <>
        <svg ref={panelRef} className="reset-risk-heatmap-panel reset-risk-heatmap-panel--personal" viewBox={`${HEATMAP_VIEWBOX_MIN_X} 0 ${HEATMAP_VIEWBOX_WIDTH} ${HEATMAP_VIEWBOX_HEIGHT}`} role="img" aria-label={zh ? "额度配速与重置风险热图" : "Quota pace and reset risk heatmap"}>
          <desc>{dayPlan ? (zh ? "余额和剩余天数固定在计划基准时刻；颜色为所选组员拟合 k 对应的参考建议，不修改账号共享计划。" : "Balance and horizon use the plan baseline; colors show a reference estimate from the selected member's fitted k, without changing the shared account plan.") : (zh ? "横轴为剩余额度除以距自然重置天数，单位为周额度百分比每天；纵轴为提前重置风险，颜色为所选组员拟合 k 对应的建议增量，不修改账号共享计划。" : "X: remaining weekly quota divided by days until reset. Y: early-reset risk. Colors show fit-based additional use for the selected member, without changing the shared account plan.")}</desc>
          {cells.map(({ row, column, pace, cellRisk, usage }) =>
            <rect key={`${row}-${column}`} x={LEFT + column * WIDTH / COLUMNS} y={TOP + HEIGHT - (row + 1) * HEIGHT / ROWS} width={WIDTH / COLUMNS + 0.2} height={HEIGHT / ROWS + 0.2} fill={usageHeatmapColor(usage, colorMin, colorMax)}><title>{`${pace.toFixed(1)}%/${zh ? "天" : "day"} · ${cellRisk.toFixed(1)}% ${zh ? "风险" : "risk"} → ${usage.toFixed(1)}%`}</title></rect>
          )}
          <rect className="reset-risk-heatmap-frame" x={LEFT} y={TOP} width={WIDTH} height={HEIGHT} />
          {heatmapXTickValues(maxUrgency, renderedWidth, HEATMAP_MAX_UI_FONT_SCALE, language).map(value => {
            const text = formatHeatmapUrgencyTick(value);
            const geometry = heatmapAxisTickGeometry({ axis: "x", position: LEFT + WIDTH * heatmapSymlogForward(value, maxUrgency), label: text, language, renderedWidth, uiFontScale: HEATMAP_MAX_UI_FONT_SCALE });
            return <text key={`x${value}`} className="reset-risk-heatmap-axis-text" x={geometry.x} y={geometry.y} textAnchor={geometry.textAnchor}>{text}</text>;
          })}
          {[0, 25, 50, 75, 100].map(value => {
            const text = `${value}%`;
            const geometry = heatmapAxisTickGeometry({ axis: "y", position: value, label: text, language, renderedWidth, uiFontScale: HEATMAP_MAX_UI_FONT_SCALE });
            return <text key={`y${value}`} className="reset-risk-heatmap-axis-text" x={geometry.x} y={geometry.y} textAnchor={geometry.textAnchor}>{text}</text>;
          })}
          <text className="reset-risk-heatmap-axis-text reset-risk-heatmap-axis-title--x" x={LEFT + WIDTH / 2} y="242" textAnchor="middle">{zh ? "余额 ÷ 重置天数（%/天）" : "Balance / days to reset (%/day)"}</text>
          <text className="reset-risk-heatmap-axis-text reset-risk-heatmap-axis-title--y" transform={`translate(-18 ${TOP + HEIGHT / 2}) rotate(-90)`} textAnchor="middle" dominantBaseline="middle">{zh ? "重置风险（%）" : "Reset risk (%)"}</text>
          <circle className="reset-risk-heatmap-current-ring" cx={x} cy={y} r="6" />
          <circle className="reset-risk-heatmap-current-dot" cx={x} cy={y} r="3.7" />
          <text className="reset-risk-heatmap-current-label" x={labelGeometry.x} y={labelGeometry.y} textAnchor={labelGeometry.textAnchor}>{label} {amount.toFixed(1)}%</text>
        </svg>
        <div className="reset-risk-heatmap-legend" aria-label={zh ? "今天建议用量色标" : "Suggested usage color scale"}><span>{colorMin.toFixed(1)}%</span><i style={colorMin === colorMax ? { background: usageHeatmapColor(colorMin, colorMin, colorMax) } : undefined} /><span>{colorMax.toFixed(1)}%</span></div>
        <footer><span className="reset-risk-heatmap-axis-title reset-risk-heatmap-axis-title--color">{dayPlan ? (zh ? "颜色：拟合建议（占周额度）" : "color: fit-based total (% of weekly quota)") : (zh ? "颜色：拟合建议增量（占周额度）" : "color: fit-based additional use (% of weekly quota)")}</span>{dayPlan && <span title={dayPlan.capturedAt}>{dayPlan.kind === "near-midnight" ? (zh ? "零点附近快照估计" : "Near-midnight estimate") : dayPlan.kind === "first-observation" ? (zh ? "缺少零点快照，使用首次读数" : "No midnight snapshot; first observation used") : "00:00 · UTC+8"}</span>}</footer>
      </> : <p className="reset-risk-heatmap-empty">{zh ? "暂无可用额度数据" : "Quota data unavailable"}</p>}
    </section>
  );
}
