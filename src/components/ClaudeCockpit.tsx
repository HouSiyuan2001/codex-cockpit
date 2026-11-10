import { ArrowClockwise } from "@phosphor-icons/react";
import { CLAUDE_CAP_SLIDER_MAX_USD, formatPerMillion, formatTokens, formatUsd, type ClaudeCockpitView } from "../lib/claudeCockpit";
import type { CockpitMode, Language } from "../types";
import { ProviderMark } from "./ProviderMark";
import { RangeSlider } from "./RangeSlider";

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

export function ClaudeWeekFooter({ view, language }: { view: ClaudeCockpitView; language: Language }) {
  return (
    <div className="weekly-reset-footer">
      <span>{language === "en" ? "Total" : "合计"} <strong>{formatUsd(view.weekCostUsd, language, true)}</strong></span>
      <span>{language === "en" ? "Daily average" : "日均"} <strong>{formatUsd(view.weekAverageUsd, language)}</strong></span>
    </div>
  );
}

export function ClaudeCapControl({ view, language, onCapChange, onSliderInteraction }: {
  view: ClaudeCockpitView;
  language: Language;
  onCapChange: (value: number | null) => void;
  onSliderInteraction?: (active: boolean) => void;
}) {
  const sliderMax = Math.max(CLAUDE_CAP_SLIDER_MAX_USD, Math.ceil(view.capUsd));
  const restoreLabel = language === "en" ? "Use comfort estimate" : "恢复舒适估计";
  return (
    <div className="daily-budget-control" onMouseDown={(event) => event.stopPropagation()}>
      <div className="daily-budget-heading">
        <label htmlFor="claude-cap-range"><span>{language === "en" ? "Personal cap" : "个人上限"}</span><output>{formatUsd(view.capUsd, language)}</output></label>
        <button
          type="button"
          className="daily-budget-refresh"
          onClick={() => onCapChange(null)}
          disabled={!view.manualCap}
          aria-label={restoreLabel}
          title={restoreLabel}
        >
          <ArrowClockwise weight="bold" />
        </button>
      </div>
      <small className="daily-budget-recommendation">
        <span>{view.estimate ? (language === "en" ? "Comfort estimate" : "舒适估计") : (language === "en" ? "Recent average" : "近期日均")} {formatUsd(view.suggestedCapUsd, language)}</span>
      </small>
      <RangeSlider
        id="claude-cap-range"
        min="1"
        max={String(sliderMax)}
        step="0.5"
        value={view.capUsd}
        aria-label={language === "en" ? "Personal cap" : "个人上限"}
        onChange={(event) => onCapChange(Number(event.target.value))}
        onInteractionChange={onSliderInteraction}
      />
    </div>
  );
}

export function ClaudeModelsPanel({ view, language }: { view: ClaudeCockpitView; language: Language }) {
  const models = view.models.slice(0, 3);
  return (
    <section className="claude-models-panel" aria-label={language === "en" ? "Models, last 7 days" : "近 7 天模型"}>
      <header>
        <strong>{language === "en" ? "Models · 7 days" : "近 7 天模型"}</strong>
        <small>{language === "en" ? "input / output per MTok" : "输入 / 输出 每百万"}</small>
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
