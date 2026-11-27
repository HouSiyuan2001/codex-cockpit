import type { CapsuleCorner, CockpitMode, GeminiQuota, GeminiQuotaWindow, WidgetPreferences } from "../types";

export const SINGLE_CAPSULE_HEIGHT = 40;
export const DOUBLE_CAPSULE_HEIGHT = 79;
const QUAD_CAPSULE_HEIGHT = 70;

export interface GeminiWindowView {
  remaining: number | null;
  resetsAt: string | null;
  awaitingRefresh: boolean;
}

export interface GeminiCockpitView {
  quotaStatus: GeminiQuota["status"];
  quotaMessage: string | null;
  plan: string | null;
  sourceDevice?: string;
  geminiFiveHour: GeminiWindowView;
  geminiWeekly: GeminiWindowView;
  sharedFiveHour: GeminiWindowView;
  sharedWeekly: GeminiWindowView;
}

const EMPTY_WINDOW: GeminiWindowView = {
  remaining: null,
  resetsAt: null,
  awaitingRefresh: false,
};

function buildWindowView(window: GeminiQuotaWindow | null | undefined, readable: boolean, now: Date): GeminiWindowView {
  if (!readable || !window || !Number.isFinite(window.remainingPercent)) return EMPTY_WINDOW;
  const resetMs = Date.parse(window.resetsAt ?? "");
  // Antigravity can report the Unix epoch as a placeholder for an unknown reset.
  const knownReset = Number.isFinite(resetMs) && resetMs !== 0;
  if (knownReset && resetMs <= now.getTime()) {
    return {
      remaining: null,
      resetsAt: null,
      awaitingRefresh: true,
    };
  }
  return {
    remaining: Math.round(Math.max(0, Math.min(100, window.remainingPercent))),
    resetsAt: knownReset ? window.resetsAt : null,
    awaitingRefresh: false,
  };
}

export function buildGeminiCockpitView(quota: GeminiQuota | null, now = new Date()): GeminiCockpitView {
  const readable = quota?.status === "ok" || quota?.status === "stale";
  return {
    quotaStatus: quota?.status ?? "loading",
    quotaMessage: quota?.message ?? null,
    plan: quota?.plan ?? null,
    sourceDevice: quota?.sourceDevice,
    geminiFiveHour: buildWindowView(quota?.gemini?.fiveHour, readable, now),
    geminiWeekly: buildWindowView(quota?.gemini?.weekly, readable, now),
    sharedFiveHour: buildWindowView(quota?.claudeGpt?.fiveHour, readable, now),
    sharedWeekly: buildWindowView(quota?.claudeGpt?.weekly, readable, now),
  };
}

export function geminiFiveHourUsedPercent(remaining: number | null): number | null {
  return remaining === null || !Number.isFinite(remaining) ? null : Math.round(Math.max(0, Math.min(100, 100 - remaining)));
}

export function normalizeCapsuleCorner(value: unknown): CapsuleCorner {
  return value === "left-bottom" || value === "right-top" || value === "left-top" || value === "right-bottom"
    ? value
    : "right-bottom";
}

export function enabledProviderFlags(preferences: Pick<WidgetPreferences, "codexEnabled" | "claudeEnabled" | "geminiEnabled">) {
  const claude = preferences.claudeEnabled === true;
  const gemini = preferences.geminiEnabled === true;
  const codex = preferences.codexEnabled !== false || (!claude && !gemini);
  return { codex, claude, gemini };
}

export function enabledCockpitModes(preferences: Pick<WidgetPreferences, "codexEnabled" | "claudeEnabled" | "geminiEnabled">): CockpitMode[] {
  const { codex, claude, gemini } = enabledProviderFlags(preferences);
  const singles: CockpitMode[] = [];
  if (codex) singles.push("codex");
  if (claude) singles.push("claude");
  if (gemini) singles.push("gemini");
  if (singles.length >= 2) singles.push("ai");
  return singles.length > 0 ? singles : ["codex"];
}

export function effectiveCockpitMode(preferences: Pick<WidgetPreferences, "cockpitMode" | "codexEnabled" | "claudeEnabled" | "geminiEnabled">): CockpitMode {
  const modes = enabledCockpitModes(preferences);
  return modes.includes(preferences.cockpitMode) ? preferences.cockpitMode : modes[0];
}

export function compactPercentLabel(value: number | null): string {
  return value === null ? "—" : String(Math.round(Math.max(0, value)));
}

export function capsuleCellLogicalWidth(ratio: number | null, fontScale = 1.15): number {
  const scale = Number.isFinite(fontScale) ? Math.min(2, Math.max(1.15, fontScale)) : 1.15;
  const label = compactPercentLabel(ratio);
  const suffix = ratio === null ? 0 : 7;
  return Math.ceil(49 + (label.length * 10 + suffix) * scale);
}

function singlePillLogicalWidth(ratio: number | null, fontScale = 1.15): number {
  if (ratio === null) return 88;
  const label = `${compactPercentLabel(ratio)}%`;
  const scale = Number.isFinite(fontScale) ? Math.min(2, Math.max(1, fontScale)) : 1.15;
  return Math.ceil(Math.min(196, Math.max(88, 88 + Math.max(0, label.length - 3) * 10 * scale)));
}

function twoColumnGeometry(leftWidth: number, rightWidth: number) {
  const total = leftWidth + rightWidth;
  const width = Math.min(320, total);
  const split = (width * (leftWidth / total) - 1) / Math.max(1, width - 2);
  return { width, split };
}

export type ResolvedCapsuleLayout =
  | { shape: "single-codex"; width: number; height: number }
  | { shape: "single-claude"; width: number; height: number }
  | { shape: "pair-codex-claude"; width: number; height: number; split: number }
  | { shape: "pair-gemini"; width: number; height: number; split: number }
  | {
      shape: "corner-l";
      companion: "codex" | "claude";
      corner: CapsuleCorner;
      geminiRow: "top" | "bottom";
      companionColumn: "left" | "right";
      emptyQuadrant: CapsuleCorner;
      width: number;
      height: number;
      split: number;
    }
  | { shape: "quad-all"; width: number; height: number; split: number };

export function geminiCornerPlacement(value?: CapsuleCorner) {
  const corner = normalizeCapsuleCorner(value);
  const geminiRow: "top" | "bottom" = corner.endsWith("-bottom") ? "bottom" : "top";
  const companionColumn: "left" | "right" = corner.startsWith("left-") ? "left" : "right";
  const emptyQuadrant: CapsuleCorner = `${companionColumn === "left" ? "right" : "left"}-${geminiRow === "bottom" ? "top" : "bottom"}`;
  return { corner, geminiRow, companionColumn, emptyQuadrant };
}

export function resolveCapsuleLayout(input: {
  mode: CockpitMode;
  codexEnabled?: boolean;
  claudeEnabled?: boolean;
  geminiEnabled?: boolean;
  corner?: CapsuleCorner;
  codexRatio: number | null;
  claudeRatio: number | null;
  geminiRatio: number | null;
  sharedRatio: number | null;
  fontScale?: number;
}): ResolvedCapsuleLayout {
  const { codex, claude, gemini } = enabledProviderFlags({
    codexEnabled: input.codexEnabled,
    claudeEnabled: input.claudeEnabled ?? false,
    geminiEnabled: input.geminiEnabled,
  });
  const mode = effectiveCockpitMode({
    cockpitMode: input.mode,
    codexEnabled: codex,
    claudeEnabled: claude,
    geminiEnabled: gemini,
  });
  const scale = input.fontScale ?? 1.15;

  if (mode === "codex") {
    return { shape: "single-codex", width: singlePillLogicalWidth(input.codexRatio, scale), height: SINGLE_CAPSULE_HEIGHT };
  }
  if (mode === "claude") {
    return { shape: "single-claude", width: singlePillLogicalWidth(input.claudeRatio, scale), height: SINGLE_CAPSULE_HEIGHT };
  }
  if (mode === "gemini") {
    const g1 = capsuleCellLogicalWidth(input.geminiRatio, scale);
    const g2 = capsuleCellLogicalWidth(input.sharedRatio, scale);
    const { width, split } = twoColumnGeometry(g1, g2);
    return { shape: "pair-gemini", width, height: SINGLE_CAPSULE_HEIGHT, split };
  }

  // mode === "ai": combine the enabled providers.
  if (!gemini) {
    const c1 = capsuleCellLogicalWidth(input.codexRatio, scale);
    const c2 = capsuleCellLogicalWidth(input.claudeRatio, scale);
    const { width, split } = twoColumnGeometry(c1, c2);
    return { shape: "pair-codex-claude", width, height: SINGLE_CAPSULE_HEIGHT, split };
  }

  const g1 = capsuleCellLogicalWidth(input.geminiRatio, scale);
  const g2 = capsuleCellLogicalWidth(input.sharedRatio, scale);

  if (codex && claude) {
    const c1 = capsuleCellLogicalWidth(input.codexRatio, scale);
    const c2 = capsuleCellLogicalWidth(input.claudeRatio, scale);
    const columnWidth = Math.max(g1, g2, c1, c2, capsuleCellLogicalWidth(100, scale));
    // Four-cell readouts have a smaller ring, gap, and side padding.
    const compactColumnWidth = columnWidth - 15;
    const { width, split } = twoColumnGeometry(compactColumnWidth, compactColumnWidth);
    return { shape: "quad-all", width, height: QUAD_CAPSULE_HEIGHT, split };
  }

  const companion: "codex" | "claude" = claude ? "claude" : "codex";
  const companionWidth = capsuleCellLogicalWidth(companion === "claude" ? input.claudeRatio : input.codexRatio, scale);
  const placement = geminiCornerPlacement(input.corner);
  const { companionColumn } = placement;
  const col1 = companionColumn === "left" ? Math.max(g1, companionWidth) : g1;
  const col2 = companionColumn === "right" ? Math.max(g2, companionWidth) : g2;
  const { width, split } = twoColumnGeometry(col1, col2);

  return {
    shape: "corner-l",
    companion,
    ...placement,
    width,
    height: DOUBLE_CAPSULE_HEIGHT,
    split,
  };
}
