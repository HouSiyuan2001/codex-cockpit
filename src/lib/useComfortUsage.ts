import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectUsage, getTokeiUsage } from "./tokeiBridge";
import type { TokeiUsage } from "./tokeiUsage";

/** Read aggregate-only usage for feedback. Never read conversation text in React. */
export function useComfortUsage(enabled: boolean) {
  const [data, setData] = useState<TokeiUsage | null>(null);
  const [error, setError] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const alive = useRef(false);
  const pending = useRef<Promise<TokeiUsage> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const request = getTokeiUsage().then(next => {
      if (alive.current) { setData(next); setError(false); }
      return next;
    }).catch((reason: unknown) => {
      if (alive.current) setError(true);
      throw reason;
    }).finally(() => { if (pending.current === request) pending.current = null; });
    pending.current = request;
    return request;
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return () => { alive.current = false; };
    void refresh().catch(() => undefined);
    void getProjectUsage().then(snapshot => { if (alive.current) setLocalDeviceId(snapshot.deviceId); }).catch(() => undefined);
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 60_000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [enabled, refresh]);
  return { data, error, refresh, localDeviceId };
}
