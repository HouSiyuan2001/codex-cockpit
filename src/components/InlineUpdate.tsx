import type { Language } from "../types";
import type { UpdateViewState } from "./UpdatePanel";
import { copy } from "../lib/i18n";

interface Props {
  state: UpdateViewState;
  language: Language;
  onDownload: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onOpenRelease: () => void;
}

export function InlineUpdate({ state, language, onDownload, onInstall, onRetry, onOpenRelease }: Props) {
  if (state.phase === "idle") return null;
  const t = copy[language];
  const version = state.info?.version ?? "";
  const message = state.phase === "checking" ? t.updateChecking
    : state.phase === "current" ? t.updateCurrentTitle
    : state.phase === "available" ? t.updateAvailableTitle(version)
    : state.phase === "downloading" ? t.updateDownloading(version)
    : state.phase === "ready" ? t.updateReadyTitle(version)
    : state.phase === "installing" ? t.updateInstallingTitle : t.updateFailed;
  return <div className="inline-app-update">
    <p role="status" aria-label={language === "en" ? "Update status" : "更新状态"}>{message}</p>
    {state.phase === "current" ? <p>{t.updateCurrent}</p> : null}
    {state.error ? <p>{state.error}</p> : null}
    {state.phase === "downloading" ? <progress aria-label={message} max={100} value={state.progress?.percent ?? undefined} /> : null}
    {state.phase === "available" ? <button type="button" onClick={state.info?.automaticInstall ? onDownload : onOpenRelease}>{state.info?.automaticInstall ? t.updateDownload : t.updateOpenReleases}</button> : null}
    {state.phase === "ready" ? <button type="button" onClick={onInstall}>{t.updateRestart}</button> : null}
    {state.phase === "error" ? <button type="button" onClick={onRetry}>{t.updateRetry}</button> : null}
    {state.info?.body ? <details><summary>{t.updateReleaseNotes}</summary><p>{state.info.body}</p></details> : null}
  </div>;
}
