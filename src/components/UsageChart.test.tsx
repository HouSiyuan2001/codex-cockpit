// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aggregateGroupUsage, createUsagePreview } from "../lib/tokeiUsage";
import { UsageChart, usageColor, usageRankColor } from "./UsageChart";

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("usage charts", () => {
  it("samples the entire warm-to-cool palette evenly for the current task count", () => {
    expect(usageRankColor(0, 5)).toBe("#e76254");
    expect(usageRankColor(2, 5)).toBe("#d5e1cc");
    expect(usageRankColor(4, 5)).toBe("#1e466e");
    expect(usageRankColor(0, 1)).toBe("#e76254");
    expect(usageRankColor(1, 2)).toBe("#1e466e");
    expect(usageRankColor(11, 12)).toBe("#1e466e");
    expect(new Set(Array.from({ length: 12 }, (_, rank) => usageRankColor(rank, 12))).size).toBe(12);
  });
  it("keeps unknown task cost distinct from zero in a month donut", () => {
    render(<UsageChart rows={[]} total={null} knownTotal={0} devices={[]} period="month" ids={[]} zh metric="cost" tasks onToggle={() => {}} />);
    expect(screen.getByRole("img", { name: "任务用量占比" })).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("任务用量 · 已知成本")).toBeInTheDocument();
  });
  function fixture() {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-10T12:00:00"));
    const data = createUsagePreview();
    return aggregateGroupUsage(data, data.defaultGroupId, "today");
  }
  it("uses identical colors for chart and legend and preserves unattributed space", () => {
    const summary = fixture();
    const ids = summary.models.map(model => model.id).sort();
    const { container } = render(<UsageChart rows={summary.models} total={4000000} devices={summary.devices} period="today" ids={ids} zh />);
    expect(screen.getByRole("img", { name: "模型用量占比" })).toBeInTheDocument();
    expect(screen.getByText("400万")).toBeInTheDocument();
    const marks = container.querySelectorAll("circle[stroke-dasharray]");
    expect(marks[0]).toHaveAttribute("stroke", usageColor(summary.models[0].id, ids));
    expect(marks[0]).toHaveAttribute("stroke-dasharray", "40 60");
  });
  it("keeps seven day positions and marks absent records as unknown", () => {
    const summary = fixture();
    const { container } = render(<UsageChart rows={summary.models} total={summary.totalTokens} devices={summary.devices} period="7d" ids={[]} zh />);
    expect(container.querySelectorAll(".usage-column")).toHaveLength(7);
    expect(container.querySelectorAll(".usage-chart-gap")).toHaveLength(6);
    expect(screen.getByTitle("2026-09-04 · 暂无数据")).toBeInTheDocument();
  });
  it("does not invent a chart for empty usage", () => {
    const { container } = render(<UsageChart rows={[]} total={0} devices={[]} period="today" ids={[]} zh />);
    expect(container).toBeEmptyDOMElement();
  });
  it("uses money for segments and marks unknown daily costs as gaps", () => {
    const summary = fixture();
    const { container, rerender } = render(<UsageChart rows={summary.models} total={2.7} devices={summary.devices} period="today" ids={[]} zh metric="cost" />);
    expect(screen.getByText("$2.70")).toBeInTheDocument();
    expect(Number(container.querySelector("circle[stroke-dasharray]")?.getAttribute("stroke-dasharray")?.split(" ")[0])).toBeCloseTo(88.8889);
    Object.values(summary.devices[0].daily)[0].estimatedCostUsd = null;
    rerender(<UsageChart rows={summary.models} total={null} devices={summary.devices} period="7d" ids={[]} zh metric="cost" />);
    expect(container.querySelectorAll(".usage-chart-gap")).toHaveLength(7);
    expect(screen.queryByTitle("2026-09-10 · $0.00")).not.toBeInTheDocument();
  });
});
