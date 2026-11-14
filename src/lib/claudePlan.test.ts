import { describe, expect, it } from "vitest";
import { EMPTY_RUNTIME_STATE, normalizeRuntimeState } from "./activity";
import { buildClaudeComfortPrompt, buildClaudePlan, claudeQuotaDays, claudeResetWatch, EMPTY_CLAUDE_PLAN, observeClaudeQuota } from "./claudePlan";
import { appendComfortFeedback, createComfortFeedbackRecord, personalizeComfortCurve } from "./comfortFeedback";
import type { ClaudeQuota, ClaudeResetForecast } from "../types";

const quota = (observedAt: string, usedPercent: number, resetsAt = "2026-11-14T04:00:00Z", status: ClaudeQuota["status"] = "ok"): ClaudeQuota => ({
  status, observedAt, sevenDay: { usedPercent, resetsAt }, fiveHour: null,
  sevenDayOpus: null, sevenDaySonnet: null, plan: "max", message: null,
});

const snapshot = (used: number, hhmm: string, date = "2026-11-10", resetsAt?: string) => quota(`${date}T${hhmm}:00Z`, used, resetsAt);
const observe = (state: typeof EMPTY_CLAUDE_PLAN, q: ClaudeQuota) => observeClaudeQuota(state, q, new Date(q.observedAt!));

describe("Claude subscription plan", () => {
  it("keeps the same target as usage rises and distinguishes unknown use from an observed zero", () => {
    const first = snapshot(20, "01:00");
    const state = observe(EMPTY_CLAUDE_PLAN, first);
    const initial = buildClaudePlan(state, first, 25, new Date(first.observedAt!));
    expect(initial.advice.todayUsedPercent).toBeNull();
    expect(initial.advice.todaySuggestedPercent).toBeGreaterThan(0);
    const second = snapshot(30, "04:00");
    const after = buildClaudePlan({ ...observe(state, second), cap: { localDate: "2026-11-10", percent: 8 } }, second, 25, new Date(second.observedAt!));
    expect(after.advice.todaySuggestedPercent).toBe(initial.advice.todaySuggestedPercent);
    expect(after.advice.todayUsedPercent).toBe(10);
    expect(after.ratio).toBe(125);
    expect(observe(state, first)).toBe(state);
    expect(observeClaudeQuota(state, { ...second, status: "stale" })).toBe(state);
  });

  it("continues counting across a banked refill with the same reset timestamp; a transient dip is ignored", () => {
    const initial = observe(observe(EMPTY_CLAUDE_PLAN, snapshot(50, "01:00")), snapshot(80, "02:00"));
    const dip = observe(initial, snapshot(5, "03:00"));
    expect(claudeQuotaDays(observe(dip, snapshot(81, "03:01")))[0].observedUsedPercent).toBe(31);
    const reloaded = normalizeRuntimeState(JSON.parse(JSON.stringify({ ...EMPTY_RUNTIME_STATE, claudePlan: dip }))).claudePlan!;
    const secondLow = observe(reloaded, snapshot(5, "03:01"));
    const after = observe(secondLow, snapshot(29, "04:00"));
    expect(claudeQuotaDays(after)[0].observedUsedPercent).toBe(54);
    expect(after.quotaDays[0].baselineUsed).toBe(5);
  });

  it("keeps today's pre-reset usage and resets the daily cap at Beijing midnight", () => {
    const earlier = snapshot(80, "04:00");
    const prior = observe(observe(EMPTY_CLAUDE_PLAN, snapshot(55, "01:00")), earlier);
    const changed = snapshot(3, "06:00", "2026-11-10", "2026-11-17T05:00:00Z");
    const state = observe({ ...prior, cap: { localDate: "2026-11-10", percent: 17 } }, changed);
    expect(claudeQuotaDays(state)[0].observedUsedPercent).toBe(25);
    const nextDay = snapshot(9, "16:00", "2026-11-10", changed.sevenDay!.resetsAt!);
    const rolled = observe(state, nextDay);
    expect(rolled.quotaDays.map(day => day.localDate)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(buildClaudePlan(rolled, nextDay, 25, new Date(nextDay.observedAt!)).cap).not.toBe(17);
  });

  it("uses the scheduled quota window after clearing manual risk; feedback is separate from Codex", () => {
    const q = snapshot(27, "03:00");
    const now = new Date(q.observedAt!);
    const state = observeClaudeQuota(EMPTY_CLAUDE_PLAN, q, now, { localDate: "2026-11-10", weeklyUsedPercent: 12 });
    const prompt = buildClaudeComfortPrompt({ localDate: "2026-11-10", isCatchUp: false }, claudeQuotaDays(state)[0]);
    const feedback = createComfortFeedbackRecord(prompt, "comfortable", now);
    const runtime = normalizeRuntimeState({ ...EMPTY_RUNTIME_STATE, claudePlan: { ...state, manualRiskPercent: 55, comfortFeedback: appendComfortFeedback([], feedback) } });
    expect(runtime.comfortFeedback).toEqual([]);
    const saved = runtime.claudePlan!;
    expect(personalizeComfortCurve(saved.comfortFeedback, now, null).observations[0].usedPercent).toBe(15);
    const manual = buildClaudePlan(saved, q, 25, now);
    const auto = buildClaudePlan({ ...saved, manualRiskPercent: null }, q, 25, now);
    expect(manual.riskSource).toBe("manual");
    expect(auto.riskSource).toBe("scheduled-only");
    expect(auto.advice.resetRiskPercent).toBeNull();
    expect(manual.advice.todaySuggestedPercent).toBeGreaterThan(auto.advice.todaySuggestedPercent!);
  });
});

it("keeps a Claude announcement independent of its numerical forecast and expires stale checks", () => {
  const now = new Date("2026-11-12T12:00:00Z");
  const forecast: ClaudeResetForecast = {
    checkedAt: now.toISOString(),
    notice: { observedAt: "2026-11-10T21:59:58Z", expiresAt: "2026-11-12T21:59:58Z", announcementUrl: "https://x.com/ClaudeDevs/status/2120275296637321476" },
  };
  expect(claudeResetWatch(forecast, now)?.resetChancePercent).toBeNull();
  expect(claudeResetWatch(forecast, new Date(now.getTime() + 10 * 60_000))).toBeNull();
  expect(claudeResetWatch({ ...forecast, notice: { ...forecast.notice!, announcementUrl: "https://x.com/ClaudeDevs/status/12?redirect=unexpected" } }, now)?.announcementUrl).toBe("https://claude-resets.com/");
});
