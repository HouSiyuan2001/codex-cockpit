import { useCallback, useEffect, useRef, useState } from "react";
import { getProjectUsage, getTokeiUsage } from "./tokeiBridge";
import { withLiveLocalUsage, type ProjectUsageSnapshot, type TokeiUsage } from "./tokeiUsage";

const EMPTY_QUOTA_HISTORY: NonNullable<ProjectUsageSnapshot["quotaHistory"]> = [];

/** Read aggregate-only usage for feedback. Never read conversation text in React. */
export function useComfortUsage(enabled: boolean) {
  const [data, setData] = useState<TokeiUsage | null>(null);
  const [projectUsage, setProjectUsage] = useState<ProjectUsageSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [localDeviceId, setLocalDeviceId] = useState<string | null>(null);
  const alive = useRef(false);
  const pending = useRef<Promise<TokeiUsage> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return pending.current;
    const request = Promise.all([getTokeiUsage(), getProjectUsage().catch(() => null)]).then(([cached, projects]) => {
      const next = withLiveLocalUsage(cached, projects);
      if (alive.current && projects) { setProjectUsage(projects); setLocalDeviceId(projects.deviceId); }
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
    const timer = window.setInterval(() => { void refresh().catch(() => undefined); }, 60_000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [enabled, refresh]);
  useEffect(() => {
    if (!enabled || (projectUsage && !projectUsage.warnings.includes("scan_limit"))) return;
    const timer = window.setTimeout(() => { void refresh().catch(() => undefined); }, 1_000);
    return () => window.clearTimeout(timer);
  }, [enabled, projectUsage, data, refresh]);
  return { data, error, refresh, localDeviceId, quotaHistory: projectUsage?.quotaHistory ?? EMPTY_QUOTA_HISTORY };
}
