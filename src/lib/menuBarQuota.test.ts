import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../types";
import { buildClaudeCockpitView } from "./claudeCockpit";
import { buildGeminiCockpitView } from "./geminiCockpit";
import { menuBarQuotas } from "./menuBarQuota";

const now = new Date("2026-11-26T12:00:00Z");
const codex: ProviderSnapshot = {
  provider: "codex",
  displayName: "Codex",
  plan: "Pro",
  resetCredits: null,
  message: null,
  status: "ok",
  updatedAt: now.toISOString(),
  shortWindow: { remainingPercent: 42, windowSeconds: 18_000, resetsAt: "2026-11-26T13:00:00Z" },
  weeklyWindow: { remainingPercent: 70, windowSeconds: 604_800, resetsAt: "2026-11-30T12:00:00Z" },
};
const claude = buildClaudeCockpitView({
  status: "ok", message: null, plan: "max", observedAt: now.toISOString(),
  sevenDay: { usedPercent: 25, resetsAt: null },
  fiveHour: { usedPercent: 90, resetsAt: null },
  sevenDayOpus: null, sevenDaySonnet: null,
}, now);
const gemini = buildGeminiCockpitView({
  status: "ok", message: null, plan: "pro", observedAt: now.toISOString(),
  gemini: { weekly: { remainingPercent: 91, resetsAt: null }, fiveHour: { remainingPercent: 0, resetsAt: null } },
  claudeGpt: { weekly: { remainingPercent: 58, resetsAt: null }, fiveHour: { remainingPercent: 80, resetsAt: null } },
}, now);

describe("menu bar quota", () => {
  it("uses five-hour remaining for each enabled pool, including non-Plus Codex", () => {
    expect(menuBarQuotas({ codex: true, claude: true, gemini: true }, codex, claude, gemini, now)).toEqual({
      codex: { weekly: 70, fiveHour: 42 },
      claude: { weekly: 75, fiveHour: 10 },
      gemini: { weekly: 91, fiveHour: 0 },
      geminiShared: { weekly: 58, fiveHour: 80 },
    });
  });

  it("uses the weekly reading for a Codex plan without a five-hour window", () => {
    expect(menuBarQuotas({ codex: true, claude: false, gemini: false }, {
      ...codex, shortWindow: null,
    }, claude, gemini, now).codex).toEqual({ weekly: 70, fiveHour: null, showWeekly: true });
  });

  it("falls back to weekly at reset and excludes disabled providers", () => {
    const next = new Date("2026-11-26T13:00:00Z");
    expect(menuBarQuotas({ codex: true, claude: false, gemini: false }, codex, claude, gemini, next)).toEqual({
      codex: { weekly: 70, fiveHour: null, showWeekly: true },
      claude: null, gemini: null, geminiShared: null,
    });
  });
});
