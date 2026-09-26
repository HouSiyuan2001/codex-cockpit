import { Bell } from "@phosphor-icons/react";
import { CODEX_RESETS_URL } from "../lib/externalLinks";
import { resetWatchLabel } from "../lib/resetWatch";
import type { Language, ResetWatch } from "../types";

export function ResetWatchBell({ watch, language, onOpen }: {
  watch: ResetWatch;
  language: Language;
  onOpen: (url: string) => void;
}) {
  const label = resetWatchLabel(watch, language);
  const action = language === "en" ? "Open codex-resets.com" : "打开 codex-resets.com";
  return (
    <button type="button" className="reset-watch-bell" aria-label={`${label} · ${action}`} title={`${label} · ${action}`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); onOpen(CODEX_RESETS_URL); }}>
      <Bell weight="fill" aria-hidden="true" />
    </button>
  );
}
