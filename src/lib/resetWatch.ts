import type { Language, ResetForecast, ResetWatch } from "../types";

// Two existing 5-minute background checks. Never leave a stale alert lit forever.
export const RESET_WATCH_MAX_AGE_MS = 10 * 60_000;
const CLOCK_TOLERANCE_MS = 5 * 60_000;

export function activeResetWatch(forecast: ResetForecast | null | undefined, now = new Date()): ResetWatch | null {
  const watch = forecast?.activeWatch;
  if (!watch || !forecast?.watchCheckedAt) return null;
  const current = now.getTime();
  const checked = Date.parse(forecast.watchCheckedAt);
  const observed = Date.parse(watch.observedAt);
  const expires = Date.parse(watch.expiresAt);
  if (![current, checked, observed, expires].every(Number.isFinite)
    || checked > current + CLOCK_TOLERANCE_MS
    || current - checked >= RESET_WATCH_MAX_AGE_MS
    || observed > current + CLOCK_TOLERANCE_MS
    || expires <= current || expires <= observed
    || (watch.signalKind !== undefined && watch.signalKind !== "watch" && watch.signalKind !== "scheduled")
    || (watch.level !== "elevated" && watch.level !== "strong")
    || (watch.resetChancePercent !== null && (!Number.isInteger(watch.resetChancePercent) || watch.resetChancePercent < 0 || watch.resetChancePercent > 100))) return null;
  return watch;
}

export function resetWatchLabel(watch: ResetWatch, language: Language): string {
  if (watch.signalKind === "claude-announcement") {
    return language === "en" ? "Claude reset announcement" : "Claude 重置公告";
  }
  if (watch.signalKind === "scheduled") {
    return language === "en" ? "Reset announced · scheduled time · tracked by codex-resets.com" : "重置已宣布 · 预计时间 · codex-resets.com 跟踪";
  }
  const strength = watch.level === "strong" ? (language === "en" ? "strong signal" : "较强信号") : (language === "en" ? "elevated signal" : "关注信号");
  return language === "en" ? `Reset Watch · ${strength} · third-party forecast` : `重置预警 · ${strength} · 第三方预测`;
}
