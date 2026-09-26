import type { AppDiagnostics, CodexDailyUsage, ProviderSnapshot, ResetForecast, RuntimeState, VolcengineDiagnostics, WebsiteResetProbability, WidgetPreferences, WindowCompactLayout } from "../types";
import { EMPTY_RUNTIME_STATE, normalizeRuntimeState } from "./activity";
import { DEFAULT_WIDGET_PREFERENCES } from "./preferences";
import { usageDateKey } from "./usageDay";

const defaultPreferences = DEFAULT_WIDGET_PREFERENCES;

interface WidgetWorkArea {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

// Keep the work area selected while the capsule is still compact. Once the
// large panel straddles a display boundary, currentMonitor() can change and a
// later content resize would otherwise jump the panel to another display.
let widgetAnchorWorkArea: WidgetWorkArea | null = null;

async function readCurrentWorkArea(): Promise<WidgetWorkArea | null> {
  const { currentMonitor } = await import("@tauri-apps/api/window");
  const monitor = await currentMonitor().catch(() => null);
  return monitor ? {
    position: { x: monitor.workArea.position.x, y: monitor.workArea.position.y },
    size: { width: monitor.workArea.size.width, height: monitor.workArea.size.height },
  } : null;
}

const mockSnapshots: ProviderSnapshot[] = [{
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: { remainingPercent: 74, resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString(), windowSeconds: 604_800 },
  resetCredits: 1,
  resetCreditExpiresAt: [new Date(Date.now() + 9 * 86_400_000).toISOString()],
  rateLimitSnapshot: {
    source: "app-server",
    usedPercent: 26,
    windowDurationMins: 10_080,
    resetsAt: new Date(Date.now() + 3.2 * 86_400_000).toISOString(),
    observedAt: new Date().toISOString(),
  },
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}, {
  provider: "qoder",
  displayName: "QODER",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  balanceRemaining: 1280,
  balanceUnit: "credits",
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}, {
  provider: "trae",
  displayName: "TRAE",
  plan: "Pro",
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  balanceRemaining: 350,
  balanceUnit: "credits",
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}, {
  provider: "workbuddy",
  displayName: "WORKBUDDY",
  plan: null,
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  balanceRemaining: 420,
  balanceUnit: "credits",
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}, {
  provider: "volcengine",
  displayName: "VOLCENGINE",
  plan: "CODING",
  shortWindow: { remainingPercent: 88, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), windowSeconds: 18_000 },
  weeklyWindow: { remainingPercent: 86, resetsAt: new Date(Date.now() + 5.4 * 86_400_000).toISOString(), windowSeconds: 604_800 },
  monthlyWindow: { remainingPercent: 45, resetsAt: new Date(Date.now() + 20.4 * 86_400_000).toISOString(), windowSeconds: 31 * 86_400 },
  resetCredits: null,
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}, {
  provider: "antigravity",
  displayName: "ANTIGRAVITY",
  plan: "Google AI Pro",
  shortWindow: { remainingPercent: 68, resetsAt: new Date(Date.now() + 4.1 * 3_600_000).toISOString(), windowSeconds: 18_000 },
  weeklyWindow: null,
  resetCredits: null,
  updatedAt: new Date().toISOString(),
  status: "ok",
  message: null,
}];

const mockVolcengineDiagnostics: VolcengineDiagnostics = {
  installed: true,
  executablePath: "~/AppData/Roaming/npm/arkcli.cmd",
  executableSource: "PATH",
  stalePath: false,
  cliVersion: "arkcli version 1.0.3",
  authenticated: true,
  authMethod: "sso",
  profileName: "coding-plan_personal",
  profileType: "coding-plan",
  profileRegion: "cn-beijing",
  recommendedProfile: true,
  lastError: null,
};

let widgetTransition: Promise<void> = Promise.resolve();
let preferenceWriteRunning = false;
let pendingPreferenceWrite: {
  operation: () => Promise<void>;
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
} | null = null;
let runtimeWrite: Promise<void> = Promise.resolve();
let widgetIntent = 0;
let widgetResizeIntent = 0;
// The dialog owns geometry until its explicit close. Hover, preference and
// ResizeObserver callbacks must not invalidate an opening/open dialog.
let controlCenterOwnsWindow = false;

function enqueueWidgetTransition(operation: () => Promise<void>): Promise<void> {
  const next = widgetTransition.then(operation, operation);
  widgetTransition = next.catch(() => undefined);
  return next;
}

async function drainPreferenceWrites(): Promise<void> {
  if (preferenceWriteRunning) return;
  preferenceWriteRunning = true;
  while (pendingPreferenceWrite) {
    const current = pendingPreferenceWrite;
    pendingPreferenceWrite = null;
    try {
      await current.operation();
      current.waiters.forEach(({ resolve }) => resolve());
    } catch (error) {
      current.waiters.forEach(({ reject }) => reject(error));
    }
  }
  preferenceWriteRunning = false;
}

function enqueuePreferenceWrite(operation: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (pendingPreferenceWrite) {
      pendingPreferenceWrite.operation = operation;
      pendingPreferenceWrite.waiters.push({ resolve, reject });
    } else {
      pendingPreferenceWrite = { operation, waiters: [{ resolve, reject }] };
    }
    void drainPreferenceWrites();
  });
}

function enqueueRuntimeWrite(operation: () => Promise<void>): Promise<void> {
  const next = runtimeWrite.then(operation, operation);
  runtimeWrite = next.catch(() => undefined);
  return next;
}

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function fetchSnapshots(force = false): Promise<ProviderSnapshot[]> {
  if (!isTauri()) return mockSnapshots;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProviderSnapshot[]>(force ? "refresh_snapshots" : "get_snapshots");
}

export async function fetchCodexResetForecast(): Promise<ResetForecast | null> {
  if (!isTauri()) return {
    score: 62,
    windowHours: 24,
    fetchedAt: new Date().toISOString(),
    resetAnnounced: false,
    resetAt: null,
    sourceUrl: "https://codex-reset-risk-dashboard.xr08255920.workers.dev/",
    tomorrowRiskPercent: 62,
    historySampleCount: 43,
    historyResetDates: [],
    riskFactors: [],
    // Browser-only synthetic preview. Tauri always invokes the real public API.
    activeWatch: new URLSearchParams(window.location.search).get("watch") === "active" ? {
      level: "strong",
      resetChancePercent: 70,
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    } : null,
    watchCheckedAt: new Date().toISOString(),
  };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ResetForecast | null>("get_codex_reset_forecast");
}

export async function fetchCodexDailyUsage(): Promise<CodexDailyUsage> {
  if (!isTauri()) return {
    localDate: usageDateKey(new Date()),
    observedUsedPercent: 6,
    sampleCount: 24,
    firstObservedAt: new Date(new Date().setHours(4, 5, 0, 0)).toISOString(),
    lastObservedAt: new Date().toISOString(),
    coverage: "complete",
    source: "codex-session-rate-limits",
  };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CodexDailyUsage>("get_codex_daily_usage");
}

export async function fetchWebsiteResetProbability(): Promise<WebsiteResetProbability | null> {
  if (!isTauri()) return new URLSearchParams(window.location.search).get("watch") === "active" ? {
    level: "strong", resetChancePercent: 83, episodeId: "synthetic-preview",
    observedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    checkedAt: new Date().toISOString(),
  } : null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WebsiteResetProbability | null>("get_codex_website_reset_probability");
}

export async function fetchCodexDailyUsageHistory(): Promise<CodexDailyUsage[]> {
  if (!isTauri()) return [await fetchCodexDailyUsage()];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CodexDailyUsage[]>("get_codex_daily_usage_history");
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function getVolcengineDiagnostics(): Promise<VolcengineDiagnostics> {
  if (!isTauri()) return mockVolcengineDiagnostics;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<VolcengineDiagnostics>("get_volcengine_diagnostics");
}

export async function reconnectVolcengine(): Promise<VolcengineDiagnostics> {
  if (!isTauri()) return mockVolcengineDiagnostics;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<VolcengineDiagnostics>("reconnect_volcengine");
}

export async function getPreferences(): Promise<WidgetPreferences> {
  if (!isTauri()) return defaultPreferences;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("get_preferences");
}

export async function updatePreferences(value: WidgetPreferences): Promise<void> {
  if (!isTauri()) return;
  return enqueuePreferenceWrite(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_preferences", { preferences: value });
  });
}

export async function getAutostartEnabled(): Promise<boolean> {
  if (!isTauri()) return false;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("get_autostart_enabled");
}

export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return enabled;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<boolean>("set_autostart_enabled", { enabled });
}

export async function getRuntimeState(): Promise<RuntimeState> {
  if (!isTauri()) return structuredClone(EMPTY_RUNTIME_STATE);
  const { invoke } = await import("@tauri-apps/api/core");
  return normalizeRuntimeState(await invoke("get_runtime_state"));
}

export async function updateRuntimeState(runtimeState: RuntimeState): Promise<void> {
  if (!isTauri()) return;
  return enqueueRuntimeWrite(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_runtime_state", { runtimeState });
  });
}

export async function exportAppData(bundle: unknown): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: `codex-cockpit-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "Codex 驾驶舱 backup", extensions: ["json"] }] });
  if (!path) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("export_app_data", { path, bundle });
  return path;
}

export async function importAppData(): Promise<unknown | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ multiple: false, directory: false, filters: [{ name: "Codex 驾驶舱 backup", extensions: ["json"] }] });
  if (!path || Array.isArray(path)) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("import_app_data", { path });
}

export async function createAutomaticBackup(bundle: unknown): Promise<string | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("create_automatic_backup", { bundle });
}

export async function restoreLatestBackup(): Promise<unknown | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("restore_latest_backup");
}

export async function getAppDiagnostics(): Promise<AppDiagnostics> {
  if (!isTauri()) return { appVersion: "dev", platform: navigator.platform, configDirectory: "Browser preview", preferencesBackupAvailable: false, runtimeBackupAvailable: false };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AppDiagnostics>("get_app_diagnostics");
}

export async function sendDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!isTauri()) return false;
  const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/plugin-notification");
  let allowed = await isPermissionGranted();
  if (!allowed) allowed = (await requestPermission()) === "granted";
  if (!allowed) return false;
  sendNotification({ title, body });
  return true;
}

export async function setClickThrough(locked: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, locked };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("set_widget_locked", { locked });
}

export async function setAlwaysOnTop(alwaysOnTop: boolean): Promise<WidgetPreferences> {
  if (!isTauri()) return { ...defaultPreferences, alwaysOnTop };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<WidgetPreferences>("set_widget_always_on_top", { alwaysOnTop });
}

export async function startDragging(): Promise<void> {
  if (!isTauri()) return;
  ++widgetResizeIntent;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { invoke } = await import("@tauri-apps/api/core");
  const currentWindow = getCurrentWindow();
  const finishDrag = async () => {
    const workArea = await readCurrentWorkArea();
    await invoke("finish_widget_drag", { workArea });
  };
  await invoke("begin_widget_drag");
  let previous: { x: number; y: number };
  try {
    await currentWindow.startDragging();
    previous = await currentWindow.outerPosition();
  } catch (error) {
    await finishDrag().catch(() => undefined);
    throw error;
  }
  let stableTicks = 0;
  let attempts = 0;
  const finishWhenStable = window.setInterval(() => {
    void currentWindow.outerPosition()
      .then((next) => {
        attempts += 1;
        const stable = Math.abs(next.x - previous.x) <= 1 && Math.abs(next.y - previous.y) <= 1;
        stableTicks = stable ? stableTicks + 1 : 0;
        previous = next;
        if (stableTicks >= 3 || attempts >= 25) {
          window.clearInterval(finishWhenStable);
          void finishDrag().catch(() => undefined);
        }
      })
      .catch(() => {
        window.clearInterval(finishWhenStable);
        void finishDrag().catch(() => undefined);
      });
  }, 80);
}

export function setWidgetExpanded(expanded: boolean, compactLayout: WindowCompactLayout = "float", contentHeight?: number, compactWidth?: number): Promise<void> {
  if (!isTauri() || controlCenterOwnsWindow) return Promise.resolve();
  const intent = ++widgetIntent;
  ++widgetResizeIntent;
  const next = (async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    if (intent !== widgetIntent) return;
    if (!expanded) {
      try {
        await invoke("collapse_widget", {
          compactLayout,
          ...(Number.isFinite(compactWidth) && (compactWidth ?? 0) > 0 ? { compactWidth } : {}),
        });
      } finally {
        if (intent === widgetIntent) widgetAnchorWorkArea = null;
      }
      return;
    }
    const workArea = widgetAnchorWorkArea ?? await readCurrentWorkArea();
    if (intent !== widgetIntent) return;
    widgetAnchorWorkArea = workArea;
    const measuredContentHeight = Number.isFinite(contentHeight) && (contentHeight ?? 0) > 0 ? contentHeight : undefined;
    await invoke("expand_widget", {
      workArea: widgetAnchorWorkArea,
      compactLayout,
      ...(measuredContentHeight === undefined ? {} : { contentHeight: measuredContentHeight }),
    });
  })();
  // Native animation cancels its predecessor. Other geometry operations can
  // still await the latest transition without serializing hover reversals.
  widgetTransition = next.catch(() => undefined);
  return next;
}

export function resizeWidgetToContent(contentHeight: number): Promise<void> {
  if (!isTauri() || controlCenterOwnsWindow || !Number.isFinite(contentHeight) || contentHeight <= 0) return Promise.resolve();
  const intent = widgetResizeIntent;
  return enqueueWidgetTransition(async () => {
    if (intent !== widgetResizeIntent) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const workArea = widgetAnchorWorkArea ?? await readCurrentWorkArea();
    if (intent !== widgetResizeIntent) return;
    await invoke("resize_expanded_widget", { contentHeight, workArea });
  });
}

export function openControlCenterWindow(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  controlCenterOwnsWindow = true;
  const intent = ++widgetIntent;
  ++widgetResizeIntent;
  return enqueueWidgetTransition(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const workArea = widgetAnchorWorkArea ?? await readCurrentWorkArea();
    if (intent !== widgetIntent) return;
    await invoke("open_control_center", { workArea });
  }).catch(async (error) => {
    if (intent === widgetIntent) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("close_control_center").catch(() => undefined);
      controlCenterOwnsWindow = false;
    }
    throw error;
  });
}

export function setControlCenterCalendarOpen(open: boolean): Promise<void> {
  if (!isTauri() || !controlCenterOwnsWindow) return Promise.resolve();
  const intent = widgetIntent;
  return enqueueWidgetTransition(async () => {
    if (intent !== widgetIntent || !controlCenterOwnsWindow) return;
    const { invoke } = await import("@tauri-apps/api/core");
    const workArea = widgetAnchorWorkArea ?? await readCurrentWorkArea();
    if (intent !== widgetIntent || !controlCenterOwnsWindow) return;
    await invoke("set_control_center_calendar_open", { open, workArea });
  });
}

export function closeControlCenterWindow(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueueWidgetTransition(async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_control_center");
    controlCenterOwnsWindow = false;
    ++widgetIntent;
    ++widgetResizeIntent;
  });
}

export async function listenDesktopEvents(handlers: {
  onPreferences: (value: WidgetPreferences) => void;
  onRefresh: () => void;
  onUpdate: () => void;
  onBackgroundSnapshots: (value: ProviderSnapshot[]) => void;
}): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const unlisteners: Array<() => void> = [];
  try {
    unlisteners.push(await listen<WidgetPreferences>("preferences-changed", (event) => handlers.onPreferences(event.payload)));
    unlisteners.push(await listen<ProviderSnapshot[]>("background-snapshots-updated", (event) => handlers.onBackgroundSnapshots(event.payload)));
    unlisteners.push(await listen("refresh-requested", handlers.onRefresh));
    unlisteners.push(await listen("update-check-requested", handlers.onUpdate));
  } catch (error) {
    for (const unlisten of [...unlisteners].reverse()) unlisten();
    throw error;
  }
  return () => { for (const unlisten of [...unlisteners].reverse()) unlisten(); };
}
