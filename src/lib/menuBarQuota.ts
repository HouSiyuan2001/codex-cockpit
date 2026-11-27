import type { ProviderSnapshot } from "../types";
import type { ClaudeCockpitView } from "./claudeCockpit";
import type { GeminiCockpitView } from "./geminiCockpit";
import { fiveHourWindow } from "./plusQuota";

interface Quota {
  weekly: number | null;
  fiveHour: number | null;
}

export interface MenuBarQuotas {
  codex: Quota | null;
  claude: Quota | null;
  gemini: Quota | null;
  geminiShared: Quota | null;
}

export function menuBarQuotas(
  enabled: { codex: boolean; claude: boolean; gemini: boolean },
  codex: ProviderSnapshot | undefined,
  claude: ClaudeCockpitView,
  gemini: GeminiCockpitView,
  now: Date,
): MenuBarQuotas {
  const remaining = (window: ProviderSnapshot["shortWindow"] | undefined) =>
    window && !(Date.parse(window.resetsAt ?? "") <= now.getTime()) ? window.remainingPercent : null;
  return {
    codex: enabled.codex ? {
      weekly: remaining(codex?.weeklyWindow),
      fiveHour: remaining(codex ? fiveHourWindow(codex) : null),
    } : null,
    claude: enabled.claude ? {
      weekly: claude.weeklyRemaining,
      fiveHour: claude.fiveHourUsed === null ? null : 100 - claude.fiveHourUsed,
    } : null,
    gemini: enabled.gemini ? {
      weekly: gemini.geminiWeekly.remaining,
      fiveHour: gemini.geminiFiveHour.remaining,
    } : null,
    geminiShared: enabled.gemini ? {
      weekly: gemini.sharedWeekly.remaining,
      fiveHour: gemini.sharedFiveHour.remaining,
    } : null,
  };
}
