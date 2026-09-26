// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateUsageTrend, buildTrendBuckets, DailyUsageTrend } from "./DailyUsageTrend";
import type { DailyModelUsage, TokeiDevice } from "../lib/tokeiUsage";

const model = (tokens: number, cost: number | null) => ({ id: "m", name: "Model", inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: tokens, estimatedCostUsd: cost });
const day = (tokens: number, cost: number | null, modelCost = cost): DailyModelUsage => ({ ...model(tokens, cost), models: [model(tokens, modelCost)] });
const device = (id: string, daily: TokeiDevice["daily"], updatedAt = "2026-09-15T12:00:00Z", overrides: Partial<TokeiDevice> = {}): TokeiDevice => ({ id, daily, updatedAt, stale: false, ranges: {}, ...overrides });
const now = new Date("2026-09-15T12:00:00+08:00");

afterEach(cleanup);

function installPointerEvent(): void {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
}

describe("historical usage aggregation", () => {
  it("builds seven days, seven calendar weeks and six calendar months around an anchor", () => {
    expect(buildTrendBuckets("day", "2026-08-08", now)).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: "2026-08-02", end: "2026-08-02" }),
      expect.objectContaining({ start: "2026-08-08", end: "2026-08-08" }),
    ]));
    const weeks = buildTrendBuckets("week", "2026-08-08", now);
    expect(weeks).toHaveLength(7);
    expect(weeks[0]).toMatchObject({ start: "2026-06-22", end: "2026-06-28" });
    expect(weeks.at(-1)).toMatchObject({ start: "2026-08-03", end: "2026-08-09" });
    const months = buildTrendBuckets("month", "2026-08-08", now);
    expect(months).toHaveLength(6);
    expect(months[0]).toMatchObject({ key: "2026-03", start: "2026-03-01", end: "2026-03-31" });
    expect(months.at(-1)).toMatchObject({ key: "2026-08", start: "2026-08-01", end: "2026-08-31" });
  });

  it("deduplicates devices and does not turn missing or partial records into zero", () => {
    const devices = [
      device("mac", { "2026-09-09": day(10, 1), "2026-09-15": day(30, 3) }),
      device("pc", { "2026-09-15": day(20, 2) }, undefined, { collectionPartial: true }),
      device("mac", { "2026-09-15": day(999, 99) }, "2026-09-14T12:00:00Z"),
    ];
    const seven = aggregateUsageTrend(devices, "day", "tokens", now);
    expect(seven).toHaveLength(7);
    expect(seven[0]).toEqual(expect.objectContaining({ key: "2026-09-09", value: 10, partial: true }));
    expect(seven[1].value).toBeNull();
    expect(seven.at(-1)).toEqual(expect.objectContaining({ key: "2026-09-15", value: 50, partial: true }));
  });

  it("uses known model costs only as an explicitly partial estimate", () => {
    const points = aggregateUsageTrend([device("mac", { "2026-09-15": day(30, null, 1.25) })], "day", "cost", now);
    expect(points.at(-1)).toEqual(expect.objectContaining({ value: 1.25, partial: true }));
    expect(aggregateUsageTrend([device("mac", { "2026-09-15": day(30, null, null) })], "day", "cost", now).at(-1)?.value).toBeNull();
    const incomplete = day(30, 2.5);
    incomplete.models[0].costIncomplete = true;
    expect(aggregateUsageTrend([device("mac", { "2026-09-14": incomplete })], "day", "cost", now).at(-2)).toEqual(expect.objectContaining({ value: 2.5, partial: true }));
  });
});

describe("DailyUsageTrend history navigation", () => {
  const history = device("mac", {
    "2026-09-15": day(30, 3),
    "2026-09-09": day(10, 1),
    "2026-09-08": day(80, 8),
    "2026-09-02": day(20, 2),
    "2026-08-03": day(40, 4),
    "2026-04-12": day(60, 6),
  });

  it("slides by one day and updates range, peak, date and tooltip", () => {
    render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} />);
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
    expect(screen.getByText("峰 30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("9/8–9/14")).toBeInTheDocument();
    expect(screen.getByText("峰 80")).toBeInTheDocument();
    const point = screen.getByLabelText("2026-09-08 · 80");
    expect(point.nextElementSibling).toHaveAttribute("pointer-events", "none");
    fireEvent.mouseEnter(point);
    expect(document.querySelector(".daily-trend-tooltip-value")).toHaveTextContent("80");
    fireEvent.mouseLeave(screen.getByRole("img", { name: "每日 Token曲线图" }));
    fireEvent.focus(point);
    expect(document.querySelector(".daily-trend-tooltip-value")).toHaveTextContent("80");
    expect(screen.getByRole("button", { name: "往后" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往后" })).toBeDisabled();
  });

  it("keeps the historical window when the metric changes", () => {
    const view = render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} resetKey="person-a" />);
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    view.rerender(<DailyUsageTrend devices={[history]} metric="cost" zh now={now} resetKey="person-a" />);
    expect(screen.getByText("9/8–9/14")).toBeInTheDocument();
    expect(screen.getByText("峰 $8.00")).toBeInTheDocument();
  });

  it("keeps a selected historical calendar anchor when the scope changes", () => {
    const view = render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} anchorDate="2026-08-08" resetKey="person-a" />);
    expect(screen.getByText("8/2–8/8")).toBeInTheDocument();
    view.rerender(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} anchorDate="2026-08-08" resetKey="person-b" />);
    expect(screen.getByText("8/2–8/8")).toBeInTheDocument();
  });

  it("returns an unanchored historical window to latest when the scope changes", () => {
    const view = render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} resetKey="person-a" />);
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("9/8–9/14")).toBeInTheDocument();
    view.rerender(<DailyUsageTrend devices={[history]} metric="cost" zh now={now} resetKey="person-b" />);
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
  });

  it("follows a selected calendar date and preserves the anchor across granularities", () => {
    const view = render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} anchorDate="2026-08-08" />);
    expect(screen.getByText("8/2–8/8")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("6/22–8/9")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(screen.getByText("3/1–8/31")).toBeInTheDocument();
    view.rerender(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} anchorDate="2026-04-12" />);
    expect(screen.getByText("2025/11/1–2026/4/30")).toBeInTheDocument();
    view.rerender(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} />);
    expect(screen.getByText("4/1–9/15")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往后" })).toBeDisabled();
  });

  it("advances only a latest window across local midnight", () => {
    const nextDay = new Date("2026-09-16T12:00:00+08:00");
    const view = render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} />);
    view.rerender(<DailyUsageTrend devices={[history]} metric="tokens" zh now={nextDay} />);
    expect(screen.getByText("9/10–9/16")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
    view.rerender(<DailyUsageTrend devices={[history]} metric="tokens" zh now={new Date("2026-09-17T12:00:00+08:00")} />);
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
  });

  it("supports pointer drag and horizontal wheel paging without manufacturing an empty zero chart", () => {
    installPointerEvent();
    render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} />);
    const viewport = screen.getByLabelText("拖动或横向滚动浏览历史");
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });
    fireEvent.pointerDown(viewport, { button: 0, pointerId: 3, clientX: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 160 });
    expect(screen.getByText("9/8–9/14")).toBeInTheDocument();
    fireEvent.pointerMove(viewport, { pointerId: 3, clientX: 256 });
    fireEvent.pointerUp(viewport, { pointerId: 3, clientX: 256 });
    expect(screen.getByText("9/6–9/12")).toBeInTheDocument();
    fireEvent.wheel(viewport, { deltaX: 144 });
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
  });

  it("bridges missing days without creating a fake point or value", () => {
    render(<DailyUsageTrend devices={[device("mac", {
      "2026-09-13": day(10, 1),
      "2026-09-15": day(20, 2),
    })]} metric="cost" zh now={now} />);
    expect(document.querySelector(".daily-trend-line--missing")?.getAttribute("d")).toMatch(/^M.+ L.+$/);
    expect(screen.queryByLabelText(/2026-09-14 ·/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/2026-09-13 · \$1.00/)).toBeInTheDocument();
    expect(screen.getByLabelText(/2026-09-15 · \$2.00/)).toBeInTheDocument();
  });

  it("slides weeks and months one bucket at a time", () => {
    render(<DailyUsageTrend devices={[history]} metric="tokens" zh now={now} />);
    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("8/3–9/15")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("7/27–9/13")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(screen.getByText("4/1–9/15")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("3/1–8/31")).toBeInTheDocument();
  });

  it("shows a dated empty state when no ledger exists", () => {
    render(<DailyUsageTrend devices={[device("mac", { "2026-09-09": day(10, 1) })]} metric="tokens" zh now={now} />);
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: "往前" }));
    expect(screen.getByText("暂无记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "往前" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "往后" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(screen.getByText("9/9–9/15")).toBeInTheDocument();
  });
});
