import { Smiley, SmileySad, SmileyWink } from "@phosphor-icons/react";
import type { ComfortCode, ComfortPrompt, Language } from "../types";

interface ComfortFeedbackPanelProps {
  prompt: ComfortPrompt;
  language: Language;
  onSelect: (comfort: ComfortCode) => void;
  saving?: boolean;
  error?: string | null;
}

const options: Array<{ code: ComfortCode; icon: typeof SmileySad }> = [
  { code: "overloaded", icon: SmileySad },
  { code: "comfortable", icon: Smiley },
  { code: "idle", icon: SmileyWink },
];

export function ComfortFeedbackPanel({ prompt, language, onSelect, saving = false, error = null }: ComfortFeedbackPanelProps) {
  const number = new Intl.NumberFormat(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 1 });
  const observedTime = prompt.usageObservedAt
    ? new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(prompt.usageObservedAt))
    : null;
  const labels = language === "en"
    ? { title: "How did today feel?", hint: prompt.isCatchUp ? `Catch up · ${prompt.localDate}` : "A tiny check-in", options: { overloaded: "Too much", comfortable: "Just right", idle: "Easy" }, usage: "Used today", missing: "Usage not available", observed: observedTime ? `at ${observedTime}` : "" }
    : { title: "今天感觉？", hint: prompt.isCatchUp ? `补记 · ${prompt.localDate}` : "轻轻记一下", options: { overloaded: "有点撑", comfortable: "刚刚好", idle: "很轻松" }, usage: "今日已用", missing: "今日额度未读取", observed: observedTime ? `· ${observedTime}` : "" };
  return (
    <section className="comfort-feedback-panel" aria-label={labels.title}>
      <header>
        <div>
          <strong>{prompt.personName ? `${prompt.personName} · ` : ""}{labels.title}</strong>
          <small>{labels.hint}</small>
        </div>
        <span className="comfort-feedback-time">22:00</span>
      </header>
      <div className="comfort-feedback-options">
        {options.map(({ code, icon: Icon }) => (
          <button
            key={code}
            type="button"
            disabled={saving}
            className={`comfort-feedback-option comfort-feedback-option--${code}`}
            aria-label={labels.options[code]}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onSelect(code)}
          >
            <Icon weight="duotone" aria-hidden="true" />
            <span>{labels.options[code]}</span>
          </button>
        ))}
      </div>
      <footer>
        {prompt.personId ? <>
          <span>{prompt.quotaAllocation?.allocatedUsedPercent != null && prompt.quotaAllocation.coverage !== "unavailable" ? `≈${number.format(prompt.quotaAllocation.allocatedUsedPercent)}%` : (language === "en" ? "Percentage unavailable" : "暂无百分比")}</span>
          <span>{language === "en" ? "By cost share" : "按金额分摊"}</span>
        </> : <>
          <span>{prompt.observedUsedPercent === null ? labels.missing : `${labels.usage} ${number.format(prompt.observedUsedPercent)}% ${labels.observed}`}</span>
          <span>{prompt.usageCoverage === "complete" ? (language === "en" ? "official" : "官方快照") : prompt.usageCoverage === "partial" ? (language === "en" ? "partial" : "部分记录") : "—"}</span>
        </>}
      </footer>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
