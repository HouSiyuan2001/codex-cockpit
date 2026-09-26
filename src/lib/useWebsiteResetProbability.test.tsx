// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWebsiteResetProbability } from "./bridge";
import { currentWebsiteProbability, useWebsiteResetProbability } from "./useWebsiteResetProbability";
import type { WebsiteResetProbability } from "../types";

vi.mock("./bridge", () => ({ fetchWebsiteResetProbability: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const now = new Date("2026-09-11T07:00:00Z");
const sample: WebsiteResetProbability = { level: "elevated", resetChancePercent: 83, episodeId: "episode-a", checkedAt: now.toISOString(), observedAt: "2026-09-11T06:39:40Z", expiresAt: "2026-09-14T07:00:00Z" };

describe("website probability", () => {
  it("rejects expired, stale, future and malformed values without falling back to API hints", () => {
    expect(currentWebsiteProbability(sample, now)?.resetChancePercent).toBe(83);
    expect(currentWebsiteProbability({ ...sample, resetChancePercent: 0 }, now)?.resetChancePercent).toBe(0);
    expect(currentWebsiteProbability({ ...sample, resetChancePercent: null }, now)?.resetChancePercent).toBeNull();
    expect(currentWebsiteProbability(sample, new Date(now.getTime() + 30_000))).toBeNull();
    expect(currentWebsiteProbability({ ...sample, expiresAt: now.toISOString() }, now)).toBeNull();
    expect(currentWebsiteProbability({ ...sample, resetChancePercent: 101 }, now)).toBeNull();
    expect(currentWebsiteProbability({ ...sample, checkedAt: "bad" }, now)).toBeNull();
    expect(currentWebsiteProbability({ ...sample, checkedAt: "2026-09-12T07:00:00Z" }, now)).toBeNull();
  });

  it("polls every ten seconds, updates to the latest ballot, and clears failed reads", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(fetchWebsiteResetProbability).mockResolvedValueOnce(sample);
    const { result, unmount } = renderHook(() => useWebsiteResetProbability());
    await act(async () => {});
    expect(result.current?.resetChancePercent).toBe(83);
    vi.mocked(fetchWebsiteResetProbability).mockImplementationOnce(async () => ({ ...sample, checkedAt: new Date().toISOString(), resetChancePercent: 85 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current?.resetChancePercent).toBe(85);
    vi.mocked(fetchWebsiteResetProbability).mockRejectedValueOnce(new Error("offline"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current).toBeNull();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchWebsiteResetProbability).toHaveBeenCalledTimes(3);
  });

  it("does not overlap a slow request and drops stale data while waiting", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.mocked(fetchWebsiteResetProbability).mockResolvedValueOnce(sample).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useWebsiteResetProbability());
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current).toBeNull();
    expect(fetchWebsiteResetProbability).toHaveBeenCalledTimes(2);
  });
});
