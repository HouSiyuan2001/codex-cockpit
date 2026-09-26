import { ArrowClockwise, CheckCircle, CloudArrowDown, Power, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import type { AppUpdateInfo, AppUpdateProgress } from "../lib/appUpdate";
import { copy } from "../lib/i18n";
import { useModalDialog } from "../lib/modalDialog";
import type { Language } from "../types";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "current" | "error";

export interface UpdateViewState {
  phase: UpdatePhase;
  info: AppUpdateInfo | null;
  progress: AppUpdateProgress | null;
  error: string | null;
}

export const EMPTY_UPDATE_STATE: UpdateViewState = { phase: "idle", info: null, progress: null, error: null };

interface Props {
  state: UpdateViewState;
  language: Language;
  onClose: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRetry: () => void;
  onLater: () => void;
  onSkip: () => void;
  onOpenRelease: () => void;
}

export function UpdatePanel({ state, language, onClose, onDownload, onInstall, onRetry, onLater, onSkip, onOpenRelease }: Props) {
  const dialogRef = useModalDialog<HTMLElement>(onClose, state.phase !== "installing");
  const t = copy[language];
  const version = state.info?.version;
  const busy = state.phase === "checking" || state.phase === "downloading" || state.phase === "installing";
  const title = state.phase === "checking"
    ? t.updateChecking
    : state.phase === "downloading"
      ? t.updateDownloading(version ?? "")
      : state.phase === "ready"
        ? t.updateReadyTitle(version ?? "")
        : state.phase === "installing"
          ? t.updateInstallingTitle
          : state.phase === "current"
            ? t.updateCurrentTitle
            : state.phase === "error"
              ? t.updateFailed
              : t.updateAvailableTitle(version ?? "");
  const hint = state.phase === "downloading"
    ? t.updateDownloadingHint
    : state.phase === "ready"
      ? t.updateReadyHint
      : state.phase === "installing"
        ? t.updateInstalling
        : state.phase === "current"
          ? t.updateCurrent
          : state.error ?? t.updateCenterSubtitle;
  const progress = state.progress?.percent;

  return (
    <section ref={dialogRef} className="update-panel" role="dialog" aria-modal="true" aria-labelledby="app-update-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <header className="update-header">
        <div>
          <p className="update-kicker">UPDATE CENTER · {(state.info?.channel ?? "stable").toUpperCase()}</p>
          <h2 id="app-update-title">{t.updateCenterTitle}</h2>
          <p>{t.updateCenterSubtitle}</p>
        </div>
        <button type="button" onClick={onClose} disabled={state.phase === "installing"} aria-label={t.updateClose} title={t.updateClose} data-dialog-initial-focus><X /></button>
      </header>

      <div className="update-body">
        <div className={`update-status update-status--${state.phase}`}>
          {state.phase === "current" || state.phase === "ready" ? <CheckCircle weight="duotone" /> : state.phase === "error" ? <WarningCircle weight="duotone" /> : busy ? <SpinnerGap /> : <CloudArrowDown weight="duotone" />}
          <strong>{title}</strong>
          <small>{hint}</small>
          {state.phase === "downloading" ? (
            <div className="update-progress" role="progressbar" aria-label={progress === null || progress === undefined ? t.updateDownloading(version ?? "") : t.updateProgress(progress)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
              <span style={{ width: `${progress ?? 18}%` }} />
            </div>
          ) : null}
        </div>
        <div className="update-notes">
          <p>{t.updateReleaseNotes}</p>
          <div>{state.info?.body ?? t.updateNoNotes}</div>
        </div>
      </div>

      <footer className="update-footer">
        <span>{version ? `v${version}` : t.productName}</span>
        <div>
          {state.phase === "available" && state.info?.automaticInstall ? <button type="button" className="update-secondary" onClick={onDownload}><CloudArrowDown /><span>{t.updateDownload}</span></button> : null}
          {state.phase === "available" && !state.info?.automaticInstall ? <button type="button" className="update-primary" onClick={onOpenRelease}><CloudArrowDown /><span>{t.updateOpenReleases}</span></button> : null}
          {state.phase === "downloading" ? <button type="button" className="update-secondary" onClick={onLater}>{t.updateLater}</button> : null}
          {state.phase === "ready" ? <button type="button" className="update-quiet" onClick={onSkip}>{t.updateSkip}</button> : null}
          {state.phase === "ready" ? <button type="button" className="update-secondary" onClick={onLater}>{t.updateLater}</button> : null}
          {state.phase === "ready" ? <button type="button" className="update-primary" onClick={onInstall}><Power /><span>{t.updateRestart}</span></button> : null}
          {state.phase === "current" ? <button type="button" className="update-secondary" onClick={onClose}>{t.updateClose}</button> : null}
          {state.phase === "error" ? <button type="button" className="update-secondary" onClick={onOpenRelease}>{t.updateOpenReleases}</button> : null}
          {state.phase === "error" ? <button type="button" className="update-primary" onClick={onRetry}><ArrowClockwise /><span>{t.updateRetry}</span></button> : null}
        </div>
      </footer>
    </section>
  );
}
