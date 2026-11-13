import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClaudeResetForecast } from "../lib/bridge";
import type { ClaudeResetForecast } from "../types";

const POLL_MS = 60_000;

export function useClaudeResets(enabled: boolean, plan: string | null) {
  const [result, setResult] = useState<{ plan: string | null; forecast: ClaudeResetForecast } | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    const current = ++sequence.current;
    void fetchClaudeResetForecast(plan).then((forecast) => {
      if (forecast && current === sequence.current) setResult({ plan, forecast });
    }).catch(() => undefined);
  }, [enabled, plan]);
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => { ++sequence.current; window.clearInterval(timer); };
  }, [enabled, refresh]);
  return { forecast: enabled && result?.plan === plan ? result.forecast : null, refresh };
}
