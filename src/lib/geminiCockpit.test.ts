import { describe, expect, it } from "vitest";
import {
  buildGeminiCockpitView,
  DOUBLE_CAPSULE_HEIGHT,
  effectiveCockpitMode,
  enabledCockpitModes,
  resolveCapsuleLayout,
  SINGLE_CAPSULE_HEIGHT,
} from "./geminiCockpit";
import { DEFAULT_WIDGET_PREFERENCES, normalizeWidgetPreferences } from "./preferences";
import type { CapsuleCorner, GeminiQuota } from "../types";

const now = new Date("2026-11-26T12:00:00Z");

const sampleQuota = (overrides: Partial<GeminiQuota> = {}): GeminiQuota => ({
  status: "ok",
  plan: "Google AI Pro",
  observedAt: now.toISOString(),
  message: null,
  gemini: {
    fiveHour: { remainingPercent: 84.49, resetsAt: "2026-11-26T15:30:00Z" },
    weekly: { remainingPercent: 71.8, resetsAt: null },
  },
  claudeGpt: {
    fiveHour: { remainingPercent: 92, resetsAt: null },
    weekly: { remainingPercent: 63.5, resetsAt: "2026-11-30T08:00:00Z" },
  },
  ...overrides,
});

describe("Gemini preferences and mode switches", () => {
  it("keeps Gemini opt-in and off by default while preserving legacy settings", () => {
    expect(DEFAULT_WIDGET_PREFERENCES.geminiEnabled).toBe(false);
    expect(DEFAULT_WIDGET_PREFERENCES.codexEnabled).toBe(true);
    expect(normalizeWidgetPreferences({}).geminiEnabled).toBe(false);
    expect(normalizeWidgetPreferences({ cockpitMode: "gemini" }).cockpitMode).toBe("codex");
    expect(normalizeWidgetPreferences({ cockpitMode: "gemini", geminiEnabled: true }).cockpitMode).toBe("gemini");
    expect(normalizeWidgetPreferences({ codexEnabled: false, geminiEnabled: true }).cockpitMode).toBe("gemini");
    expect(normalizeWidgetPreferences({ codexEnabled: false, claudeEnabled: false, geminiEnabled: false })).toEqual(
      expect.objectContaining({ codexEnabled: true, cockpitMode: "codex" }),
    );
  });

  it("computes enabled modes across single and multi-provider combinations", () => {
    expect(enabledCockpitModes({ codexEnabled: true, claudeEnabled: false, geminiEnabled: false })).toEqual(["codex"]);
    expect(enabledCockpitModes({ codexEnabled: true, claudeEnabled: true, geminiEnabled: false })).toEqual(["codex", "claude", "ai"]);
    expect(enabledCockpitModes({ codexEnabled: true, claudeEnabled: false, geminiEnabled: true })).toEqual(["codex", "gemini", "ai"]);
    expect(enabledCockpitModes({ codexEnabled: false, claudeEnabled: true, geminiEnabled: true })).toEqual(["claude", "gemini", "ai"]);
    expect(enabledCockpitModes({ codexEnabled: false, claudeEnabled: false, geminiEnabled: true })).toEqual(["gemini"]);
    expect(enabledCockpitModes({ codexEnabled: true, claudeEnabled: true, geminiEnabled: true })).toEqual(["codex", "claude", "gemini", "ai"]);
    expect(effectiveCockpitMode({ cockpitMode: "ai", codexEnabled: false, claudeEnabled: false, geminiEnabled: true })).toBe("gemini");
  });
});

describe("Gemini quota view mapping", () => {
  it("rounds both Gemini quota pools to whole percentages and preserves known reset times", () => {
    const view = buildGeminiCockpitView(sampleQuota(), now);
    expect(view.geminiFiveHour).toEqual({ remaining: 84, resetsAt: "2026-11-26T15:30:00Z", awaitingRefresh: false });
    expect(view.geminiWeekly).toEqual({ remaining: 72, resetsAt: null, awaitingRefresh: false });
    expect(view.sharedFiveHour).toEqual({ remaining: 92, resetsAt: null, awaitingRefresh: false });
    expect(view.sharedWeekly).toEqual({ remaining: 64, resetsAt: "2026-11-30T08:00:00Z", awaitingRefresh: false });
  });

  it("keeps the reported quota when Antigravity uses the Unix epoch for an unknown reset", () => {
    const quota = sampleQuota();
    const view = buildGeminiCockpitView({
      ...quota,
      claudeGpt: {
        fiveHour: { remainingPercent: 100, resetsAt: "1970-01-01T00:00:00+00:00" },
        weekly: quota.claudeGpt?.weekly ?? null,
      },
    }, now);
    expect(view.sharedFiveHour).toEqual({ remaining: 100, resetsAt: null, awaitingRefresh: false });
  });

  it("marks elapsed windows awaiting refresh and clears figures when unavailable or signed out", () => {
    const elapsed = buildGeminiCockpitView(sampleQuota({
      gemini: {
        fiveHour: { remainingPercent: 12, resetsAt: now.toISOString() },
        weekly: { remainingPercent: 70, resetsAt: null },
      },
    }), now);
    expect(elapsed.geminiFiveHour).toEqual({ remaining: null, resetsAt: null, awaitingRefresh: true });
    expect(elapsed.geminiWeekly.remaining).toBe(70);

    const stale = buildGeminiCockpitView(sampleQuota({ status: "stale" }), now);
    expect(stale.geminiFiveHour.remaining).toBe(84);

    for (const status of ["unavailable", "signed_out"] as const) {
      const missing = buildGeminiCockpitView(sampleQuota({ status }), now);
      expect(missing.geminiFiveHour.remaining).toBeNull();
      expect(missing.geminiWeekly.remaining).toBeNull();
      expect(missing.sharedFiveHour.remaining).toBeNull();
      expect(missing.sharedWeekly.remaining).toBeNull();
    }
  });
});

describe("Gemini capsule geometry", () => {
  it("uses a single-row horizontal double capsule for Gemini alone", () => {
    const layout = resolveCapsuleLayout({
      mode: "gemini",
      codexEnabled: false,
      claudeEnabled: false,
      geminiEnabled: true,
      codexRatio: null,
      claudeRatio: null,
      geminiRatio: 84,
      sharedRatio: 72,
    });
    expect(layout).toEqual(expect.objectContaining({
      shape: "pair-gemini",
      height: SINGLE_CAPSULE_HEIGHT,
    }));
  });

  it.each(["codex", "claude"] as const)("anchors %s companion across all four corners with an empty fourth quadrant", (companion) => {
    const cases: Array<[CapsuleCorner, "top" | "bottom", "left" | "right", CapsuleCorner]> = [
      ["right-bottom", "bottom", "right", "left-top"],
      ["left-bottom", "bottom", "left", "right-top"],
      ["right-top", "top", "right", "left-bottom"],
      ["left-top", "top", "left", "right-bottom"],
    ];
    for (const [corner, geminiRow, companionColumn, emptyQuadrant] of cases) {
      const layout = resolveCapsuleLayout({
        mode: "ai",
        codexEnabled: companion === "codex",
        claudeEnabled: companion === "claude",
        geminiEnabled: true,
        corner,
        codexRatio: 25,
        claudeRatio: 38,
        geminiRatio: 90,
        sharedRatio: 75,
      });
      expect(layout).toEqual(expect.objectContaining({
        shape: "corner-l",
        companion,
        corner,
        geminiRow,
        companionColumn,
        emptyQuadrant,
        height: DOUBLE_CAPSULE_HEIGHT,
      }));
    }
  });

  it("uses a 2x2 quad capsule when all three providers are enabled and preserves legacy capsules when Gemini is off", () => {
    const quad = resolveCapsuleLayout({
      mode: "ai",
      codexEnabled: true,
      claudeEnabled: true,
      geminiEnabled: true,
      codexRatio: 118.8,
      claudeRatio: 42,
      geminiRatio: 88,
      sharedRatio: 64,
    });
    expect(quad).toEqual(expect.objectContaining({
      shape: "quad-all",
      split: 0.5,
      width: 154,
      height: 70,
    }));

    const legacyPair = resolveCapsuleLayout({
      mode: "ai",
      codexEnabled: true,
      claudeEnabled: true,
      geminiEnabled: false,
      codexRatio: 18,
      claudeRatio: 42,
      geminiRatio: 88,
      sharedRatio: 64,
    });
    expect(legacyPair).toEqual(expect.objectContaining({
      shape: "pair-codex-claude",
      height: SINGLE_CAPSULE_HEIGHT,
    }));
  });
});
