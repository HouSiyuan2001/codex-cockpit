import type { ProviderSnapshot, UsageWindow } from "../types";

export function isCodexPlus(snapshot: ProviderSnapshot): boolean {
  return snapshot.provider === "codex" && ["plus", "chatgpt plus", "chatgpt_plus", "chatgpt-plus"].includes(snapshot.plan?.trim().toLowerCase() ?? "");
}

export function fiveHourWindow(snapshot: ProviderSnapshot): UsageWindow | null {
  const window = snapshot.shortWindow;
  return window?.windowSeconds === 18_000 && Number.isFinite(window.remainingPercent) ? window : null;
}

export function fiveHourRemaining(snapshot: ProviderSnapshot): number | null {
  const window = fiveHourWindow(snapshot);
  return window ? Math.min(100, Math.max(0, window.remainingPercent)) : null;
}
