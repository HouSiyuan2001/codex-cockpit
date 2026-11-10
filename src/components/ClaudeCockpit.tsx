import { formatPerMillion, formatTokens, formatUsd, type ClaudeCockpitView } from "../lib/claudeCockpit";
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

export function ClaudeModelsPanel({ view, language }: { view: ClaudeCockpitView; language: Language }) {
  const models = view.models.slice(0, 3);
  return (
    <section className="claude-models-panel" aria-label={language === "en" ? "Models, last 7 days" : "近 7 天模型"}>
      <header>
        <strong>{language === "en" ? "Models · 7 days" : "近 7 天模型"}</strong>
        <small>{language === "en" ? "API price · in / out per MTok" : "API 价 · 输入 / 输出 每百万"}</small>
      </header>
      {models.length === 0 ? <p>{language === "en" ? "No local use" : "暂无本机用量"}</p> : (
        <ul>
          {models.map((model) => (
            <li key={model.id}>
              <span className="claude-model-name">{model.name}</span>
              <span className="claude-model-tokens">{formatTokens(model.tokens, language)}</span>
              <strong>{formatUsd(model.costUsd, language)}</strong>
              <small>{model.price ? `${formatPerMillion(model.price.input)} / ${formatPerMillion(model.price.output)}` : "—"}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
