// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { COMFORT_CURVE_VERSION } from "../lib/comfortFeedback";
import { buildTokenComfortSnapshot } from "../lib/tokenComfort";
import { buildPersonQuotaAllocation } from "../lib/personQuotaAllocation";
import type { ComfortFeedbackRecord } from "../types";
import type { TokeiUsage } from "../lib/tokeiUsage";
import { PersonComfortSection } from "./PersonComfortSection";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 14, 12)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

function data(): TokeiUsage {
  const day = (tokens: number, cost: number) => ({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: tokens, estimatedCostUsd: cost, models: [] });
  return { fetchedAt: new Date().toISOString(), status: "ready", defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: ["mac"] }, { id: "blair", name: "成员乙", deviceIds: ["pc"] }], warnings: [], projectBreakdownAvailable: true, devices: [
    { id: "mac", updatedAt: new Date().toISOString(), stale: false, daily: { "2026-08-12": day(2e6, 30) }, ranges: {} },
    { id: "pc", updatedAt: new Date().toISOString(), stale: false, daily: { "2026-08-12": day(8e6, 70) }, ranges: {} },
  ] };
}
function record(personId: string | null, comfort: ComfortFeedbackRecord["comfort"]): ComfortFeedbackRecord {
  const entry: ComfortFeedbackRecord = { localDate: "2026-08-12", observedAt: new Date().toISOString(), personId, comfort, observedUsedPercent: personId ? 12 : 33, usageObservedAt: new Date().toISOString(), usageCoverage: "partial", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION, tokenSnapshot: personId ? buildTokenComfortSnapshot(data(), personId, "2026-08-12") : null };
  return { ...entry, quotaAllocation: personId ? buildPersonQuotaAllocation(data(), personId, entry.localDate, entry) : null };
}

it("switches people without showing the other person's feedback or assigning legacy records", () => {
  const records = [record("alex", "comfortable"), record("blair", "overloaded"), record(null, "idle")];
  function Harness() {
    const [personId, setPersonId] = useState<string | null>("alex");
    return <PersonComfortSection data={data()} personId={personId} records={records} language="zh-CN" onPersonChange={setPersonId} onChange={vi.fn()} onRefreshSnapshot={vi.fn()} />;
  }
  const { container } = render(<Harness />);
  expect(screen.getByLabelText("谁的体验").closest("header")).toHaveTextContent("舒适曲线");
  expect(screen.getByRole("gridcell", { name: /8月12日.*刚刚好.*≈3.6%/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("谁的体验"), { target: { value: "blair" } });
  expect(screen.getByRole("gridcell", { name: /8月12日.*有点撑.*≈8.4%/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("谁的体验"), { target: { value: "" } });
  expect(screen.getByRole("gridcell", { name: /8月12日.*很轻松/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  expect(screen.getByRole("radio", { name: "刚刚好" })).toBeDisabled();
  expect(records[2].personId).toBeNull();
});

it("shows the saved snapshot instead of silently replacing it with a newer daily total", () => {
  const stored = record("alex", "comfortable");
  const newer = data();
  newer.devices[0].daily["2026-08-12"].totalTokens = 10e6;
  newer.devices[0].daily["2026-08-12"].inputTokens = 10e6;
  newer.devices[0].daily["2026-08-12"].estimatedCostUsd = 300;
  const refresh = vi.fn();
  render(<PersonComfortSection data={newer} personId="alex" records={[stored]} language="zh-CN" onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={refresh} />);
  fireEvent.click(screen.getByRole("gridcell", { name: /8月12日.*≈3.6%/ }));
  expect(screen.queryByText("分摊明细")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新分摊" })).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "刚刚好" })).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
});

it("shows fixed-form efficiency with directly labeled percentage axes", () => {
  const { container } = render(<PersonComfortSection data={data()} personId="alex" records={[record("alex", "comfortable")]} language="zh-CN" onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={vi.fn()} />);
  expect(screen.getByText("个人估算用量（%）").closest("svg")).not.toBeNull();
  expect(screen.getByText("相对效率（评分）").closest("svg")).not.toBeNull();
  expect(container.querySelector(".token-comfort-trend")).toBeNull();
  expect(container.querySelector(".comfort-curve-line--personalized")).not.toBeNull();
  expect(screen.queryByText("每日 Token（M）")).toBeNull();
});
