import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaudeQuota, fetchClaudeUsage } from "../lib/bridge";
import type { ClaudeQuota, ClaudeUsageReport } from "../types";

const CLAUDE_REFRESH_MS = 60_000;

/** Only used when upgrading an existing installation before the first tracked day. */
export function readLegacyClaudeBaseline(): { localDate: string; weeklyUsedPercent: number } | null {
  try { return JSON.parse(window.localStorage.getItem("claude-day-baseline") ?? "null"); }
  catch { return null; }
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
  const sequence = useRef(0);
  const refresh = useCallback((manual = false) => {
    if (!enabled) return;
    const current = ++sequence.current;
    void fetchClaudeQuota(manual)
      .then((next) => {
        if (current !== sequence.current) return;
        setQuota(next);
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
  return { quota, refresh };
}
