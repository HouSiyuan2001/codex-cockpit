import type { ProviderSnapshot } from "../types";

export const RECENT_CODEX_RESET_MS = 6 * 60 * 60_000;
const RESET_RECOVERY_TOLERANCE_PERCENT = 0.5;

export interface RecentCodexReset {
  detectedAt: string;
  resetAt: string;
  source: "window" | "observed";
}

function windowStartedAt(snapshot: ProviderSnapshot): number | null {
  const window = snapshot.weeklyWindow;
  if (!window?.resetsAt || !Number.isFinite(window.windowSeconds) || window.windowSeconds <= 0) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;
  return resetsAt - window.windowSeconds * 1000;
}

export function detectRecentCodexReset(
  current: ProviderSnapshot,
  previous: ProviderSnapshot | null,
  now = new Date(),
): RecentCodexReset | null {
  if (current.provider !== "codex" || current.status !== "ok" || !current.weeklyWindow) return null;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;

  const currentStart = windowStartedAt(current);
  const currentRemaining = current.weeklyWindow.remainingPercent;
  const previousRemaining = previous?.provider === "codex" ? previous.weeklyWindow?.remainingPercent : undefined;
  const recovered = previousRemaining !== undefined
    && currentRemaining - previousRemaining > RESET_RECOVERY_TOLERANCE_PERCENT;

  if (recovered) {
    const currentStartAge = currentStart === null ? Number.POSITIVE_INFINITY : nowMs - currentStart;
    const resetAt = currentStart !== null && currentStartAge >= -2 * 60_000 && currentStartAge <= RECENT_CODEX_RESET_MS
      ? currentStart
      : nowMs;
    return { detectedAt: now.toISOString(), resetAt: new Date(resetAt).toISOString(), source: "observed" };
  }

  if (currentStart !== null) {
    const age = nowMs - currentStart;
    if (age >= -2 * 60_000 && age <= RECENT_CODEX_RESET_MS) {
      const resetAt = new Date(currentStart).toISOString();
      return { detectedAt: resetAt, resetAt, source: "window" };
    }
  }
  return null;
}

export function isRecentCodexReset(value: RecentCodexReset | null, now = new Date()): value is RecentCodexReset {
  if (!value) return false;
  const resetAt = Date.parse(value.resetAt);
  const age = now.getTime() - resetAt;
  return Number.isFinite(resetAt) && age >= -2 * 60_000 && age <= RECENT_CODEX_RESET_MS;
}
