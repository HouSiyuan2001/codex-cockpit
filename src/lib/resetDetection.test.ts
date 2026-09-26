import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../types";
import { detectRecentCodexReset, isRecentCodexReset } from "./resetDetection";

function codex(remainingPercent: number, resetsAt: string, resetCredits = 0): ProviderSnapshot {
  return {
    provider: "codex",
    displayName: "CODEX",
    plan: "PRO",
    shortWindow: null,
    weeklyWindow: { remainingPercent, resetsAt, windowSeconds: 604_800 },
    resetCredits,
    updatedAt: "2026-07-18T02:00:00Z",
    status: "ok",
    message: null,
  };
}

describe("recent Codex reset detection", () => {
  const now = new Date("2026-07-18T02:00:00Z");

  it("detects a weekly window that started recently", () => {
    const value = detectRecentCodexReset(codex(100, "2026-07-25T01:00:00Z"), null, now);
    expect(value).toEqual({
      detectedAt: "2026-07-18T01:00:00.000Z",
      resetAt: "2026-07-18T01:00:00.000Z",
      source: "window",
    });
  });

  it("detects an observed recovery when the next reset advances", () => {
    const previous = codex(8, "2026-07-18T03:00:00Z");
    const current = codex(96, "2026-07-25T03:00:00Z");
    expect(detectRecentCodexReset(current, previous, now)?.source).toBe("observed");
  });

  it("detects a reset credit being consumed when quota recovers", () => {
    const previous = codex(6, "2026-07-22T00:00:00Z", 1);
    const current = codex(100, "2026-07-22T00:00:00Z", 0);
    expect(detectRecentCodexReset(current, previous, now)).toMatchObject({
      source: "observed",
      resetAt: "2026-07-18T02:00:00.000Z",
    });
  });

  it("uses Codex's own recovered percentage even when reset metadata is unchanged", () => {
    const resetsAt = "2026-07-22T00:00:00Z";
    expect(detectRecentCodexReset(codex(100, resetsAt, 0), codex(95, resetsAt, 0), now)).toMatchObject({
      source: "observed",
      resetAt: "2026-07-18T02:00:00.000Z",
    });
  });

  it("does not confuse normal consumption with a reset", () => {
    expect(detectRecentCodexReset(codex(61, "2026-07-22T00:00:00Z"), codex(64, "2026-07-22T00:00:00Z"), now)).toBeNull();
  });

  it("expires the recent marker after six hours", () => {
    expect(isRecentCodexReset({ detectedAt: "2026-07-18T00:00:00Z", resetAt: "2026-07-18T00:00:00Z", source: "observed" }, now)).toBe(true);
    expect(isRecentCodexReset({ detectedAt: "2026-07-17T19:00:00Z", resetAt: "2026-07-17T19:00:00Z", source: "observed" }, now)).toBe(false);
  });

});
