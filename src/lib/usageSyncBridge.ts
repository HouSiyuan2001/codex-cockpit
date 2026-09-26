import { isTauri } from "./bridge";

export interface UsageSyncSettings {
  enabled: boolean;
  intervalSeconds: number;
  deviceId: string;
  remote: string;
  branch: string;
}
export interface UsageSyncStatus {
  settings: UsageSyncSettings | null;
  imported: boolean;
  phase: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastCollectedAt: string | null;
  lastError: string | null;
  lastCommit: string | null;
  collectorStatus: string | null;
}
let preview: UsageSyncStatus = { settings: { enabled: false, intervalSeconds: 300, deviceId: "Demo-Mac", remote: "git@gitee.com:example/usage.git", branch: "main" }, imported: true, phase: "idle", lastAttemptAt: null, lastSuccessAt: null, lastCollectedAt: null, lastError: null, lastCommit: null, collectorStatus: null };
export async function getUsageSyncStatus(): Promise<UsageSyncStatus> {
  if (!isTauri()) return structuredClone(preview);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_usage_sync_status");
}
export async function saveUsageSyncSettings(settings: UsageSyncSettings): Promise<UsageSyncStatus> {
  if (!isTauri()) { preview = { ...preview, settings, imported: false }; return structuredClone(preview); }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("save_usage_sync_settings", { settings });
}
export async function syncUsageNow(): Promise<UsageSyncStatus> {
  if (!isTauri()) { const now = new Date().toISOString(); preview = { ...preview, phase: "idle", lastAttemptAt: now, lastSuccessAt: now, lastCollectedAt: now, collectorStatus: "sample" }; return structuredClone(preview); }
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<UsageSyncStatus>("sync_usage_now");
  window.dispatchEvent(new Event("comfort-sync-updated"));
  return result;
}

export async function getSyncedComfortFeedback(): Promise<unknown[]> {
  if (!isTauri()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_synced_comfort_feedback");
}
