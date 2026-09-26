import { describe, expect, it } from "vitest";
import type { ProviderSnapshot, QuotaHistoryPoint } from "../types";
import { recentPercentageHistory, snapshotRemainingPercent, sortProviderIdsByRisk } from "./providerPresentation";

const snapshot = (provider: ProviderSnapshot["provider"], remaining: number, status: ProviderSnapshot["status"] = "ok"): ProviderSnapshot => ({
  provider,
  displayName: provider.toUpperCase(),
  plan: null,
  shortWindow: { remainingPercent: remaining, resetsAt: null, windowSeconds: 18_000 },
  weeklyWindow: null,
  resetCredits: null,
  updatedAt: "2026-08-06T00:00:00Z",
  status,
  message: null,
});

describe("provider presentation", () => {
  it("uses the most constrained reported quota window", () => {
    const value = { ...snapshot("codex", 70), weeklyWindow: { remainingPercent: 18, resetsAt: null, windowSeconds: 604_800 } };
    expect(snapshotRemainingPercent(value)).toBe(18);
  });

  it("sorts attention states first, then healthy providers by remaining quota", () => {
    const ids = ["codex", "qoder", "trae", "workbuddy"] as const;
    const values = [
      snapshot("codex", 80),
      snapshot("qoder", 12),
      snapshot("trae", 50, "signed_out"),
      snapshot("workbuddy", 25, "stale"),
    ];
    expect(sortProviderIdsByRisk([...ids], values)).toEqual(["trae", "workbuddy", "qoder", "codex"]);
  });

  it("returns a bounded percentage-only history trail", () => {
    const history: QuotaHistoryPoint[] = [
      { provider: "codex", capturedAt: "2026-08-06T00:00:00Z", metric: 92, metricKind: "percent", status: "ok", resetsAt: null },
      { provider: "qoder", capturedAt: "2026-08-06T00:01:00Z", metric: 500, metricKind: "balance", status: "ok", resetsAt: null },
      { provider: "codex", capturedAt: "2026-08-06T00:02:00Z", metric: 76, metricKind: "percent", status: "ok", resetsAt: null },
    ];
    expect(recentPercentageHistory(history, "codex")).toEqual([92, 76]);
    expect(recentPercentageHistory(history, "qoder")).toEqual([]);
  });
});
