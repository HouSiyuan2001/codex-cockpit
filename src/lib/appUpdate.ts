import { isTauri } from "./bridge";
import type { UpdateChannel } from "../types";

export const RELEASE_URL = import.meta.env.VITE_RELEASE_URL || "";

export type AppUpdatePlatform = "windows" | "macos";

export interface AppUpdateInfo {
  version: string;
  body: string | null;
  date: string | null;
  platform: AppUpdatePlatform;
  channel: UpdateChannel;
  releaseUrl: string;
  automaticInstall: boolean;
}

export interface AppUpdateProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

let pending: import("@tauri-apps/plugin-updater").Update | null = null;
let pendingInfo: AppUpdateInfo | null = null;
let downloaded = false;
let checking: Promise<AppUpdateInfo | null> | null = null;
export function getPendingAppUpdate(): AppUpdateInfo | null { return pendingInfo; }
export function checkForAppUpdate(channel: UpdateChannel = "stable"): Promise<AppUpdateInfo | null> {
  if (!isTauri()) return Promise.resolve(null);
  if (checking) return checking;
  checking = (async () => {
    await discardAppUpdate();
    const { invoke } = await import("@tauri-apps/api/core");
    const { Update } = await import("@tauri-apps/plugin-updater");
    const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("check_cockpit_update", { channel });
    if (!metadata) return null;
    pending = new Update(metadata);
    pendingInfo = { version: pending.version, body: pending.body ?? null, date: pending.date ?? null,
      platform: navigator.userAgent.includes("Windows") ? "windows" : "macos", channel,
      releaseUrl: RELEASE_URL, automaticInstall: true };
    return pendingInfo;
  })().finally(() => { checking = null; });
  return checking;
}
export async function downloadAppUpdate(onProgress: (progress: AppUpdateProgress) => void): Promise<void> {
  if (!pending) throw new Error("Check for an update first");
  downloaded = false;
  let bytes = 0; let total: number | null = null;
  await pending.download(event => {
    if (event.event === "Started") { bytes = 0; total = event.data.contentLength ?? null; }
    if (event.event === "Progress") bytes += event.data.chunkLength;
    onProgress({ downloadedBytes: bytes, totalBytes: total,
      percent: event.event === "Finished" ? 100 : total ? Math.min(100, bytes / total * 100) : null });
  });
  downloaded = true;
}
export async function installAppUpdate(): Promise<void> {
  if (!pending || !downloaded) throw new Error("Download and verify the update first");
  await pending.install();
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
export async function discardAppUpdate(): Promise<void> {
  const previous = pending; pending = null; pendingInfo = null; downloaded = false;
  await previous?.close();
}
export async function openReleasePage(_url = RELEASE_URL): Promise<void> {
  if (!RELEASE_URL.startsWith("https://github.com/")) return;
  if (!isTauri()) { window.open(RELEASE_URL, "_blank", "noopener,noreferrer"); return; }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(RELEASE_URL);
}
