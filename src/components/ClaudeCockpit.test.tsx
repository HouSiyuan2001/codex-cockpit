// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import { buildClaudeCockpitView } from "../lib/claudeCockpit";
import type { ClaudeQuota, CockpitMode, ProviderSnapshot, SharedClaudeQuota } from "../types";
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
  onClaudeLogin?: () => void;
  onCockpitModeChange?: (mode: CockpitMode) => void;
}

function renderCard(cockpitMode: CockpitMode, handlers: ModeHandlers = {}, claudeQuota: ClaudeQuota = quota, shared: SharedClaudeQuota | null = null) {
  const preferences = { ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true, cockpitMode, claudeEnabled: true };
  const claudeView = buildClaudeCockpitView(claudeQuota, now, shared);
  return render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={preferences}
    now={now} claudeView={claudeView} claudeShared={{ status: "ready", snapshot: shared, refresh: vi.fn() }} {...handlers}
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

it("shows separate official weekly and 5-hour quotas with their countdowns", () => {
  const { container } = renderCard("claude");
  expect(container.querySelector(".codex-focus-card")).toHaveClass("cockpit-mode--claude");
  const weekly = screen.getByRole("group", { name: "本周剩余 43%" });
  const fiveHour = screen.getByRole("group", { name: "5h 已用 38%" });
  expect(weekly.querySelector(".reset-countdown-footer > span:first-child")).toHaveTextContent("本周已用 57%");
  expect(weekly).toHaveTextContent("周重置 2天20小时");
  expect(fiveHour.querySelector(".reset-countdown-footer > span:first-child")).toHaveTextContent("5h 剩余 62%");
  expect(fiveHour).toHaveTextContent("5h 重置 2小时30分");
  expect(weekly.querySelector(".codex-ring-progress")).toHaveAttribute("stroke-dasharray", "43 57");
  expect(fiveHour.querySelector(".codex-ring-progress")).toHaveAttribute("stroke-dasharray", "38 62");
  expect(weekly.querySelector(".codex-ring-progress--five-hour")).toBeNull();
  expect(screen.queryByText("官方额度快照")).not.toBeInTheDocument();
  expect(screen.queryByText("今日已用")).not.toBeInTheDocument();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

it("renders zero used when the 5-hour window is unused", () => {
  renderCard("claude", {}, { ...quota, fiveHour: { usedPercent: 0, resetsAt: null } });
  const fiveHour = screen.getByRole("group", { name: "5h 已用 0%" });
  expect(fiveHour.querySelector(".reset-countdown-footer > span:first-child")).toHaveTextContent("5h 剩余 100%");
  expect(fiveHour).toHaveTextContent("5h 重置 未知");
  expect(fiveHour.querySelector(".codex-ring-progress")).toHaveAttribute("stroke-dasharray", "0 100");
});

it("shows a pending reading when the 5-hour window resets", () => {
  renderCard("claude", {}, { ...quota, fiveHour: { usedPercent: 85, resetsAt: now.toISOString() } });
  const fiveHour = screen.getByRole("group", { name: "5h 已用" });
  expect(fiveHour.querySelector(".reset-countdown-footer > span:first-child")).toHaveTextContent("5h 剩余 —");
  expect(fiveHour).toHaveTextContent("5h 重置 待更新");
  expect(fiveHour).not.toHaveTextContent("85%");
  expect(screen.getByRole("group", { name: "本周剩余 43%" })).toHaveTextContent("LIVE");
});

it.each(["claude", "ai"] as const)("offers Claude re-login in %s mode when signed out", (mode) => {
  const onClaudeLogin = vi.fn();
  renderCard(mode, { onClaudeLogin }, { ...quota, status: "signed_out", fiveHour: null, sevenDay: null, message: "Claude Code login not found." });
  const icon = screen.getByRole("button", { name: "未找到 Claude Code 登录" });
  expect(icon).toHaveTextContent(/^$/);
  expect(screen.queryByRole("button", { name: "查看其他设备额度" })).not.toBeInTheDocument();
  fireEvent.click(icon);
  expect(onClaudeLogin).toHaveBeenCalledTimes(1);
});

it.each(["claude", "ai"] as const)("displays synced Claude quotas in %s mode without a click", (mode) => {
  const shared = { deviceId: "mac", deviceName: "Work Mac", quota: {
    observedAt: now.toISOString(),
    fiveHour: { usedPercent: 28, resetsAt: quota.fiveHour?.resetsAt ?? null },
    sevenDay: { usedPercent: 42, resetsAt: quota.sevenDay?.resetsAt ?? null },
  } };
  const signedOut: ClaudeQuota = { ...quota, status: "signed_out", fiveHour: null, sevenDay: null };
  renderCard(mode, {}, signedOut, shared);
  const weekly = screen.getByRole("group", { name: mode === "claude" ? "本周剩余 58%" : "Claude 58%" });
  const fiveHour = mode === "claude" ? screen.getByRole("group", { name: "5h 已用 28%" }) : weekly;
  expect(fiveHour).toHaveTextContent("5h 重置 2小时30分");
  const icon = screen.getByRole("button", { name: "未找到 Claude Code 登录" });
  expect(icon).toHaveTextContent(/^$/);
  expect(icon).toHaveAccessibleDescription(/同步自 Work Mac/);
  expect(screen.queryByRole("button", { name: "查看其他设备额度" })).not.toBeInTheDocument();
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

it("shows a missing 5-hour period and falls back to weekly quota in the capsule", () => {
  renderCard("claude", {}, { ...quota, fiveHour: null });
  expect(screen.getByRole("group", { name: "5h 已用" })).toHaveTextContent("—");
  const { container } = render(<QuotaOrb snapshot={codex} compactLayout="capsule" cockpitMode="claude" claudeWeeklyRemaining={43} claudeFiveHourUsed={null} dailyBudgetPercent={10} onDrag={() => {}} />);
  expect(container.querySelector(".quota-orb")).toHaveAccessibleName("Claude 本周额度剩余 43%");
});

it("keeps a Codex-only cockpit when Claude is switched off", () => {
  render(<QuotaCard snapshot={codex} snapshots={[codex]} preferences={{ ...DEFAULT_WIDGET_PREFERENCES, codexFocusMode: true }}
    claudeView={null}
    onSelectProvider={() => {}} onLock={() => {}} onLanguage={() => {}} onDrag={() => {}} onHover={() => {}} consumingProviders={new Set()} />);
  expect(screen.getByText("Codex 驾驶舱")).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "Claude 驾驶舱" })).not.toBeInTheDocument();
  expect(DEFAULT_WIDGET_PREFERENCES.claudeEnabled).toBe(false);
});
