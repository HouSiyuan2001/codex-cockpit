import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGeminiQuota, isTauri } from "../lib/bridge";
import type { GeminiQuota } from "../types";

const GEMINI_REFRESH_MS = 60_000;

export function useGeminiQuota(enabled: boolean) {
  const [quota, setQuota] = useState<GeminiQuota | null>(null);
  const sequence = useRef(0);
  const [shared, setShared] = useState<GeminiQuota | null>(null);
  const refresh = useCallback((manual = false) => {
    if (!enabled) return;
    const current = ++sequence.current;
    void fetchGeminiQuota(manual)
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
    const timer = window.setInterval(refresh, GEMINI_REFRESH_MS);
    return () => {
      ++sequence.current;
      window.clearInterval(timer);
    };
  }, [enabled, refresh]);
  const localReadable = quota?.status === "ok" && Boolean(quota.gemini || quota.claudeGpt);
  useEffect(() => {
    if (!enabled || localReadable || !isTauri()) return;
    let active = true;
    let pending = false;
    async function fetchShared() {
      if (pending) return;
      pending = true;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const rows = await invoke<{ deviceName: string; quota: Pick<GeminiQuota, "observedAt" | "gemini" | "claudeGpt"> }[]>("get_shared_gemini_quota");
        const latest = rows[0];
        if (active) setShared(latest ? { ...latest.quota, status: "stale", plan: null, message: null, sourceDevice: latest.deviceName } : null);
      } catch {
        if (active) setShared(null);
      } finally {
        pending = false;
      }
    }
    void fetchShared();
    const timer = window.setInterval(fetchShared, GEMINI_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); setShared(null); };
  }, [enabled, localReadable]);
  const preferShared = enabled && !localReadable && shared
    && (!quota?.gemini && !quota?.claudeGpt || Date.parse(shared.observedAt ?? "") > Date.parse(quota.observedAt ?? ""));
  return { quota: preferShared ? shared : quota, refresh };
}
