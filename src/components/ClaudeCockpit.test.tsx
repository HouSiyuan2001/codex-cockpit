// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import { buildClaudeCockpitView } from "../lib/claudeCockpit";
import type { ClaudeUsageReport, CockpitMode, ComfortCode, ProviderSnapshot } from "../types";
import { aiCapsuleLogicalWidth, capsuleLogicalWidth, QuotaCard, QuotaOrb } from "./QuotaCard";

afterEach(cleanup);

const codex: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: "2026-07-19T00:00:00Z", windowSeconds: 604_800 },
  resetCredits: 1,
  updatedAt: "2026-07-16T00:00:00Z",
  status: "ok",
  message: null,
};

const now = new Date("2026-11-10T12:00:00Z");
const usage: ClaudeUsageReport = {
  status: "ok",
  observedAt: now.toISOString(),
  latestActivityAt: null,
  priceCheckedAt: "2026-11-09",
  days: [
    { localDate: "2026-11-09", requests: 3, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: 8, unpricedRequests: 0, models: [] },
    { localDate: "2026-11-10", requests: 3, inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 1, costUsd: 5, unpricedRequests: 0, models: [
      { id: "claude-opus-5-5", name: "Opus 5.5", requests: 3, inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 5 },
    ] },
  ],
  prices: [{ id: "claude-opus-5-5", name: "Opus 5.5", price: { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 } }],
};

interface ModeHandlers {
  onCockpitModeChange?: (mode: CockpitMode) => void;
  onClaudeCapChange?: (value: number | null) => void;
  onClaudeComfortSelect?: (comfort: ComfortCode) => void;
}

function renderCard(cockpitMode: CockpitMode, handlers: ModeHandlers = {}) {
  const preferences = { ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, cockpitMode, claudeDailyCapUsd: 10 };
  const claudeView = buildClaudeCockpitView(usage, preferences, now);
  return render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={preferences}
    claudeView={claudeView} {...handlers}
    onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
}

it("switches between the Codex, Claude and AI cockpits from one control", () => {
  const onCockpitModeChange = vi.fn();
  renderCard("codex", { onCockpitModeChange });
  expect(screen.getByText("Codex 驾驶舱")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Codex 驾驶舱" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("radio", { name: "Claude 驾驶舱" }));
  fireEvent.click(screen.getByRole("radio", { name: "AI 驾驶舱" }));
  fireEvent.click(screen.getByRole("radio", { name: "Codex 驾驶舱" }));
  expect(onCockpitModeChange.mock.calls).toEqual([["claude"], ["ai"]]);
});

it("shows Claude usage against the personal cap without reset risk", () => {
  const onClaudeCapChange = vi.fn();
  const onClaudeComfortSelect = vi.fn();
  const { container } = renderCard("claude", { onClaudeCapChange, onClaudeComfortSelect });
  expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--claude");
  expect(screen.getByText("Claude 驾驶舱")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "今日已用 50%" })).toHaveClass("codex-ring-card--claude");
  expect(screen.queryByText(/重置风险/)).not.toBeInTheDocument();
  expect(screen.getByText("Opus 5.5")).toBeInTheDocument();
  expect(screen.getByText("$4 / $20")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("slider", { name: "个人上限" }), { target: { value: "12.5" } });
  expect(onClaudeCapChange).toHaveBeenCalledWith(12.5);
  fireEvent.click(screen.getByRole("button", { name: "恢复舒适估计" }));
  expect(onClaudeCapChange).toHaveBeenLastCalledWith(null);
  expect(screen.getByText("今日已用 $8.00")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刚刚好" }));
  expect(onClaudeComfortSelect).toHaveBeenCalledWith("comfortable");
});

it("puts Codex and Claude daily use side by side in the AI cockpit", () => {
  const { container } = renderCard("ai");
  expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--ai");
  expect(screen.getByText("AI 驾驶舱")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: /^Codex/ })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Claude 50%" })).toHaveClass("codex-ring-card--claude");
  expect(screen.getByText("本周剩余")).toBeInTheDocument();
});

it("renders Claude and AI capsules with matching widths", () => {
  const { container, rerender } = render(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="claude" claudeRatio={50} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelector(".quota-orb")).toHaveClass("cockpit-mode--claude");
  expect(container.querySelector(".capsule-quota-readout--claude")).toBeInTheDocument();
  expect(container.querySelector(".quota-orb")).toHaveStyle({ "--capsule-logical-width": `${capsuleLogicalWidth(50)}px` });
  rerender(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="ai" claudeRatio={50} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelectorAll(".capsule-quota-readout")).toHaveLength(2);
  expect(container.querySelector(".quota-orb")?.getAttribute("aria-label")).toMatch(/Claude 今日\/个人上限 50%/);
  expect(aiCapsuleLogicalWidth(5, 50)).toBeGreaterThan(capsuleLogicalWidth(50));
});
