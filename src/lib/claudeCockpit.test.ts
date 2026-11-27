import { describe, expect, it } from "vitest";
import { buildClaudeCockpitView, claudeQuotaMessage, nextCockpitMode, normalizeCockpitMode } from "./claudeCockpit";
import { normalizeWidgetPreferences } from "./preferences";
import type { ClaudeQuota } from "../types";

// 2026-11-10 20:00 in Asia/Shanghai.
const now = new Date("2026-11-10T12:00:00Z");

const quota = (overrides: Partial<ClaudeQuota> = {}): ClaudeQuota => ({
  status: "ok",
  fiveHour: { usedPercent: 38, resetsAt: "2026-11-10T14:30:00Z" },
  sevenDay: { usedPercent: 57.2, resetsAt: "2026-11-13T08:00:00Z" },
  sevenDayOpus: { usedPercent: 12, resetsAt: null },
  sevenDaySonnet: null,
  plan: "max",
  observedAt: now.toISOString(),
  message: null,
  ...overrides,
});

describe("cockpit mode", () => {
  it("cycles Codex, Claude and AI and keeps legacy preferences on Codex", () => {
    expect(nextCockpitMode("codex")).toBe("claude");
    expect(nextCockpitMode("claude")).toBe("ai");
    expect(nextCockpitMode("ai")).toBe("codex");
    expect(normalizeCockpitMode("gemini")).toBe("codex");
    expect(normalizeCockpitMode("gemini", true)).toBe("gemini");
    expect(normalizeWidgetPreferences({ language: "en" }).cockpitMode).toBe("codex");
    expect(normalizeWidgetPreferences({ cockpitMode: "ai" }).cockpitMode).toBe("ai");
    expect(normalizeWidgetPreferences({ cockpitMode: "ai" }).claudeEnabled).toBe(true);
    expect(normalizeWidgetPreferences({ language: "en" }).claudeEnabled).toBe(false);
    expect(normalizeWidgetPreferences({ language: "en" }).geminiEnabled).toBe(false);
  });
});

describe("Claude quota view", () => {
  it("shows weekly remaining and 5-hour used from the official limits", () => {
    const view = buildClaudeCockpitView(quota(), now);
    expect(view.weeklyRemaining).toBe(42.8);
    expect(view.fiveHourUsed).toBe(38);
    expect(view.opusWeeklyRemaining).toBe(88);
    expect(view.weeklyResetsAt).toBe("2026-11-13T08:00:00Z");
  });

  it("keeps the last good figures when stale and hides them when signed out", () => {
    expect(buildClaudeCockpitView(quota({ status: "stale", message: "Network unavailable." }), now).weeklyRemaining).toBe(42.8);
    const signedOut = buildClaudeCockpitView(quota({ status: "signed_out", message: "Claude Code login expired. Open Claude Code to refresh it." }), now);
    expect(signedOut.weeklyRemaining).toBeNull();
    expect(signedOut.fiveHourUsed).toBeNull();
    expect(claudeQuotaMessage(signedOut, "zh-CN")).toBe("Claude Code 登录已过期");
    expect(claudeQuotaMessage(buildClaudeCockpitView(null, now), "zh-CN")).toBe("正在读取 Claude 额度");
  });

  it("hides a spent window when its reset is due until a fresh reading arrives", () => {
    const elapsed = buildClaudeCockpitView(quota({ fiveHour: { usedPercent: 100, resetsAt: now.toISOString() } }), now);
    expect(elapsed.fiveHourUsed).toBeNull();
    expect(elapsed.fiveHourAwaitingRefresh).toBe(true);
    expect(elapsed.weeklyRemaining).toBe(42.8);
  });

  it("uses synced quota only as a fallback and drops synced figures after their reset", () => {
    const shared = { deviceId: "mac", deviceName: "Mac", quota: {
      observedAt: now.toISOString(),
      fiveHour: { usedPercent: 28, resetsAt: now.toISOString() },
      sevenDay: { usedPercent: 42, resetsAt: now.toISOString() },
    } };
    expect(buildClaudeCockpitView(quota(), now, shared).weeklyRemaining).toBe(42.8);
    const fallback = buildClaudeCockpitView(quota({ status: "signed_out" }), now, shared);
    expect(fallback).toMatchObject({
      weeklyRemaining: null, weeklyResetsAt: null, fiveHourUsed: null, fiveHourAwaitingRefresh: true,
    });
  });
});
