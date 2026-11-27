import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaudeQuota, fetchClaudeUsage, fetchGeminiUsage, fetchSharedClaudeQuota } from "../lib/bridge";
import type { ClaudeQuota, ClaudeUsageReport, SharedClaudeQuota } from "../types";

const CLAUDE_REFRESH_MS = 60_000;

/** Only used when upgrading an existing installation before the first tracked day. */
export function readLegacyClaudeBaseline(): { localDate: string; weeklyUsedPercent: number } | null {
  try { return JSON.parse(window.localStorage.getItem("claude-day-baseline") ?? "null"); }
  catch { return null; }
}

export function useLocalProviderUsage(enabled: boolean, days = 35, provider: "claude" | "gemini" = "claude") {
  const [report, setReport] = useState<ClaudeUsageReport | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    const current = ++sequence.current;
    void (provider === "gemini" ? fetchGeminiUsage : fetchClaudeUsage)(days)
      .then((next) => { if (current === sequence.current) setReport(next); })
      .catch(() => undefined);
  }, [days, enabled, provider]);
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

type SharedQuotaReading = {
  status: "loading" | "ready" | "disconnected" | "error";
  snapshot: SharedClaudeQuota | null;
};

const LOADING_SHARED_QUOTA: SharedQuotaReading = { status: "loading", snapshot: null };

export function useSharedClaudeQuota(enabled: boolean) {
  const [reading, setReading] = useState(LOADING_SHARED_QUOTA);
  const refreshRef = useRef<(() => void) | null>(null);
  const refresh = useCallback(() => refreshRef.current?.(), []);

  useEffect(() => {
    if (!enabled) {
      setReading(LOADING_SHARED_QUOTA);
      return;
    }

    let active = true;
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const rows = await fetchSharedClaudeQuota();
        const snapshot = rows.reduce<SharedClaudeQuota | null>((latest, candidate) =>
          !latest || Date.parse(candidate.quota.observedAt) > Date.parse(latest.quota.observedAt) ? candidate : latest, null);
        if (active) setReading({ status: "ready", snapshot });
      } catch (error) {
        if (active) setReading({
          status: error === "cloud_not_connected" ? "disconnected" : "error",
          snapshot: null,
        });
      } finally {
        pending = false;
      }
    }

    refreshRef.current = () => void load();
    refreshRef.current();
    const timer = window.setInterval(refreshRef.current, CLAUDE_REFRESH_MS);
    return () => {
      active = false;
      refreshRef.current = null;
      window.clearInterval(timer);
    };
  }, [enabled]);

  return { ...(enabled ? reading : LOADING_SHARED_QUOTA), refresh };
}
