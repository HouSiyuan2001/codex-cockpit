import type { CockpitMode, Language } from "../types";
import { ProviderMark } from "./ProviderMark";

export function cockpitTitle(mode: CockpitMode, language: Language): string {
  if (mode === "claude") return language === "en" ? "Claude Cockpit" : "Claude 驾驶舱";
  if (mode === "gemini") return language === "en" ? "Gemini Cockpit" : "Gemini 驾驶舱";
  if (mode === "ai") return language === "en" ? "AI Cockpit" : "AI 驾驶舱";
  return language === "en" ? "Codex Cockpit" : "Codex 驾驶舱";
}

export function CockpitBrandMark({ mode, codexEnabled = true, claudeEnabled = true, geminiEnabled = false }: {
  mode: CockpitMode;
  codexEnabled?: boolean;
  claudeEnabled?: boolean;
  geminiEnabled?: boolean;
}) {
  if (mode === "ai") {
    const marks: Array<{ provider: string; label: string }> = [];
    if (codexEnabled) marks.push({ provider: "codex", label: "Codex" });
    if (claudeEnabled) marks.push({ provider: "claude", label: "Claude" });
    if (geminiEnabled) marks.push({ provider: "gemini", label: "Gemini" });
    const visible = marks.length >= 2 ? marks : [
      { provider: "codex", label: "Codex" },
      { provider: "claude", label: "Claude" },
    ];
    return (
      <span className={`cockpit-ai-mark${visible.length === 3 ? " cockpit-ai-mark--triple" : ""}`} aria-label="AI">
        {visible.map((item) => <ProviderMark key={item.provider} provider={item.provider} label={item.label} />)}
      </span>
    );
  }
  if (mode === "claude") return <ProviderMark provider="claude" label="Claude" />;
  if (mode === "gemini") return <ProviderMark provider="gemini" label="Gemini" />;
  return <ProviderMark provider="codex" label="Codex" />;
}

const DEFAULT_MODE_OPTIONS: readonly CockpitMode[] = ["codex", "claude", "ai"];

const MODE_LABELS: Record<CockpitMode, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  ai: "AI",
};

export function CockpitModeSwitch({ mode, modes = DEFAULT_MODE_OPTIONS, language, onChange }: {
  mode: CockpitMode;
  modes?: readonly CockpitMode[];
  language: Language;
  onChange: (mode: CockpitMode) => void;
}) {
  return (
    <div className="cockpit-mode-switch" role="radiogroup" aria-label={language === "en" ? "Cockpit" : "驾驶舱"} onMouseDown={(event) => event.stopPropagation()}>
      {modes.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={mode === option}
          className={`cockpit-mode-option cockpit-mode-option--${option}${mode === option ? " is-active" : ""}`}
          title={cockpitTitle(option, language)}
          aria-label={cockpitTitle(option, language)}
          // A mouse focus during the window resize can scroll the clipped card sideways.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { if (mode !== option) onChange(option); }}
        >
          {option === "ai" ? <b aria-hidden="true">AI</b> : <ProviderMark provider={option} label={MODE_LABELS[option]} />}
        </button>
      ))}
    </div>
  );
}
