// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { COMFORT_CURVE_VERSION, personalizeComfortCurve, smoothKneeEfficiency } from "../lib/comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";
import { ComfortCurvePanel, comfortCurveAxis } from "./ComfortCurvePanel";
afterEach(cleanup);
const now = new Date(2026, 8, 11, 12);
const record = (comfort: ComfortFeedbackRecord["comfort"], date = "2026-09-10"): ComfortFeedbackRecord => ({
  localDate: date, observedAt: now.toISOString(), observedUsedPercent: 25, comfort, usageCoverage: "complete",
  usageObservedAt: null, usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION,
});

describe("ComfortCurvePanel fixed form", () => {
  it("shows a clearly labeled default reference without feedback", () => {
    const { container } = render(<ComfortCurvePanel curve={personalizeComfortCurve([])} language="zh-CN" />);
    expect(screen.getByTitle("默认参考")).toBeTruthy();
    expect(screen.getByText(/默认 k = 25.0%/)).toBeTruthy();
    const points = container.querySelector("polyline")!.getAttribute("points")!.split(" ");
    expect(points).toHaveLength(201);
    expect(points[0]).toBe("88.0,25.0");
    expect(points.at(-1)).toBe("523.0,140.2");
  });
  it.each(["zh-CN", "en"] as const)("preserves one fixed efficiency function in %s", language => {
    const curve = personalizeComfortCurve([record("comfortable")], now);
    const { container } = render(<ComfortCurvePanel curve={curve} language={language} estimated />);
    expect(screen.getByTitle(language === "en" ? "Fit k only" : "仅拟合 k")).toBeTruthy();
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
    expect(container.querySelector(".comfort-center-interval")).toBeNull();
    expect(container.querySelector(".comfort-probability-line")).toBeNull();
    for (const point of curve.points) expect(point.personalizedScore).toBeCloseTo(smoothKneeEfficiency(point.usedPercent, curve.xStarPercent), 4);
  });
  it("shows fixed score scatter independent of k on the same chart", () => {
    const curve = personalizeComfortCurve([record("idle", "2026-09-08"), record("comfortable", "2026-09-09"), record("overloaded")], now);
    const { container, rerender } = render(<ComfortCurvePanel curve={curve} language="zh-CN" />);
    const positions = () => [...container.querySelectorAll(".comfort-curve-observation")].map(dot => [dot.getAttribute("cx"), dot.getAttribute("cy")]);
    const before = positions();
    expect(new Set(before.map(point => point[0])).size).toBe(1);
    expect(before.map(point => Number(point[1]))).toEqual([25, 53.8, 133]);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 548 230");
    expect(container.querySelector(".comfort-raw-title")).toBeNull();
    expect(container.querySelector(".comfort-curve-observation")?.textContent).toContain("约定评分 100%");
    rerender(<ComfortCurvePanel curve={{ ...curve, xStarPercent: 80 }} language="zh-CN" />);
    expect(positions().map(point => point[0])).toEqual(before.map(point => point[0]));
    expect(positions()).toEqual(before);
  });
  it("extends the axis and retains actual positions above 100 percent", () => {
    const curve = personalizeComfortCurve([{ ...record("overloaded"), observedUsedPercent: 175 }], now);
    const { container } = render(<ComfortCurvePanel curve={curve} language="zh-CN" />);
    expect(comfortCurveAxis([]).maxPercent).toBe(125);
    expect(comfortCurveAxis([175]).maxPercent).toBe(200);
    expect(screen.getByText("200%")).toBeTruthy();
    expect(Number(container.querySelector(".comfort-curve-observation")?.getAttribute("cx"))).toBeCloseTo(88 + 435 * 175 / 200);
    expect(comfortCurveAxis([10000]).maxPercent).toBeGreaterThan(10000);
  });
});
