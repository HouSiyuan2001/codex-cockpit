// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { personalizeComfortCurve } from "../lib/comfortFeedback";
import { buildDailyRecommendation, planRemainingQuota, quotaConsumptionUrgency } from "../lib/dynamicQuota";
import {
  HEATMAP_VIEWBOX_MIN_X,
  HEATMAP_VIEWBOX_SAFE_MARGIN,
  HEATMAP_VIEWBOX_WIDTH,
  HEATMAP_VIEWBOX_HEIGHT,
  formatHeatmapUrgencyTick,
  heatmapComfortBasisLabel,
  ResetRiskQuotaHeatmap,
  heatmapAxisTickGeometry,
  heatmapCurrentLabelGeometry,
  heatmapSvgTextFontSize,
  heatmapSymlogForward,
  heatmapSymlogInverse,
  heatmapUrgencyTickValues,
  heatmapXTickValues,
  quotaUrgencyHeatmapUsage,
} from "./ResetRiskQuotaHeatmap";
afterEach(cleanup);

it.each([1, 1.5, 2])("keeps SVG labels at least as large as the HTML colorbar at %s00%% UI scale", uiFontScale => {
  for (const renderedWidth of [320, 384, 472, 560]) {
    const svgFontSize = heatmapSvgTextFontSize(renderedWidth, uiFontScale);
    const renderedFontSize = svgFontSize * renderedWidth / HEATMAP_VIEWBOX_WIDTH;
    expect(renderedFontSize).toBeGreaterThanOrEqual(6.5 * uiFontScale);
  }
});

it("clamps typography to the configured 100–200% UI range", () => {
  expect(heatmapSvgTextFontSize(HEATMAP_VIEWBOX_WIDTH, 0.5)).toBe(6.5);
  expect(heatmapSvgTextFontSize(HEATMAP_VIEWBOX_WIDTH, 2.5)).toBe(13);
});

it("keeps the symlog pace transform zero-preserving and reversible", () => {
  expect(heatmapSymlogForward(0, 100)).toBe(0);
  expect(heatmapSymlogInverse(0, 100)).toBe(0);
  for (const pace of [0, 1, 2, 5, 10, 20, 30, 50, 100, 125]) {
    const domain = Math.max(100, pace);
    expect(heatmapSymlogInverse(heatmapSymlogForward(pace, domain), domain)).toBeCloseTo(pace, 10);
  }
  expect(heatmapUrgencyTickValues(100)).toEqual([0, 1, 2, 5, 10, 20, 30, 50, 100]);
  expect(heatmapUrgencyTickValues(125)).toEqual([0, 1, 2, 5, 10, 20, 30, 50, 100, 125]);
});

it("thins crowded symlog labels while preserving zero and a dynamic high-end domain", () => {
  for (const [renderedWidth, uiFontScale] of [[320, 2], [384, 2], [472, 1.5]] as const) {
    const values = heatmapXTickValues(125, renderedWidth, uiFontScale, "en");
    const geometries = values.map(value => heatmapAxisTickGeometry({
      axis: "x",
      position: 42 + 408 * heatmapSymlogForward(value, 125),
      label: formatHeatmapUrgencyTick(value),
      language: "en",
      renderedWidth,
      uiFontScale,
    }));
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(125);
    for (let index = 1; index < geometries.length; index += 1) {
      expect(geometries[index].left - geometries[index - 1].right).toBeGreaterThanOrEqual(Math.max(3, geometries[index - 1].fontSize * 0.2));
    }
  }
});

it.each(["en", "zh-CN"] as const)("keeps x/y tick labels inside the SVG viewBox at 200%% in %s", language => {
  const xValues = heatmapXTickValues(800, 320, 2, language);
  const xTicks = xValues.map(value => heatmapAxisTickGeometry({
    axis: "x",
    position: 42 + 408 * heatmapSymlogForward(value, 800),
    label: formatHeatmapUrgencyTick(value),
    language,
    renderedWidth: 320,
    uiFontScale: 2,
  }));
  const yTicks = [0, 25, 50, 75, 100].map(value => heatmapAxisTickGeometry({
    axis: "y",
    position: value,
    label: `${value}%`,
    language,
    renderedWidth: 320,
    uiFontScale: 2,
  }));

  for (const geometry of [...xTicks, ...yTicks]) {
    expect(geometry.left).toBeGreaterThanOrEqual(HEATMAP_VIEWBOX_MIN_X + HEATMAP_VIEWBOX_SAFE_MARGIN);
    expect(geometry.right).toBeLessThanOrEqual(HEATMAP_VIEWBOX_MIN_X + HEATMAP_VIEWBOX_WIDTH - HEATMAP_VIEWBOX_SAFE_MARGIN);
    expect(geometry.top).toBeGreaterThanOrEqual(HEATMAP_VIEWBOX_SAFE_MARGIN);
    expect(geometry.bottom).toBeLessThanOrEqual(HEATMAP_VIEWBOX_HEIGHT - HEATMAP_VIEWBOX_SAFE_MARGIN);
  }
  expect(xValues).toContain(0);
  expect(xValues).toContain(800);
  expect(xTicks.at(-1)?.textAnchor).toBe("end");
});

it.each(["en", "zh-CN"] as const)("keeps the current-point label inside the SVG viewBox for long %s copy", language => {
  const label = language === "en" ? "fit-based additional use 100.0%" : "拟合建议增量 100.0%";
  const geometry = heatmapCurrentLabelGeometry({
    pointX: 450,
    pointY: 24,
    label,
    language,
    renderedWidth: 320,
    uiFontScale: 2,
  });

  expect(geometry.left).toBeGreaterThanOrEqual(HEATMAP_VIEWBOX_MIN_X + HEATMAP_VIEWBOX_SAFE_MARGIN);
  expect(geometry.right).toBeLessThanOrEqual(HEATMAP_VIEWBOX_MIN_X + HEATMAP_VIEWBOX_WIDTH - HEATMAP_VIEWBOX_SAFE_MARGIN);
  expect(geometry.top).toBeGreaterThanOrEqual(HEATMAP_VIEWBOX_SAFE_MARGIN);
  expect(geometry.bottom).toBeLessThanOrEqual(HEATMAP_VIEWBOX_HEIGHT - HEATMAP_VIEWBOX_SAFE_MARGIN);
});

it.each(["en", "zh-CN"] as const)("uses zero to personal k rather than grid extrema in %s", language => {
  const { container } = render(<ResetRiskQuotaHeatmap language={language} comfortCurve={{ ...personalizeComfortCurve([]), xStarPercent: 80 }} currentRemainingPercent={100} currentRiskPercent={100} daysLeftInCycle={1} isWeekend={false} />);
  expect(container.querySelector(".reset-risk-heatmap-legend")?.textContent).toBe("0.0%80.0%");
  const cells = [...container.querySelectorAll("rect[fill]")];
  const values = cells.map(cell => Number(cell.textContent?.split("→ ")[1]?.replace("%", "")));
  expect(values.some(value => value > 80)).toBe(true);
  cells.forEach((cell, index) => {
    if (values[index] > 80) expect(cell).toHaveAttribute("fill", "rgb(230, 88, 81)");
  });
  expect(container.querySelector(".reset-risk-heatmap-current-label")?.textContent).toContain("100.0%");
});

it("keeps the domain stable across balance changes and follows a new fitted k", () => {
  const props = { language: "en" as const, comfortCurve: { ...personalizeComfortCurve([]), xStarPercent: 37.6 }, currentRemainingPercent: 80, currentRiskPercent: 10, daysLeftInCycle: 4, isWeekend: false };
  const { container, rerender } = render(<ResetRiskQuotaHeatmap {...props} />);
  const legend = () => container.querySelector(".reset-risk-heatmap-legend")!.textContent;
  expect(legend()).toBe("0.0%37.6%");
  rerender(<ResetRiskQuotaHeatmap {...props} currentRemainingPercent={12} isWeekend todayUsedPercent={20} todayFractionRemaining={0.25} />);
  expect(legend()).toBe("0.0%37.6%");
  rerender(<ResetRiskQuotaHeatmap {...props} comfortCurve={{ ...props.comfortCurve, xStarPercent: 18.3 }} />);
  expect(legend()).toBe("0.0%18.3%");
});

it.each(["en", "zh-CN"] as const)("labels fitted, low-confidence, and missing k states in %s", language => {
  const baseline = personalizeComfortCurve([]);
  const fitted = { ...baseline, mode: "personalized" as const, sampleCount: 8, confidence: 0.62, xStarPercent: 78.9 };
  const lowConfidence = { ...fitted, sampleCount: 1, confidence: 0.49 };
  expect(heatmapComfortBasisLabel(fitted, language)).toBe(language === "en" ? "Heatmap basis k 78.9%" : "热图基准 k 78.9%");
  expect(heatmapComfortBasisLabel(lowConfidence, language)).toBe(language === "en" ? "Heatmap basis k 78.9% · low confidence" : "热图基准 k 78.9% · 低信心");
  expect(heatmapComfortBasisLabel(baseline, language)).toBe(language === "en" ? "Default basis k 25.0% · no usable feedback" : "默认基准 k 25.0% · 无有效反馈");
});

it("keeps a zero grid blue while retaining the personal-k legend", () => {
  const { container } = render(<ResetRiskQuotaHeatmap language="en" comfortCurve={personalizeComfortCurve([])} currentRemainingPercent={0} currentRiskPercent={10} daysLeftInCycle={4} isWeekend={false} />);
  expect(container.querySelector(".reset-risk-heatmap-legend")?.textContent).toBe("0.0%25.0%");
  const fills = new Set([...container.querySelectorAll("rect[fill]")].map(cell => cell.getAttribute("fill")));
  expect([...fills]).toEqual(["rgb(48, 91, 132)"]);
  expect(container.querySelector(".reset-risk-heatmap-legend i")).not.toHaveAttribute("style");
});

it("plots the live recommendation at R/D on x and reset risk on y", () => {
  const curve = personalizeComfortCurve([]);
  const recommendation = buildDailyRecommendation({
    weeklyWindow: { remainingPercent: 80, resetsAt: "2026-09-11T20:00:00Z", windowSeconds: 604800 },
    now: new Date("2026-09-09T08:00:00Z"), todayUsedPercent: 5,
  })!;
  const { container } = render(<ResetRiskQuotaHeatmap language="zh-CN" comfortCurve={curve} currentRemainingPercent={80} currentRiskPercent={recommendation.resetRiskPercent} daysLeftInCycle={recommendation.futureDays} isWeekend={false} todayUsedPercent={recommendation.todayUsedPercent} todayFractionRemaining={recommendation.todayFractionRemaining} />);
  expect(screen.getByText(`拟合建议增量 ${recommendation.additionalUsagePercent!.toFixed(1)}%`)).toBeInTheDocument();
  expect(screen.getByText("余额 ÷ 重置天数（%/天）").closest("svg")).not.toBeNull();
  expect(container.textContent).not.toContain("紧迫度");
  expect(screen.getByText("重置风险（%）")).toHaveAttribute("transform", "translate(-18 109) rotate(-90)");
  expect(container.querySelector("footer .reset-risk-heatmap-axis-title--x")).toBeNull();
  expect(container.querySelector("footer .reset-risk-heatmap-axis-title--y")).toBeNull();
  expect(Number(container.querySelector(".reset-risk-heatmap-current-dot")?.getAttribute("cx"))).toBeCloseTo(42 + 408 * heatmapSymlogForward(32, 100));
  expect(Number(container.querySelector(".reset-risk-heatmap-current-dot")?.getAttribute("cy"))).toBeCloseTo(24 + 170 * (1 - recommendation.resetRiskPercent / 100));
  expect(screen.queryByText(/昨日结转/)).toBeNull();
});

it("moves right for more quota or less time without changing risk height", () => {
  const props = { language: "en" as const, comfortCurve: personalizeComfortCurve([]), currentRiskPercent: 50, isWeekend: false };
  const { container, rerender } = render(<ResetRiskQuotaHeatmap {...props} currentRemainingPercent={40} daysLeftInCycle={4} />);
  const point = () => container.querySelector(".reset-risk-heatmap-current-dot")!;
  const x0 = Number(point().getAttribute("cx"));
  rerender(<ResetRiskQuotaHeatmap {...props} currentRemainingPercent={80} daysLeftInCycle={4} />);
  expect(Number(point().getAttribute("cx"))).toBeGreaterThan(x0);
  const x1 = Number(point().getAttribute("cx"));
  rerender(<ResetRiskQuotaHeatmap {...props} currentRemainingPercent={80} daysLeftInCycle={2} />);
  expect(Number(point().getAttribute("cx"))).toBeGreaterThan(x1);
  expect(Number(point().getAttribute("cy"))).toBe(109);
  rerender(<ResetRiskQuotaHeatmap {...props} currentRemainingPercent={80} daysLeftInCycle={0.1} />);
  expect(Number(point().getAttribute("cx"))).toBeLessThanOrEqual(450);
  expect(screen.getByText("800%")).toBeInTheDocument();
});

it("uses the same plan at each risk and urgency, including zero balance", () => {
  for (const remainingPercent of [0, 20, 80]) for (const daysUntilReset of [0.1, 1, 2.5, 7]) for (const tomorrowRiskPercent of [0, 25, 50, 100]) {
    const input = { remainingPercent, daysUntilReset, tomorrowRiskPercent, fatigueKneePercent: 30, isWeekend: false, todayUsedPercent: 5, todayFractionRemaining: 0.6 };
    expect(quotaUrgencyHeatmapUsage({ ...input, urgencyPercentPerDay: quotaConsumptionUrgency(remainingPercent, daysUntilReset)! })).toBe(planRemainingQuota(input).suggestedUsagePercent);
  }
  expect(quotaUrgencyHeatmapUsage({ remainingPercent: 80, urgencyPercentPerDay: 0, tomorrowRiskPercent: 0, fatigueKneePercent: 30, isWeekend: false })).toBe(0);
});

it("does not plot a fabricated current point without a reset timestamp", () => {
  render(<ResetRiskQuotaHeatmap language="en" comfortCurve={personalizeComfortCurve([])} currentRemainingPercent={80} currentRiskPercent={10} daysLeftInCycle={null} isWeekend={false} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("Quota data unavailable")).toBeInTheDocument();
});

it.each(["en", "zh-CN"] as const)("keeps only meaningful heatmap labels in %s", language => {
  const { container } = render(<ResetRiskQuotaHeatmap language={language} comfortCurve={personalizeComfortCurve([])} currentRemainingPercent={80} currentRiskPercent={10} daysLeftInCycle={4} isWeekend={false} />);
  expect(container.textContent).not.toMatch(/K=|个人阈值|反馈样本|拟合信心|越多|疲劳约束|personal knee|fit confidence|feedback fit|Balance held fixed/);
  expect(screen.getByText(language === "en" ? "Default basis k 25.0% · no usable feedback" : "默认基准 k 25.0% · 无有效反馈")).toBeInTheDocument();
  expect(container.querySelectorAll("svg rect")).toHaveLength(1121);
});
