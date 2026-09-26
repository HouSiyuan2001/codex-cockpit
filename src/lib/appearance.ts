import type { AppearanceMode, ResolvedAppearance } from "../types";

export function resolveAppearanceMode(mode: AppearanceMode, systemDark: boolean): ResolvedAppearance {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
