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

/** Polls Claude quota and local usage only while a Claude-bearing cockpit is selected; keeps the last answers. */
export function useClaudeUsage(enabled: boolean): { report: ClaudeUsageReport | null; quota: ClaudeQuota | null; baseline: ClaudeDayBaseline | null; refresh: () => void } {
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const [quota, setQuota] = useState<ClaudeQuota | null>(null);
  const [baseline, setBaseline] = useState<ClaudeDayBaseline | null>(() => readBaseline());
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    void fetchClaudeUsage()
      .then((next) => { if (current === sequence.current) setReport(next); })
      .catch(() => undefined);
    void fetchClaudeQuota()
      .then((next) => {
        if (current !== sequence.current) return;
        setQuota(next);
        setBaseline((previous) => {
          const updated = nextClaudeDayBaseline(previous, next);
          if (updated && updated !== previous) writeBaseline(updated);
          return updated;
        });
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, CLAUDE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);
  return { report, quota, baseline, refresh };
}
