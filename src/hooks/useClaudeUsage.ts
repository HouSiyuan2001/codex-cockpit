import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaudeQuota, fetchClaudeUsage } from "../lib/bridge";
import { nextClaudeDayBaseline, type ClaudeDayBaseline } from "../lib/claudeCockpit";
import type { ClaudeQuota, ClaudeUsageReport } from "../types";

const CLAUDE_REFRESH_MS = 60_000;
const BASELINE_KEY = "claude-day-baseline";

function readBaseline(): ClaudeDayBaseline | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(BASELINE_KEY) ?? "null") as ClaudeDayBaseline | null;
    return value && typeof value.localDate === "string" && Number.isFinite(value.weeklyUsedPercent) ? value : null;
  } catch {
    return null;
  }
}

function writeBaseline(value: ClaudeDayBaseline): void {
  try { window.localStorage.setItem(BASELINE_KEY, JSON.stringify(value)); } catch { /* storage unavailable: keep in memory */ }
}

export function useClaudeUsage(enabled: boolean, days = 35) {
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    const current = ++sequence.current;
    void fetchClaudeUsage(days)
      .then((next) => { if (current === sequence.current) setReport(next); })
      .catch(() => undefined);
  }, [days, enabled]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, CLAUDE_REFRESH_MS);
    return () => { ++sequence.current; window.clearInterval(timer); };
  }, [enabled, refresh]);
  return { report, refresh };
}

export function useClaudeQuota(enabled: boolean) {
  const [quota, setQuota] = useState<ClaudeQuota | null>(null);
  const [baseline, setBaseline] = useState<ClaudeDayBaseline | null>(() => readBaseline());
  const sequence = useRef(0);
  const refresh = useCallback((manual = false) => {
    if (!enabled) return;
    const current = ++sequence.current;
    void fetchClaudeQuota(manual)
      .then((next) => {
        if (current !== sequence.current) return;
        setQuota(next);
        setBaseline((previous) => {
          const updated = nextClaudeDayBaseline(previous, next);
          if (updated && updated !== previous) writeBaseline(updated);
          return updated;
        });
      })
      .catch(() => {
        if (current !== sequence.current) return;
        setQuota((previous) => previous?.status === "ok" ? { ...previous, status: "stale" } : previous);
      });
  }, [enabled]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, CLAUDE_REFRESH_MS);
    return () => { ++sequence.current; window.clearInterval(timer); };
  }, [enabled, refresh]);
  return { quota, baseline, refresh };
}
