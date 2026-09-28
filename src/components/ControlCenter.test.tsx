// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import type { WidgetPreferences } from "../types";
import { ControlCenter } from "./ControlCenter";
import { buildMidnightQuotaPlan } from "../lib/midnightQuotaPlan";
import { COMFORT_CURVE_VERSION } from "../lib/comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";

it("edits and resets a person's ring color through preferences", () => {
  const onPreferences = vi.fn();
  render(<ControlCenter preferences={{ ...DEFAULT_WIDGET_PREFERENCES, personRingColors: { alex: "#123456" } }} language="zh-CN" onClose={() => {}} onRefresh={() => {}} onPreferences={onPreferences} autostartEnabled={false} onAutostart={() => {}} comfortUsage={{ fetchedAt: new Date().toISOString(), status: "ready", warnings: [], projectBreakdownAvailable: false, defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: [] }], devices: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  const input = screen.getByLabelText("成员甲 圆环颜色");
  expect(input).toHaveValue("#123456");
  fireEvent.change(input, { target: { value: "#abcdef" } });
  expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ personRingColors: { alex: "#abcdef" } }));
  fireEvent.click(screen.getByLabelText("成员甲 恢复默认颜色"));
  expect(onPreferences).toHaveBeenLastCalledWith(expect.objectContaining({ personRingColors: {} }));
});

it("edits members and device ownership from the settings page", async () => {
  const usage = { fetchedAt: new Date().toISOString(), status: "ready" as const, warnings: [], projectBreakdownAvailable: false, defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: ["Mac mini"] }], devices: [{ id: "Mac mini", updatedAt: new Date().toISOString(), stale: false, daily: {}, ranges: {} }] };
  render(<ControlCenter preferences={DEFAULT_WIDGET_PREFERENCES} language="zh-CN" onClose={() => {}} onRefresh={() => {}} onPreferences={() => {}} autostartEnabled={false} onAutostart={() => {}} comfortUsage={usage} />);
  fireEvent.click(screen.getByRole("button", { name: "设置" }));
  expect(screen.getByRole("region", { name: "组员与设备" })).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "设备归属: Mac mini" })).toHaveValue("alex");
  fireEvent.change(screen.getByRole("textbox", { name: "组员名称 1" }), { target: { value: "成员甲的新名称" } });
  fireEvent.click(screen.getByRole("button", { name: "保存组员" }));
  expect((await screen.findAllByText("成员甲的新名称")).length).toBeGreaterThan(0);
});

it("keeps the heatmap basis, marker, and curve on the selected person's fitted k", () => {
  const now = new Date("2026-09-22T00:00:00Z");
  const localDate = now.toISOString().slice(0, 10);
  const record = (personId: string, used: number): ComfortFeedbackRecord => ({
    personId, localDate, observedAt: now.toISOString(), comfort: "comfortable",
    observedUsedPercent: used, usageObservedAt: now.toISOString(), usageCoverage: "complete",
    usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION,
    quotaAllocation: { metricVersion: "cost-share-v1", localDate, observedAt: now.toISOString(),
      totalUsedPercent: used, personCostUsd: 1, totalCostUsd: 1, costShare: 1,
      allocatedUsedPercent: used, coverage: "complete", deviceIds: ["test"], missingDeviceIds: [] },
  });
  const records = [record("person-a", 20), record("person-b", 70)];
  const recommendation = buildMidnightQuotaPlan({
    snapshot: { provider: "codex", displayName: "Codex", plan: "Pro", status: "ok", updatedAt: now.toISOString(), message: null, shortWindow: null, resetCredits: null, weeklyWindow: { windowSeconds: 604800, remainingPercent: 100, resetsAt: new Date(now.getTime() + 86400000).toISOString() } },
    history: [], riskPercent: 50, forecast: null, fatigueKneePercent: 25, now,
  })!;
  recommendation.policyVersion = "shared-account-plan-v1";
  const comfortUsage = { fetchedAt: now.toISOString(), status: "ready" as const, warnings: [], projectBreakdownAvailable: false, defaultGroupId: "person-a",
    groups: [{ id: "person-a", name: "Alice", deviceIds: [] }, { id: "person-b", name: "Bob", deviceIds: [] }, { id: "person-empty", name: "Charlie", deviceIds: [] }], devices: [] };
  const props = { preferences: DEFAULT_WIDGET_PREFERENCES, language: "en" as const,
    onClose: vi.fn(), onRefresh: vi.fn(), onPreferences: vi.fn(), autostartEnabled: false,
    onAutostart: vi.fn(), comfortUsage, comfortFeedback: records, dailyRecommendation: recommendation, weeklyRemainingPercent: 100 };
  const view = render(<ControlCenter {...props} comfortPersonId="person-a" />);
  const legend = () => view.container.querySelector(".reset-risk-heatmap-legend")!.textContent;
  const badge = () => view.container.querySelector(".person-comfort-section header > span")!.textContent!.split(" = ")[1];
  const basis = () => view.container.querySelector(".reset-risk-heatmap > header > span")!.textContent;
  const label = () => view.container.querySelector(".reset-risk-heatmap-current-label")!.textContent;
  expect(legend()).toBe("0.0%" + badge());
  expect(basis()).toContain("Alice · Heatmap basis k " + badge());
  expect(basis()).toContain("low confidence");
  const first = legend(), originalLabel = label();
  view.rerender(<ControlCenter {...props} comfortPersonId="person-b" />);
  expect(legend()).toBe("0.0%" + badge());
  expect(basis()).toContain("Bob · Heatmap basis k " + badge());
  expect(legend()).not.toBe(first);
  expect(label()).not.toBe(originalLabel);
  const secondLabel = label();
  view.rerender(<ControlCenter {...props} comfortFeedback={[record("person-a", 20), record("person-b", 5)]} comfortPersonId="person-b" />);
  expect(legend()).toBe("0.0%" + badge());
  expect(basis()).toContain("Bob · Heatmap basis k " + badge());
  expect(label()).not.toBe(secondLabel);
  view.rerender(<ControlCenter {...props} comfortPersonId="person-empty" />);
  expect(legend()).toBe("0.0%25.0%");
  expect(badge()).toBe("25.0%");
  expect(basis()).toBe("Charlie · Default basis k 25.0% · no usable feedback");
});

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

function renderControlCenter(onRefresh = vi.fn(), onPreferences = vi.fn(), onSliderInteraction = vi.fn(), preferences: WidgetPreferences = { ...DEFAULT_WIDGET_PREFERENCES, language: "en" }, onOpenCodexResets = vi.fn(), onDrag = vi.fn()) {
  render(
    <ControlCenter
      preferences={preferences}
      language={preferences.language}
      onClose={vi.fn()}
      onRefresh={onRefresh}
      onOpenCodexResets={onOpenCodexResets}
      onDrag={onDrag}
      onPreferences={onPreferences}
      onSliderInteraction={onSliderInteraction}
      autostartEnabled
      onAutostart={vi.fn()}
    />,
  );
  return { onPreferences, onSliderInteraction };
}

describe("ControlCenter essentials", () => {
  it("shows the frozen day total even when live balance and observed usage change", () => {
    const at = "2026-09-11T05:00:00Z";
    const resetsAt = "2026-09-16T12:23:20Z";
    const recommendation = buildMidnightQuotaPlan({
      snapshot: { provider: "codex", displayName: "Codex", plan: "Pro", status: "ok", updatedAt: at, message: null, shortWindow: null, resetCredits: null, weeklyWindow: { windowSeconds: 604800, remainingPercent: 23, resetsAt } },
      history: [{ provider: "codex", capturedAt: "2026-09-10T16:00:00Z", metric: 43, metricKind: "percent", status: "ok", resetsAt }],
      riskPercent: 86, forecast: null, fatigueKneePercent: 25, now: new Date(at),
    })!;
    const props = { preferences: DEFAULT_WIDGET_PREFERENCES, language: "zh-CN" as const, onClose: vi.fn(), onRefresh: vi.fn(), onPreferences: vi.fn(), autostartEnabled: true, onAutostart: vi.fn() };
    const view = render(<ControlCenter {...props} dailyRecommendation={recommendation} weeklyRemainingPercent={23} />);
    const label = `拟合建议 ${recommendation.targetPercent.toFixed(1)}%`;
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("未归属旧记录 · 默认基准 k 25.0% · 无有效反馈")).toBeInTheDocument();
    view.rerender(<ControlCenter {...props} dailyRecommendation={{ ...recommendation, todayUsedPercent: 30 }} weeklyRemainingPercent={13} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
  it("keeps daily information separate from the settings page", () => {
    renderControlCenter();

    expect(screen.getByText("Codex Cockpit")).toBeInTheDocument();
    expect(screen.queryByText("Dual-ring dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText(/LOCAL FIRST/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Comfort curve" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Experience history" })).toBeInTheDocument();
    expect(screen.queryByText("Only the settings you use every day")).not.toBeInTheDocument();
    expect(screen.queryByText("Text size")).not.toBeInTheDocument();
    expect(screen.queryByText("Theme")).not.toBeInTheDocument();
    expect(screen.queryByText("Behavior")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Text size")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Theme")).toBeInTheDocument();
    expect(screen.getByText("Behavior")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Health" })).not.toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
    expect(screen.queryByText("Backup and migration")).not.toBeInTheDocument();
  });

  it("requests an immediate refresh from the compact status row", () => {
    const onRefresh = vi.fn();
    renderControlCenter(onRefresh);
    fireEvent.click(screen.getByRole("button", { name: "Refresh quota" }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("starts native window dragging from the control center header", () => {
    installPointerEvent();
    const onDrag = vi.fn();
    renderControlCenter(vi.fn(), vi.fn(), vi.fn(), { ...DEFAULT_WIDGET_PREFERENCES, language: "en" }, vi.fn(), onDrag);
    const header = screen.getByRole("heading", { name: "Control center" }).closest("header");
    expect(header).not.toBeNull();

    fireEvent.pointerDown(header!, { button: 0 });

    expect(onDrag).toHaveBeenCalledTimes(1);
  });

  it("does not start dragging when the header close button is pressed", () => {
    const onDrag = vi.fn();
    renderControlCenter(vi.fn(), vi.fn(), vi.fn(), { ...DEFAULT_WIDGET_PREFERENCES, language: "en" }, vi.fn(), onDrag);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Close" }), { button: 0 });

    expect(onDrag).not.toHaveBeenCalled();
  });

  it("does not drag the window from the control center content", () => {
    installPointerEvent();
    const onDrag = vi.fn();
    renderControlCenter(vi.fn(), vi.fn(), vi.fn(), { ...DEFAULT_WIDGET_PREFERENCES, language: "en" }, vi.fn(), onDrag);

    fireEvent.pointerDown(screen.getByRole("dialog"), { button: 0 });
    fireEvent.pointerDown(screen.getByText("Codex Cockpit"), { button: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    fireEvent.pointerDown(screen.getByRole("status"), { button: 0 });

    expect(onDrag).not.toHaveBeenCalled();
  });

  it("opens the Codex Resets history from the status row", () => {
    const onOpenCodexResets = vi.fn();
    renderControlCenter(vi.fn(), vi.fn(), vi.fn(), { ...DEFAULT_WIDGET_PREFERENCES, language: "en" }, onOpenCodexResets);
    fireEvent.click(screen.getByRole("button", { name: "Open Codex Resets" }));

    expect(onOpenCodexResets).toHaveBeenCalledTimes(1);
  });

  it.each(["en", "zh-CN"] as const)("omits the risk website while preserving actions in %s", (language) => {
    const onRefresh = vi.fn();
    const onOpenCodexResets = vi.fn();
    renderControlCenter(onRefresh, vi.fn(), vi.fn(), { ...DEFAULT_WIDGET_PREFERENCES, language }, onOpenCodexResets);
    expect(screen.queryByRole("button", { name: /Risk website|风险网站/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^(Open|打开) Codex Resets$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(Refresh quota|刷新额度)$/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onOpenCodexResets).toHaveBeenCalledTimes(1);
  });

  it("applies the essential appearance and behavior preferences", () => {
    const onPreferences = vi.fn();
    const preferences: WidgetPreferences = { ...DEFAULT_WIDGET_PREFERENCES, language: "en", stayExpanded: false };
    renderControlCenter(vi.fn(), onPreferences, vi.fn(), preferences);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    fireEvent.click(screen.getByRole("radio", { name: /^System$/i }));
    expect(onPreferences).toHaveBeenCalledWith(expect.objectContaining({ appearanceMode: "system" }));

    fireEvent.click(screen.getByRole("radio", { name: /^Dark$/i }));
    expect(onPreferences).toHaveBeenCalledWith(expect.objectContaining({ appearanceMode: "dark" }));

    fireEvent.click(screen.getByRole("radio", { name: "中文" }));
    expect(onPreferences).toHaveBeenCalledWith(expect.objectContaining({ language: "zh-CN" }));

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep expanded" }));
    expect(onPreferences).toHaveBeenCalledWith(expect.objectContaining({ stayExpanded: true }));

    fireEvent.change(screen.getByRole("slider", { name: "Text size" }), { target: { value: "1.3" } });
    expect(onPreferences).toHaveBeenCalledWith(expect.objectContaining({ fontScale: 1.3 }));
  });

  it("keeps the text scale range between 100% and 200%", () => {
    renderControlCenter();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const slider = screen.getByRole("slider", { name: "Text size" });
    expect(slider).toHaveAttribute("min", "1");
    expect(slider).toHaveAttribute("max", "2");
  });

  it("reports font-size slider drag boundaries", () => {
    installPointerEvent();
    const onSliderInteraction = vi.fn();
    renderControlCenter(vi.fn(), vi.fn(), onSliderInteraction);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const slider = screen.getByRole("slider", { name: "Text size" });
    Object.assign(slider, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: () => true });

    fireEvent.pointerDown(slider, { button: 0, pointerId: 4 });
    fireEvent.pointerUp(slider, { pointerId: 4 });

    expect(onSliderInteraction).toHaveBeenNthCalledWith(1, true);
    expect(onSliderInteraction).toHaveBeenLastCalledWith(false);
  });
});
