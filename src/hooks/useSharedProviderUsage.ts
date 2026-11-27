import { useEffect, useState } from "react";
import { isTauri } from "../lib/bridge";
import type { SharedProviderUsage } from "../lib/claudeUsageRows";

const EMPTY: SharedProviderUsage[] = [];

export function useSharedProviderUsage(enabled: boolean) {
  const [rows, setRows] = useState(EMPTY);
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const next = await invoke<SharedProviderUsage[]>("get_shared_provider_usage");
        if (active) setRows(next);
      } catch {
        if (active) setRows(EMPTY);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [enabled]);
  return enabled ? rows : EMPTY;
}
