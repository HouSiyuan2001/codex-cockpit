import { clampPercent } from "./format";
import { trackedQuotaWindows } from "./quotaPace";
import type { ProviderId, ProviderSnapshot, QuotaHistoryPoint } from "../types";

export function snapshotRemainingPercent(snapshot: ProviderSnapshot | undefined): number | null {
  if (!snapshot) return null;
  const windows = trackedQuotaWindows(snapshot);
  return windows.length > 0
    ? Math.min(...windows.map(({ window }) => clampPercent(window.remainingPercent)))
    : null;
}

function riskRank(snapshot: ProviderSnapshot | undefined): number {
  if (!snapshot) return 0;
  if (snapshot.status === "signed_out") return 1;
  if (snapshot.status === "unavailable") return 2;
  if (snapshot.status === "stale") return 3;
  if (snapshot.status === "loading") return 4;
  const remaining = snapshotRemainingPercent(snapshot);
  return remaining === null ? 10_000 : 100 + remaining;
}

export function sortProviderIdsByRisk(
  providerIds: ProviderId[],
  snapshots: ProviderSnapshot[],
): ProviderId[] {
  const byProvider = new Map(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
  return providerIds
    .map((provider, index) => ({ provider, index, rank: riskRank(byProvider.get(provider)) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ provider }) => provider);
}

export function recentPercentageHistory(
  history: QuotaHistoryPoint[],
  provider: ProviderId,
  limit = 12,
): number[] {
  return history
    .filter((point) => point.provider === provider && point.metricKind === "percent" && point.metric !== null)
    .slice(-Math.max(2, limit))
    .map((point) => clampPercent(point.metric!));
}
