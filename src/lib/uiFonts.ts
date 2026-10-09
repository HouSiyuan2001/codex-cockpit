import type { WidgetFontFamily } from "../types";

// Match the Codex desktop app's default UI stack. The OS supplies CJK fallbacks.
export const UI_FONT_STACKS: Record<WidgetFontFamily, string> = {
  codex: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  smiley: '"Smiley Sans", "得意黑", "Quota Sans", "Segoe UI", system-ui, sans-serif',
};

export function normalizeFontFamily(value: unknown): WidgetFontFamily {
  return value === "codex" || value === "yahei" ? value : "smiley";
}
