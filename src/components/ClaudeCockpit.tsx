import type { CockpitMode, Language } from "../types";
import { ProviderMark } from "./ProviderMark";

export function cockpitTitle(mode: CockpitMode, language: Language): string {
  if (mode === "claude") return language === "en" ? "Claude Cockpit" : "Claude 驾驶舱";
  if (mode === "ai") return language === "en" ? "AI Cockpit" : "AI 驾驶舱";
  return language === "en" ? "Codex Cockpit" : "Codex 驾驶舱";
}

export function CockpitBrandMark({ mode }: { mode: CockpitMode }) {
  if (mode === "ai") {
    return (
      <span className="cockpit-ai-mark" aria-label="AI">
        <ProviderMark provider="codex" label="Codex" />
        <ProviderMark provider="claude" label="Claude" />
      </span>
    );
  }
  return mode === "claude" ? <ProviderMark provider="claude" label="Claude" /> : <ProviderMark provider="codex" label="Codex" />;
}

const MODE_OPTIONS: ReadonlyArray<{ mode: CockpitMode; label: string }> = [
  { mode: "codex", label: "Codex" },
  { mode: "claude", label: "Claude" },
  { mode: "ai", label: "AI" },
];

export function CockpitModeSwitch({ mode, language, onChange }: { mode: CockpitMode; language: Language; onChange: (mode: CockpitMode) => void }) {
  return (
    <div className="cockpit-mode-switch" role="radiogroup" aria-label={language === "en" ? "Cockpit" : "驾驶舱"} onMouseDown={(event) => event.stopPropagation()}>
      {MODE_OPTIONS.map((option) => (
        <button
          key={option.mode}
          type="button"
          role="radio"
          aria-checked={mode === option.mode}
          className={`cockpit-mode-option cockpit-mode-option--${option.mode}${mode === option.mode ? " is-active" : ""}`}
          title={cockpitTitle(option.mode, language)}
          aria-label={cockpitTitle(option.mode, language)}
          // A mouse focus during the window resize can scroll the clipped card sideways.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { if (mode !== option.mode) onChange(option.mode); }}
        >
          {option.mode === "ai" ? <b aria-hidden="true">AI</b> : <ProviderMark provider={option.mode} label={option.label} />}
        </button>
      ))}
    </div>
  );
}
