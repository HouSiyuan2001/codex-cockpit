import { useEffect, useState } from "react";
import type { WebsiteResetProbability } from "../types";
import { fetchWebsiteResetProbability } from "./bridge";
import { activeResetWatch } from "./resetWatch";

export const WEBSITE_PROBABILITY_REFRESH_MS = 10_000;
export const WEBSITE_PROBABILITY_MAX_AGE_MS = 30_000;

export function currentWebsiteProbability(value: WebsiteResetProbability | null, now = new Date()): WebsiteResetProbability | null {
  if (!value?.episodeId || !value.checkedAt || now.getTime() - Date.parse(value.checkedAt) >= WEBSITE_PROBABILITY_MAX_AGE_MS) return null;
  const valid = activeResetWatch({ activeWatch: value, watchCheckedAt: value.checkedAt, score: 0, windowHours: 0, fetchedAt: value.checkedAt, resetAnnounced: false, sourceUrl: "https://codex-resets.com/" }, now);
  return valid ? value : null;
}

/** Poll the site's public watch signal. No requests submit votes or user data. */
export function useWebsiteResetProbability() {
  const [value, setValue] = useState<WebsiteResetProbability | null>(null);
  useEffect(() => {
    let active = true;
    let busy = false;
    async function refresh() {
      if (busy || !active) return;
      busy = true;
      try {
        const next = await fetchWebsiteResetProbability();
        if (active) setValue(currentWebsiteProbability(next));
      } catch { if (active) setValue(null); }
      finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(() => {
      setValue(current => currentWebsiteProbability(current));
      void refresh();
    }, WEBSITE_PROBABILITY_REFRESH_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  return value;
}
