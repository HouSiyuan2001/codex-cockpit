// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import { buildClaudeCockpitView } from "../lib/claudeCockpit";
import { buildClaudePlan, claudeResetWatch, EMPTY_CLAUDE_PLAN, observeClaudeQuota } from "../lib/claudePlan";
import type { ClaudeQuota, CockpitMode, ProviderSnapshot } from "../types";
import { aiCapsuleLogicalWidth, capsuleLogicalWidth, QuotaCard, QuotaOrb } from "./QuotaCard";

afterEach(cleanup);

const codex: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: "2026-11-16T14:00:00Z", windowSeconds: 604_800 },
  resetCredits: 1,
  updatedAt: "2026-11-10T12:00:00Z",
  status: "ok",
  message: null,
};

const now = new Date("2026-11-10T12:00:00Z");
const quota: ClaudeQuota = {
  status: "ok",
  fiveHour: { usedPercent: 38, resetsAt: "2026-11-10T14:30:00Z" },
  sevenDay: { usedPercent: 57, resetsAt: "2026-11-13T08:00:00Z" },
  sevenDayOpus: null,
  sevenDaySonnet: null,
  plan: "max",
  observedAt: now.toISOString(),
  message: null,
};

interface ModeHandlers {
  onCockpitModeChange?: (mode: CockpitMode) => void;
  onOpenResetForecast?: (url: string) => void;
  onClaudeCapChange?: (value: number | null) => void;
  onClaudeRiskChange?: (value: number | null) => void;
  onResetRiskChange?: (value: number | null) => void;
}

const forecast = {
  checkedAt: now.toISOString(),
  notice: {
    observedAt: "2026-11-09T18:00:00Z", expiresAt: "2026-11-11T18:00:00Z",
    announcementUrl: "https://x.com/ClaudeDevs/status/2120275296637321476",
  },
};

function renderCard(cockpitMode: CockpitMode, handlers: ModeHandlers = {}, claudeQuota: ClaudeQuota = quota) {
  const preferences = { ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, cockpitMode, claudeEnabled: true };
  const claudeView = buildClaudeCockpitView(claudeQuota, now);
  const claudePlan = buildClaudePlan(observeClaudeQuota(EMPTY_CLAUDE_PLAN, claudeQuota, now), claudeQuota, 25, now);
  return render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={preferences}
    now={now} claudeView={claudeView} claudePlan={claudePlan} claudeWatch={claudeResetWatch(forecast, now)} {...handlers}
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

it("shows the shared daily controls next to Claude quota and opens the original announcement", () => {
  const onOpenResetForecast = vi.fn(), onClaudeCapChange = vi.fn(), onClaudeRiskChange = vi.fn(), onResetRiskChange = vi.fn();
  const { container } = renderCard("claude", { onOpenResetForecast, onClaudeCapChange, onClaudeRiskChange, onResetRiskChange });
  expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--claude");
  expect(screen.getByText("Claude 驾驶舱")).toBeInTheDocument();
  const weekly = screen.getByRole("group", { name: "本周剩余 43%" });
  expect(weekly).toHaveClass("codex-ring-card--claude");
  expect(weekly).toHaveTextContent("5h 已用 38%");
  expect(weekly).toHaveTextContent("5h 重置 2小时30分");
  expect(weekly).toHaveTextContent("周重置 2天20小时");
  expect(weekly).not.toHaveTextContent("周额度周期");
  expect(weekly.querySelector(".codex-ring-progress--five-hour")).toHaveAttribute("stroke-dasharray", "38 62");
  fireEvent.change(screen.getByRole("slider", { name: "个人上限" }), { target: { value: "26" } });
  expect(onClaudeCapChange).toHaveBeenCalledWith(26);
  const risk = screen.getByRole("slider", { name: "重置风险" });
  expect(risk).toBeEnabled(); // A banked grant is an announcement, not a probability.
  fireEvent.change(risk, { target: { value: "32" } });
  expect(onClaudeRiskChange).toHaveBeenCalledWith(32);
  expect(onResetRiskChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Claude 重置公告/ }));
  expect(onOpenResetForecast).toHaveBeenCalledWith(forecast.notice.announcementUrl);
  expect(screen.queryByText("近 7 天模型")).not.toBeInTheDocument();
});

it("renders zero used when the 5-hour window is unused", () => {
  renderCard("claude", {}, { ...quota, fiveHour: { usedPercent: 0, resetsAt: null } });
  const weekly = screen.getByRole("group", { name: "本周剩余 43%" });
  expect(weekly).toHaveTextContent("5h 已用 0%");
  expect(weekly).toHaveTextContent("5h 重置 未知");
  expect(weekly.querySelector(".codex-ring-progress--five-hour")).toHaveAttribute("stroke-dasharray", "0 100");
});

it("explains a missing Claude login instead of showing numbers", () => {
  renderCard("claude", {}, { ...quota, status: "signed_out", fiveHour: null, sevenDay: null, message: "Claude Code login not found." });
  expect(screen.getByRole("status")).toHaveTextContent("未找到 Claude Code 登录");
  expect(screen.queryByRole("group", { name: /本周剩余/ })).not.toBeInTheDocument();
});

it("puts Codex and Claude weekly quotas side by side in the AI cockpit", () => {
  const { container } = renderCard("ai");
  expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--ai");
  expect(screen.getByText("AI 驾驶舱")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Codex 74%" })).toHaveTextContent("周重置 6天2小时");
  const claude = screen.getByRole("group", { name: "Claude 43%" });
  expect(claude).toHaveClass("codex-ring-card--claude");
  expect(claude).toHaveTextContent("5h 已用 38%");
  expect(claude).toHaveTextContent("周重置 2天20小时");
  expect(claude).toHaveTextContent("5h 重置 2小时30分");
  expect(claude.querySelector(".codex-ring-progress--five-hour")).toHaveAttribute("stroke-dasharray", "38 62");
});

it("marks a Claude session awaiting a fresh reading once its reset time passes", () => {
  const expired = { ...quota, fiveHour: { usedPercent: 85, resetsAt: now.toISOString() } };
  renderCard("ai", {}, expired);
  const claude = screen.getByRole("group", { name: "Claude 43%" });
  expect(claude).toHaveTextContent("5h 已用 —");
  expect(claude).toHaveTextContent("5h 重置 待更新");
  expect(claude).toHaveTextContent("待更新");
  expect(claude).not.toHaveTextContent("85%");
  expect(claude).not.toHaveTextContent("LIVE");
});

it("renders Claude and AI capsules with matching widths", () => {
  const { container, rerender } = render(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="claude" claudeWeeklyRemaining={43} claudeFiveHourUsed={38} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelector(".quota-orb")).toHaveClass("cockpit-mode--claude");
  expect(container.querySelector(".capsule-quota-readout--claude")).toBeInTheDocument();
  expect(container.querySelector(".quota-orb")).toHaveStyle({ "--capsule-logical-width": `${capsuleLogicalWidth(38)}px` });
  rerender(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="ai" claudeWeeklyRemaining={43} claudeFiveHourUsed={38} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelectorAll(".capsule-quota-readout")).toHaveLength(2);
  expect(container.querySelector(".quota-orb")?.getAttribute("aria-label")).toMatch(/Claude 5h 已用 38%/);
  expect(aiCapsuleLogicalWidth(5, 38)).toBeGreaterThan(capsuleLogicalWidth(38));
});

it("falls back to today's use when the plan reports no 5-hour window", () => {
  renderCard("claude", {}, { ...quota, fiveHour: null });
  expect(screen.queryByRole("group", { name: /5h 已用/ })).not.toBeInTheDocument();
  expect(screen.getByRole("group", { name: /^今日已用/ })).toHaveClass("codex-ring-card--claude");
  const { container } = render(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="claude" claudeWeeklyRemaining={43} claudeFiveHourUsed={null} claudeTodayRatio={50} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelector(".quota-orb")?.getAttribute("aria-label")).toMatch(/今日已用\/个人上限 50%/);
});

it("keeps a Codex-only cockpit when Claude is switched off", () => {
  render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true }}
    claudeView={null}
    onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
  expect(screen.getByText("Codex 驾驶舱")).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Claude 驾驶舱" })).not.toBeInTheDocument();
  expect(DEFAULT_WIDGET_PREFERENCES.claudeEnabled).toBe(false);
});
