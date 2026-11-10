import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaudeUsage } from "../lib/bridge";
import type { ClaudeUsageReport } from "../types";

const CLAUDE_REFRESH_MS = 60_000;

/** Polls local Claude usage only while a Claude-bearing cockpit is selected; keeps the last good report. */
export function useClaudeUsage(enabled: boolean): { report: ClaudeUsageReport | null; refresh: () => void } {
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    void fetchClaudeUsage()
      .then((next) => { if (current === sequence.current) setReport(next); })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, CLAUDE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);
  return { report, refresh };
}
