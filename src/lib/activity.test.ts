import { describe, expect, it } from "vitest";
import { canSendNotification, EMPTY_RUNTIME_STATE, isQuietHour, normalizeRuntimeState, recordSnapshotActivity } from "./activity";
import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import type { ProviderSnapshot } from "../types";

function snapshot(remainingPercent: number, status: ProviderSnapshot["status"] = "ok"): ProviderSnapshot {
  return {
    provider: "codex", displayName: "CODEX", plan: "PRO", shortWindow: null,
    weeklyWindow: { remainingPercent, resetsAt: "2026-07-25T00:00:00Z", windowSeconds: 604800 },
    resetCredits: 1, updatedAt: "2026-07-19T00:00:00Z", status, message: status === "ok" ? null : "offline",
  };
}

describe("activity timeline and notification policy", () => {
  it("records low quota crossings and provider recovery", () => {
    const low = recordSnapshotActivity(EMPTY_RUNTIME_STATE, [snapshot(30)], [snapshot(12)], null, 15, new Date("2026-07-19T01:00:00Z"));
    expect(low.createdEvents.map((item) => item.kind)).toContain("quota");
    const recovered = recordSnapshotActivity(low.state, [snapshot(12, "stale")], [snapshot(12)], null, 15, new Date("2026-07-19T02:00:00Z"));
    expect(recovered.createdEvents.map((item) => item.kind)).toContain("recovered");
  });

  it("deduplicates unchanged samples for thirty minutes", () => {
    const first = recordSnapshotActivity(EMPTY_RUNTIME_STATE, [], [snapshot(50)], null, 15, new Date("2026-07-19T01:00:00Z"));
    const second = recordSnapshotActivity(first.state, [snapshot(50)], [snapshot(50)], null, 15, new Date("2026-07-19T01:10:00Z"));
    expect(second.state.history).toHaveLength(1);
  });

  it("aggregates observed daily quota use without counting resets as consumption", () => {
    const first = recordSnapshotActivity(EMPTY_RUNTIME_STATE, [], [snapshot(90)], null, 15, new Date("2026-07-19T01:00:00Z"));
    const used = recordSnapshotActivity(first.state, [snapshot(90)], [snapshot(82)], null, 15, new Date("2026-07-19T02:00:00Z"));
    expect(used.state.dailyUsage).toEqual([
      expect.objectContaining({ provider: "codex", localDate: "2026-07-19", observedUsedPercent: 8, sampleCount: 2 }),
    ]);

    const reset = snapshot(100);
    reset.weeklyWindow = { ...reset.weeklyWindow!, resetsAt: "2026-08-01T00:00:00Z" };
    const restored = recordSnapshotActivity(used.state, [snapshot(82)], [reset], null, 15, new Date("2026-07-19T03:00:00Z"));
    expect(restored.state.dailyUsage[0].observedUsedPercent).toBe(8);
  });

  it("rolls local history into the next usage day at 4:00", () => {
    const beforeFour = recordSnapshotActivity(
      EMPTY_RUNTIME_STATE,
      [],
      [snapshot(90)],
      null,
      15,
      new Date("2026-07-19T03:59:00+08:00"),
    );
    const atFour = recordSnapshotActivity(
      beforeFour.state,
      [snapshot(90)],
      [snapshot(82)],
      null,
      15,
      new Date("2026-07-19T04:00:00+08:00"),
    );

    expect(atFour.state.dailyUsage).toEqual([
      expect.objectContaining({ localDate: "2026-07-18", observedUsedPercent: 0 }),
      expect.objectContaining({ localDate: "2026-07-19", observedUsedPercent: 8 }),
    ]);
  });

  it("tracks percentage history for providers that only expose a short window", () => {
    const shortOnly = (remainingPercent: number): ProviderSnapshot => ({
      provider: "antigravity",
      displayName: "ANTIGRAVITY",
      plan: "Google AI Pro",
      shortWindow: { remainingPercent, resetsAt: "2026-07-19T05:00:00Z", windowSeconds: 18_000 },
      weeklyWindow: null,
      resetCredits: null,
      updatedAt: "2026-07-19T00:00:00Z",
      status: "ok",
      message: null,
    });
    const first = recordSnapshotActivity(EMPTY_RUNTIME_STATE, [], [shortOnly(90)], null, 15, new Date("2026-07-19T01:00:00Z"));
    const used = recordSnapshotActivity(first.state, [shortOnly(90)], [shortOnly(82)], null, 15, new Date("2026-07-19T02:00:00Z"));

    expect(used.state.history.at(-1)).toEqual(expect.objectContaining({ provider: "antigravity", metricKind: "percent", metric: 82 }));
    expect(used.state.dailyUsage.at(-1)).toEqual(expect.objectContaining({ provider: "antigravity", observedUsedPercent: 8 }));
  });

  it("preserves usage across multiple short-window cycles on the same day", () => {
    const shortOnly = (remainingPercent: number, resetsAt: string): ProviderSnapshot => ({
      provider: "antigravity",
      displayName: "ANTIGRAVITY",
      plan: "Google AI Pro",
      shortWindow: { remainingPercent, resetsAt, windowSeconds: 18_000 },
      weeklyWindow: null,
      resetCredits: null,
      updatedAt: "2026-07-19T00:00:00Z",
      status: "ok",
      message: null,
    });
    const cycleOneStart = shortOnly(100, "2026-07-19T05:00:00Z");
    const cycleOneUsed = shortOnly(40, "2026-07-19T05:00:00Z");
    const cycleTwoStart = shortOnly(100, "2026-07-19T10:00:00Z");
    const cycleTwoUsed = shortOnly(40, "2026-07-19T10:00:00Z");
    const first = recordSnapshotActivity(EMPTY_RUNTIME_STATE, [], [cycleOneStart], null, 15, new Date("2026-07-19T00:00:00Z"));
    const firstCycle = recordSnapshotActivity(first.state, [cycleOneStart], [cycleOneUsed], null, 15, new Date("2026-07-19T01:00:00Z"));
    const reset = recordSnapshotActivity(firstCycle.state, [cycleOneUsed], [cycleTwoStart], null, 15, new Date("2026-07-19T05:00:00Z"));
    const secondCycle = recordSnapshotActivity(reset.state, [cycleTwoStart], [cycleTwoUsed], null, 15, new Date("2026-07-19T06:00:00Z"));

    expect(secondCycle.state.dailyUsage.at(-1)?.observedUsedPercent).toBe(120);
  });

  it("supports overnight quiet hours and per-alert cooldowns", () => {
    expect(isQuietHour(23, 22, 8)).toBe(true);
    expect(isQuietHour(7, 22, 8)).toBe(true);
    expect(isQuietHour(12, 22, 8)).toBe(false);
    const state = { ...EMPTY_RUNTIME_STATE, lastNotifications: { "quota:codex": "2026-07-19T01:00:00Z" } };
    expect(canSendNotification(state, "quota:codex", 120, new Date("2026-07-19T02:00:00Z"))).toBe(false);
    expect(canSendNotification(state, "quota:codex", 120, new Date("2026-07-19T03:01:00Z"))).toBe(true);
  });

  it("creates a reminder when Volcengine usage crosses the even-cycle pace", () => {
    const volcengine = (monthlyRemaining: number): ProviderSnapshot => ({
      provider: "volcengine",
      displayName: "VOLCENGINE",
      plan: "Coding Plan Personal",
      shortWindow: null,
      weeklyWindow: { remainingPercent: 100, resetsAt: "2026-07-26T00:00:00Z", windowSeconds: 604_800 },
      monthlyWindow: { remainingPercent: monthlyRemaining, resetsAt: "2026-08-18T00:00:00Z", windowSeconds: 2_592_000 },
      resetCredits: null,
      updatedAt: "2026-07-19T00:00:00Z",
      status: "ok",
      message: null,
    });
    const update = recordSnapshotActivity(
      EMPTY_RUNTIME_STATE,
      [volcengine(100)],
      [volcengine(99)],
      null,
      15,
      new Date("2026-07-19T00:00:00Z"),
    );
    expect(update.createdEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "warning", provider: "volcengine", title: "VOLCENGINE usage is over pace" }),
    ]));
  });

  it("tracks low-quota crossings for every Volcengine window", () => {
    const volcengine = (shortRemaining: number): ProviderSnapshot => ({
      provider: "volcengine",
      displayName: "VOLCENGINE",
      plan: "Coding Plan Personal",
      shortWindow: { remainingPercent: shortRemaining, resetsAt: "2026-07-19T05:00:00Z", windowSeconds: 18_000 },
      weeklyWindow: { remainingPercent: 80, resetsAt: "2026-07-26T00:00:00Z", windowSeconds: 604_800 },
      monthlyWindow: { remainingPercent: 70, resetsAt: "2026-08-18T00:00:00Z", windowSeconds: 2_592_000 },
      resetCredits: null,
      updatedAt: "2026-07-19T00:00:00Z",
      status: "ok",
      message: null,
    });
    const update = recordSnapshotActivity(
      EMPTY_RUNTIME_STATE,
      [volcengine(30)],
      [volcengine(12)],
      null,
      15,
      new Date("2026-07-19T01:00:00Z"),
    );
    expect(update.createdEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "quota", detail: "12% 5-hour quota remains." }),
    ]));
  });

  it("reminds when the Codex weekly window moves over pace", () => {
    const update = recordSnapshotActivity(
      EMPTY_RUNTIME_STATE,
      [snapshot(100)],
      [snapshot(80)],
      null,
      15,
      new Date("2026-07-19T02:00:00Z"),
    );
    expect(update.createdEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "warning", provider: "codex", title: "CODEX usage is over pace", detail: expect.stringContaining("remains in today's plan") }),
    ]));
    expect(update.notificationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "pace:codex:weekly" }),
    ]));
  });

  it("repeats an over-pace notification after cooldown without duplicating the activity log", () => {
    const current = {
      ...EMPTY_RUNTIME_STATE,
      lastNotifications: { "pace:codex:weekly": "2026-07-18T23:00:00Z" },
    };
    const update = recordSnapshotActivity(
      current,
      [snapshot(80)],
      [snapshot(79)],
      null,
      15,
      new Date("2026-07-19T02:00:00Z"),
      "en",
      120,
    );
    expect(update.createdEvents.filter((item) => item.kind === "warning")).toHaveLength(0);
    expect(update.notificationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "pace:codex:weekly", event: expect.objectContaining({ title: "CODEX usage is over pace" }) }),
    ]));
  });

  it("does not repeat an over-pace notification before cooldown expires", () => {
    const current = {
      ...EMPTY_RUNTIME_STATE,
      lastNotifications: { "pace:codex:weekly": "2026-07-19T01:30:00Z" },
    };
    const update = recordSnapshotActivity(
      current,
      [snapshot(80)],
      [snapshot(79)],
      null,
      15,
      new Date("2026-07-19T02:00:00Z"),
      "en",
      120,
    );
    expect(update.notificationCandidates.some((item) => item.key === "pace:codex:weekly")).toBe(false);
  });

  it("escalates immediately when the fixed daily budget reaches zero", () => {
    const anchored = recordSnapshotActivity(
      EMPTY_RUNTIME_STATE,
      [],
      [snapshot(90)],
      null,
      15,
      new Date("2026-07-19T01:00:00Z"),
      "en",
      120,
    );
    const update = recordSnapshotActivity(
      anchored.state,
      [snapshot(90)],
      [snapshot(70)],
      null,
      15,
      new Date("2026-07-19T02:00:00Z"),
      "en",
      120,
    );
    expect(update.createdEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "CODEX today's pace budget is used up", detail: expect.stringContaining("0% remains in today's plan") }),
    ]));
    expect(update.notificationCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "pace-zero:codex:weekly" }),
    ]));
  });

  it("resets the Codex daily pacing anchor when the weekly quota resets", () => {
    const beforeReset = recordSnapshotActivity(
      {
        ...EMPTY_RUNTIME_STATE,
        lastNotifications: {
          "pace:codex:weekly": "2026-07-19T02:30:00Z",
          "quota:codex": "2026-07-19T02:30:00Z",
          "quota:volcengine": "2026-07-19T02:30:00Z",
        },
      },
      [],
      [snapshot(20)],
      null,
      15,
      new Date("2026-07-19T02:00:00Z"),
    );
    const resetSnapshot = snapshot(100);
    resetSnapshot.weeklyWindow = { ...resetSnapshot.weeklyWindow!, resetsAt: "2026-08-01T00:00:00Z" };
    const afterReset = recordSnapshotActivity(
      beforeReset.state,
      [snapshot(20)],
      [resetSnapshot],
      { resetAt: "2026-07-19T03:00:00Z", detectedAt: "2026-07-19T03:00:00Z", source: "observed" },
      15,
      new Date("2026-07-19T03:00:00Z"),
      "en",
      120,
      {
        score: 90,
        windowHours: 48,
        fetchedAt: "2026-07-19T03:00:00Z",
        resetAnnounced: false,
        sourceUrl: "https://codex-resets.com/",
      },
    );
    const baseline = afterReset.state.dailyPaceBaselines["codex:weekly"];

    expect(baseline.remainingPercent).toBe(100);
    expect(baseline.resetsAt).toBe("2026-08-01T00:00:00Z");
    expect(baseline.capturedAt).toBe("2026-07-19T03:00:00.000Z");
    expect(baseline.cycleStartedAt).toBe("2026-07-19T03:00:00.000Z");
    expect(baseline.cycleStartRemainingPercent).toBe(100);
    expect(baseline.planningResetsAt).toBe("2026-08-01T00:00:00Z");
    expect(baseline.resetForecastScore).toBeNull();
    expect(afterReset.state.lastNotifications).toEqual({ "quota:volcengine": "2026-07-19T02:30:00Z" });
    expect(afterReset.createdEvents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reset" })]));

    const usedSnapshot = snapshot(95);
    usedSnapshot.weeklyWindow = { ...usedSnapshot.weeklyWindow!, resetsAt: "2026-08-01T00:00:00Z" };
    const afterRefresh = recordSnapshotActivity(
      afterReset.state,
      [resetSnapshot],
      [usedSnapshot],
      { resetAt: "2026-07-19T03:00:00Z", detectedAt: "2026-07-19T03:00:00Z", source: "window" },
      15,
      new Date("2026-07-19T04:00:00Z"),
    );

    expect(afterRefresh.state.dailyPaceBaselines["codex:weekly"]).toEqual(baseline);
    expect(afterRefresh.createdEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "reset" })]));
    expect(afterRefresh.notificationCandidates.some(({ key }) =>
      key === "pace:codex:weekly" || key === "pace-zero:codex:weekly"
    )).toBe(true);
  });

  it("loads pre-Radar daily baselines with the weekly reset as their fallback", () => {
    const normalized = normalizeRuntimeState({
      dailyPaceBaselines: {
        "codex:weekly": {
          provider: "codex",
          period: "weekly",
          localDate: "2026-07-19",
          capturedAt: "2026-07-19T01:00:00Z",
          remainingPercent: 50,
          resetsAt: "2026-07-25T00:00:00Z",
        },
      },
    });

    expect(normalized.dailyPaceBaselines["codex:weekly"]).toEqual(expect.objectContaining({
      planningResetsAt: "2026-07-25T00:00:00Z",
      resetForecastScore: null,
      resetForecastWindowHours: null,
    }));
  });

  it("migrates legacy saved styles and preserves newer layout variations", () => {
    const normalized = normalizeRuntimeState({
      savedLayouts: [{
        id: "legacy-island",
        name: "Legacy Island",
        createdAt: "2026-07-19T01:00:00Z",
        providerOrder: ["codex"],
        hiddenProviders: [],
        collapsedProviders: [],
        layoutMode: "standard",
        visualStyle: "island",
        appearanceMode: "dark",
        riskFirst: false,
        showHistorySparklines: true,
        accentColor: "#397ae0",
      }, {
        id: "ring-stacked",
        name: "Ring and Stacked",
        createdAt: "2026-07-20T01:00:00Z",
        providerOrder: ["codex"],
        hiddenProviders: [],
        collapsedProviders: [],
        layoutMode: "standard",
        compactLayout: "ring",
        expandedLayout: "stacked",
        colorTheme: "paper",
        appearanceMode: "light",
        riskFirst: false,
        showHistorySparklines: true,
        accentColor: "#397ae0",
      }],
    });

    expect(normalized.savedLayouts[0]).toEqual(expect.objectContaining({
      compactLayout: "bar",
      expandedLayout: "provider-bar",
      colorTheme: "aurora",
      appearanceMode: "dark",
    }));
    expect(normalized.savedLayouts[1]).toEqual(expect.objectContaining({
      compactLayout: "ring",
      expandedLayout: "stacked",
      colorTheme: "paper",
    }));
  });

  it("drops malformed imported history, events, layouts, and notification dates", () => {
    const normalized = normalizeRuntimeState({
      schemaVersion: 99,
      history: ["bad", { provider: "unknown", capturedAt: "not-a-date", metric: "many" }],
      events: [null, { id: 3, provider: "codex", kind: "reset", occurredAt: "invalid" }],
      savedLayouts: [{ id: null, name: [], providerOrder: ["unknown"] }],
      lastNotifications: { "quota:codex": "not-a-date", unsafe: 12 },
    });
    expect(normalized).toEqual(EMPTY_RUNTIME_STATE);
  });

  it("preserves valid multi-cycle daily usage while bounding imported values", () => {
    const base = {
      schemaVersion: 1,
      history: [],
      events: [],
      savedLayouts: [],
      lastNotifications: {},
      dailyPaceBaselines: {},
    };
    const normalized = normalizeRuntimeState({
      ...base,
      dailyUsage: [
        { provider: "antigravity", localDate: "2026-07-19", observedUsedPercent: 120, sampleCount: 6, updatedAt: "2026-07-19T06:00:00Z" },
        { provider: "codex", localDate: "2026-07-20", observedUsedPercent: MAX_DAILY_OBSERVED_PERCENT + 1, sampleCount: 2, updatedAt: "2026-07-20T06:00:00Z" },
      ],
    });

    expect(normalized.dailyUsage[0].observedUsedPercent).toBe(120);
    expect(normalized.dailyUsage[1].observedUsedPercent).toBe(MAX_DAILY_OBSERVED_PERCENT);
  });

  it("normalizes local comfort feedback and prompt dates without importing raw data", () => {
    const normalized = normalizeRuntimeState({
      comfortFeedback: [{
        localDate: "2026-08-13",
        observedAt: "2026-08-13T14:00:00Z",
        comfort: "comfortable",
        observedUsedPercent: 18,
        usageObservedAt: "2026-08-13T13:30:00Z",
        usageCoverage: "complete",
        usageSource: "official-snapshot",
        curveVersion: "p014-t014-y-v1",
        rawResponse: "must be discarded",
      }],
      comfortPromptedDates: ["2026-08-13", "not-a-date", "2026-08-13"],
    });
    expect(normalized.comfortFeedback).toEqual([expect.objectContaining({ localDate: "2026-08-13", observedUsedPercent: 18 })]);
    expect(normalized.comfortFeedback[0]).not.toHaveProperty("rawResponse");
    expect(normalized.comfortPromptedDates).toEqual(["legacy:2026-08-13"]);
    expect(normalized.comfortFeedback[0].personId).toBeNull();
    expect(normalized.comfortFeedback[0].tokenSnapshot).toBeNull();
  });

  it("roundtrips separate people and per-person reminder keys without assigning legacy feedback", () => {
    const old = { localDate: "2026-08-13", observedAt: "2026-08-13T14:00:00Z", comfort: "comfortable", observedUsedPercent: 18, usageObservedAt: null, usageCoverage: "partial", usageSource: "local-history", curveVersion: "p014-t014-ordinal-map-v3" };
    const result = normalizeRuntimeState({ comfortPersonId: "alex", comfortFeedback: [old, { ...old, personId: "alex", personName: "成员甲" }, { ...old, personId: "blair", personName: "成员乙", comfort: "idle" }], comfortPromptedDates: ["2026-08-13", "person:alex:2026-08-13", "person:blair:2026-08-13"] });
    const reloaded = normalizeRuntimeState(JSON.parse(JSON.stringify(result)));
    expect(reloaded).toEqual(result);
    expect(reloaded.comfortPersonId).toBe("alex");
    expect(reloaded.comfortFeedback.map(item => item.personId)).toEqual([null, "alex", "blair"]);
    expect(reloaded.comfortPromptedDates).toHaveLength(3);
  });

  it("normalizes persisted daily recommendations and drops malformed entries", () => {
    const normalized = normalizeRuntimeState({
      dailyRecommendations: [{
        provider: "codex",
        localDate: "2026-08-13",
        targetPercent: 36,
        safetyCapPercent: 74,
        resetRiskPercent: 30,
        fatigueKneePercent: 24.3,
        carryInPercent: 7.5,
        policyVersion: "p014-t009-fatigue-carry-dp-v1",
        updatedAt: "2026-08-13T14:00:00Z",
      }, {
        provider: "codex",
        localDate: "bad-date",
        targetPercent: "not-a-number",
      }],
    });
    expect(normalized.dailyRecommendations).toEqual([expect.objectContaining({ targetPercent: 36, fatigueKneePercent: 24.3 })]);
  });
});
