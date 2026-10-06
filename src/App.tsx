import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSharedDailyPlan } from "./hooks/useSharedDailyPlan";
import { allocateSharedPlan, sharedRecommendation } from "./lib/sharedDailyPlan";
import { closeControlCenterWindow } from "./lib/bridge";
import { buildDailyPersonCosts } from "./lib/dailyPersonCosts";
import { mergeSyncedComfortFeedback } from "./lib/comfortSync";
import { getSyncedComfortFeedback } from "./lib/usageSyncBridge";
import { getPersonPlan, savePersonPlan, planPreferences, planDateKey, type PersonPlan } from "./lib/personPlanSync";
import { capsuleLogicalWidth, QuotaCard, QuotaIsland, QuotaOrb } from "./components/QuotaCard";
import { isCodexPlus, fiveHourRemaining } from "./lib/plusQuota";
import { ControlCenter } from "./components/ControlCenter";
import { EMPTY_UPDATE_STATE } from "./components/UpdatePanel";
import type { UpdateViewState } from "./components/UpdatePanel";
import { createAutomaticBackup, exportAppData, fetchCodexResetForecast, fetchSnapshots, getAppDiagnostics, getAutostartEnabled, getPreferences, getRuntimeState, getVolcengineDiagnostics, importAppData, listenDesktopEvents, openControlCenterWindow, openExternalUrl, reconnectVolcengine, resizeWidgetToContent, restoreLatestBackup, sendDesktopNotification, setAlwaysOnTop, setAutostartEnabled, setWidgetExpanded, startDragging, updatePreferences, updateRuntimeState } from "./lib/bridge";
import { checkForAppUpdate, discardAppUpdate, downloadAppUpdate, installAppUpdate, openReleasePage } from "./lib/appUpdate";
import type { AppUpdateInfo } from "./lib/appUpdate";
import { copy, nextLanguage, normalizeLanguage } from "./lib/i18n";
import { normalizeProviderOrder } from "./lib/providers";
import { prepareSurfaceCrossfade, waitForSurfacePaint } from "./lib/windowTransition";
import { detectRecentCodexReset, isRecentCodexReset } from "./lib/resetDetection";
import type { RecentCodexReset } from "./lib/resetDetection";
import { trackedQuotaWindows } from "./lib/quotaPace";
import { estimateCarryInPercent, upsertDailyRecommendation, type DailyRecommendation } from "./lib/dynamicQuota";
import { calibratePersonalUsage } from "./lib/personalUsageModel";
import { buildTodayQuotaAdvice, dailyUsageRatio } from "./lib/todayQuota";
import { buildOfficialDailyUsageHistory } from "./lib/officialUsage";
import { mergeSnapshots } from "./lib/snapshots";
import { canSendNotification, EMPTY_RUNTIME_STATE, isQuietHour, normalizeRuntimeState, recordSnapshotActivity } from "./lib/activity";
import { DEFAULT_WIDGET_PREFERENCES, effectiveCompactLayout, effectiveStayExpanded, normalizeWidgetPreferences } from "./lib/preferences";
import { resolveAppearanceMode, systemPrefersDark } from "./lib/appearance";
import { appendComfortFeedback, appendComfortPromptedDate, buildComfortPrompt, createComfortFeedbackRecord, getPersonComfortPromptTarget, nextComfortReminderAt, personalizeComfortCurve } from "./lib/comfortFeedback";
import { buildPersonQuotaAllocation } from "./lib/personQuotaAllocation";
import { allocationForFeedback, backfillPersonAllocations } from "./lib/personComfort";
import { buildTokenComfortSnapshot } from "./lib/tokenComfort";
import { useComfortUsage } from "./lib/useComfortUsage";
import { loadStartupState } from "./lib/startup";
import { measureSurfaceHeight } from "./lib/windowMetrics";
import { usageDateKey } from "./lib/usageDay";
import { CODEX_RESETS_URL } from "./lib/externalLinks";
import { useWebsiteResetProbability } from "./lib/useWebsiteResetProbability";
import { buildMidnightQuotaPlan } from "./lib/midnightQuotaPlan";
import type { AppDiagnostics, ComfortCode, ComfortPrompt, ProviderId, ProviderSnapshot, ResetForecast, RuntimeState, VolcengineDiagnostics, WidgetPreferences } from "./types";

const DEFAULT_PREFS = DEFAULT_WIDGET_PREFERENCES;

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function measureExpandedContentHeight(): number | undefined {
  const card = document.querySelector<HTMLElement>(".quota-card");
  return card ? measureSurfaceHeight(card) : undefined;
}

function setWidgetSurfaceSizing(active: boolean): void {
  if (active) document.documentElement.dataset.widgetResizing = "true";
  else {
    delete document.documentElement.dataset.widgetResizing;
    delete document.documentElement.dataset.widgetCollapsing;
  }
}

export default function App() {
  const [snapshots, setSnapshots] = useState<ProviderSnapshot[]>([]);
  const [recentCodexReset, setRecentCodexReset] = useState<RecentCodexReset | null>(null);
  const [codexResetForecast, setCodexResetForecast] = useState<ResetForecast | null>(null);
  const [preferences, setPreferences] = useState(DEFAULT_PREFS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [compact, setCompact] = useState(true);
  const [consumingProviders, setConsumingProviders] = useState<Set<string>>(() => new Set());
  const [operationError, setOperationError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateViewState>(EMPTY_UPDATE_STATE);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<VolcengineDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>(EMPTY_RUNTIME_STATE);
  const [startupReady, setStartupReady] = useState(false);
  const [comfortPrompt, setComfortPrompt] = useState<ComfortPrompt | null>(null);
  const [comfortSaving, setComfortSaving] = useState(false);
  const [comfortSaveError, setComfortSaveError] = useState<string | null>(null);
  const [comfortSyncError, setComfortSyncError] = useState(false);
  const comfortSaveBusy = useRef(false);
  const { data: comfortUsage, error: comfortUsageError, refresh: refreshComfortUsage } = useComfortUsage(startupReady);
  const comfortPersonId = runtimeState.comfortPersonId === undefined ? comfortUsage?.localGroupId ?? null : runtimeState.comfortPersonId;
  const comfortPerson = comfortUsage?.groups.find(group => group.id === comfortPersonId);
  const [appDiagnostics, setAppDiagnostics] = useState<AppDiagnostics | null>(null);
  const [autostartEnabled, setAutostartState] = useState(false);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  const [usageDay, setUsageDay] = useState(() => usageDateKey(new Date()));
  const [planningNow, setPlanningNow] = useState(() => new Date());
  const failures = useRef(0);
  const snapshotsRef = useRef<ProviderSnapshot[]>([]);
  const previousMetric = useRef(new Map<string, number>());
  const consumptionTimers = useRef(new Map<string, number>());
  const collapseTimer = useRef<number | null>(null);
  const controlOpenRef = useRef(false);
  const sliderInteracting = useRef(false);
  const sliderOutsideCard = useRef(false);
  const widgetTransitioning = useRef(false);
  const hoverSequence = useRef(0);
  const hoverTargetExpanded = useRef(false);
  const updateSequence = useRef(0);
  const refreshSequence = useRef(0);
  const runtimeStateRef = useRef<RuntimeState>(EMPTY_RUNTIME_STATE);
  const comfortPromptRef = useRef<ComfortPrompt | null>(null);
  const autoExpandedComfortPrompt = useRef<string | null>(null);
  const preferencesRef = useRef<WidgetPreferences>(DEFAULT_PREFS);
  const confirmedPreferencesRef = useRef<WidgetPreferences>(DEFAULT_PREFS);
  const preferenceSaveSequence = useRef(0);
  const planEditSequence = useRef(0);
  const planSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const language = normalizeLanguage(preferences.language);
  const t = copy[language];
  const resolvedAppearance = resolveAppearanceMode(preferences.appearanceMode, systemDark);
  const codexDailyUsageHistory = useMemo(() => {
    const now = new Date();
    return buildOfficialDailyUsageHistory(runtimeState.history, snapshots.find((item) => item.provider === "codex") ?? null, now);
  }, [runtimeState.history, snapshots, usageDay]);
  const codexDailyUsage = useMemo(
    () => codexDailyUsageHistory.find((item) => item.localDate === usageDay) ?? null,
    [codexDailyUsageHistory, usageDay],
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(query.matches);
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.appearance = resolvedAppearance;
  }, [resolvedAppearance]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-scale", String(preferences.fontScale));
  }, [preferences.fontScale]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPlanningNow(new Date());
      const next = usageDateKey(new Date());
      setUsageDay((current) => current === next ? current : next);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const commitRuntimeState = useCallback((next: RuntimeState) => {
    runtimeStateRef.current = next;
    setRuntimeState(next);
    void updateRuntimeState(next).catch(() => setOperationError("Activity history could not be saved."));
  }, []);

  useEffect(() => {
    if (!startupReady) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || comfortSaveBusy.current) return;
      pending = true;
      try {
        const remote = await getSyncedComfortFeedback();
        if (!active || comfortSaveBusy.current) return;
        setComfortSyncError(false);
        const current = runtimeStateRef.current;
        const merged = mergeSyncedComfortFeedback(current.comfortFeedback, remote);
        if (merged) commitRuntimeState({ ...current, comfortFeedback: merged });
      } catch {
        if (active) setComfortSyncError(true); // Never clear local feedback.
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onSync = () => void refresh();
    window.addEventListener("comfort-sync-updated", onSync);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("comfort-sync-updated", onSync); };
  }, [startupReady, commitRuntimeState]);

  const syncComfortPrompt = useCallback((now = new Date()) => {
    if (!startupReady || comfortSaveBusy.current) return;
    if (!comfortPerson || !comfortUsage) {
      comfortPromptRef.current = null;
      setComfortPrompt(null);
      return;
    }
    const currentPrompt = comfortPromptRef.current?.personId === comfortPerson.id ? comfortPromptRef.current : null;
    const target = currentPrompt
      ? { localDate: currentPrompt.localDate, isCatchUp: currentPrompt.isCatchUp }
      : getPersonComfortPromptTarget(comfortPerson.id, now, runtimeStateRef.current.comfortFeedback, runtimeStateRef.current.comfortPromptedDates);
    if (!target) {
      comfortPromptRef.current = null;
      setComfortPrompt(null);
      return;
    }
    const officialUsage = codexDailyUsageHistory.find((item) => item.localDate === target.localDate) ?? null;
    const total = buildComfortPrompt(target, officialUsage, runtimeStateRef.current.dailyUsage);
    const nextPrompt = { ...total, personId: comfortPerson.id, personName: comfortPerson.name, quotaAllocation: buildPersonQuotaAllocation(comfortUsage, comfortPerson.id, target.localDate, total, now), tokenSnapshot: buildTokenComfortSnapshot(comfortUsage, comfortPerson.id, target.localDate, now) };
    if (currentPrompt) {
      if (currentPrompt.localDate === target.localDate) {
        comfortPromptRef.current = nextPrompt;
        setComfortPrompt((current) => current ? { ...current, ...nextPrompt } : nextPrompt);
      }
      return;
    }
    comfortPromptRef.current = nextPrompt;
    setComfortPrompt(nextPrompt);
    const nextRuntimeState = {
      ...runtimeStateRef.current,
      comfortPromptedDates: appendComfortPromptedDate(runtimeStateRef.current.comfortPromptedDates, target.localDate, comfortPerson.id),
    };
    commitRuntimeState(nextRuntimeState);
  }, [codexDailyUsageHistory, commitRuntimeState, startupReady, comfortPerson, comfortUsage]);

  useEffect(() => {
    if (!startupReady || !comfortUsage || comfortSaveBusy.current) return;
    const current = runtimeStateRef.current;
    const migrated = backfillPersonAllocations(current.comfortFeedback, comfortUsage, codexDailyUsageHistory, current.dailyUsage);
    if (migrated) commitRuntimeState({ ...current, comfortFeedback: migrated });
  }, [startupReady, comfortUsage, codexDailyUsageHistory, commitRuntimeState]);

  useEffect(() => {
    if (!startupReady) return;
    syncComfortPrompt();
    const delay = Math.max(1_000, nextComfortReminderAt().getTime() - Date.now() + 100);
    const timer = window.setTimeout(() => syncComfortPrompt(), delay);
    return () => window.clearTimeout(timer);
  }, [runtimeState.comfortFeedback, startupReady, syncComfortPrompt]);

  const saveComfortFeedback = useCallback(async (localDate: string, comfort: ComfortCode, personId: string | null, refreshSnapshot = false) => {
    if (comfortSaveBusy.current) return;
    const existing = runtimeStateRef.current.comfortFeedback.find(item => item.localDate === localDate && (item.personId ?? null) === personId);
    if (!personId && !existing) return;
    comfortSaveBusy.current = true;
    setComfortSaving(true);
    setComfortSaveError(null);
    try {
      let data = comfortUsage;
      if (personId && (!existing || refreshSnapshot)) {
        try { data = await refreshComfortUsage(); }
        catch {
          if (refreshSnapshot) {
            setComfortSaveError(language === "en" ? "Refresh failed. The saved allocation is unchanged." : "刷新失败，已保留原来的分摊记录。");
            return;
          }
          data = data ? { ...data, status: "partial", devices: data.devices.map(device => ({ ...device, collectionPartial: true })) } : null;
        }
      }
      const person = data?.groups.find(group => group.id === personId);
      const now = new Date();
      const official = codexDailyUsageHistory.find(item => item.localDate === localDate) ?? null;
      const total = buildComfortPrompt({ localDate, isCatchUp: true }, official, runtimeStateRef.current.dailyUsage);
      // Historical shared quota may no longer be available from the provider.
      // Preserve the original captured total as a fallback, never an allocated view.
      const savedTotal = existing?.observedUsedPercent != null ? existing : existing?.quotaAllocation?.totalUsedPercent != null ? {
        ...existing,
        observedUsedPercent: existing.quotaAllocation.totalUsedPercent,
        usageCoverage: existing.quotaAllocation.coverage,
        usageObservedAt: existing.usageObservedAt ?? existing.quotaAllocation.observedAt,
      } : existing;
      const capturedTotal = total.observedUsedPercent !== null ? total : savedTotal ?? total;
      const quotaAllocation = personId && data ? buildPersonQuotaAllocation(data, personId, localDate, capturedTotal, now) : null;
      if (refreshSnapshot && (!quotaAllocation || quotaAllocation.coverage === "unavailable")) {
        setComfortSaveError(language === "en" ? "Not enough cost data. The saved allocation is unchanged." : "金额数据不足，已保留原来的分摊记录。");
        return;
      }
      const prompt = { ...total, personId, personName: person?.name ?? existing?.personName ?? null, quotaAllocation, tokenSnapshot: personId && data ? buildTokenComfortSnapshot(data, personId, localDate, now) : null };
      const feedback = existing ? { ...existing, comfort, observedAt: refreshSnapshot ? existing.observedAt : now.toISOString(), quotaAllocation: refreshSnapshot ? quotaAllocation : allocationForFeedback(existing, data, codexDailyUsageHistory, runtimeStateRef.current.dailyUsage, now), ...(refreshSnapshot ? { tokenSnapshot: prompt.tokenSnapshot, observedUsedPercent: capturedTotal.observedUsedPercent, usageObservedAt: capturedTotal.usageObservedAt, usageCoverage: capturedTotal.usageCoverage, usageSource: capturedTotal.usageSource } : {}) } : createComfortFeedbackRecord(prompt, comfort, now);
      const next = { ...runtimeStateRef.current, comfortFeedback: appendComfortFeedback(runtimeStateRef.current.comfortFeedback, { ...feedback, updatedAt: now.toISOString() }) };
      runtimeStateRef.current = next;
      setRuntimeState(next);
      await updateRuntimeState(next);
      if (comfortPromptRef.current?.localDate === localDate && (comfortPromptRef.current.personId ?? null) === personId) {
        comfortPromptRef.current = null;
        setComfortPrompt(null);
      }
    } catch {
      setComfortSaveError(language === "en" ? "This feedback has not been saved to disk. Please retry." : "这条体验尚未写入磁盘，请重试保存。");
    } finally { comfortSaveBusy.current = false; setComfortSaving(false); }
  }, [comfortUsage, refreshComfortUsage, codexDailyUsageHistory, language]);

  const handleComfortSelect = useCallback((comfort: ComfortCode) => {
    const prompt = comfortPromptRef.current;
    if (prompt) void saveComfortFeedback(prompt.localDate, comfort, prompt.personId ?? null);
  }, [saveComfortFeedback]);
  const handleComfortHistoryChange = useCallback((localDate: string, comfort: ComfortCode) => { void saveComfortFeedback(localDate, comfort, comfortPersonId); }, [saveComfortFeedback, comfortPersonId]);
  const handleComfortPersonChange = useCallback((personId: string | null) => {
    if (comfortSaveBusy.current) return;
    comfortPromptRef.current = null;
    setComfortPrompt(null);
    setComfortSaveError(null);
    commitRuntimeState({ ...runtimeStateRef.current, comfortPersonId: personId });
  }, [commitRuntimeState]);
  const handleComfortSnapshotRefresh = useCallback((localDate: string) => {
    const existing = runtimeStateRef.current.comfortFeedback.find(item => item.localDate === localDate && (item.personId ?? null) === comfortPersonId);
    if (existing) void saveComfortFeedback(localDate, existing.comfort, comfortPersonId, true);
  }, [saveComfortFeedback, comfortPersonId]);

  const startUpdateDownload = useCallback(async (info: AppUpdateInfo, reveal = false) => {
    const sequence = ++updateSequence.current;
    if (reveal) setUpdateOpen(true);
    setUpdateState({ phase: "downloading", info, progress: null, error: null });
    try {
      await downloadAppUpdate((progress) => {
        if (updateSequence.current === sequence) {
          setUpdateState({ phase: "downloading", info, progress, error: null });
        }
      });
      if (updateSequence.current === sequence) {
        setUpdateState({ phase: "ready", info, progress: { downloadedBytes: 0, totalBytes: 0, percent: 100 }, error: null });
        setUpdateOpen(true);
      }
    } catch (error) {
      if (updateSequence.current !== sequence) return;
      setUpdateState({ phase: "error", info, progress: null, error: errorMessage(error, t.updateFailed) });
      setOperationError(t.updateFailed);
      if (reveal) setUpdateOpen(true);
    }
  }, [t.updateFailed]);

  const checkUpdate = useCallback((manual = false) => {
    if (["downloading", "installing"].includes(updateState.phase) ||
        (["available", "ready"].includes(updateState.phase) && updateState.info?.channel === preferences.updateChannel)) {
      if (manual) {
        setDiagnosticsOpen(false);
        setUpdateOpen(true);
      }
      return;
    }
    const sequence = ++updateSequence.current;
    if (manual) {
      setDiagnosticsOpen(false);
      setUpdateOpen(true);
      setUpdateState({ phase: "checking", info: null, progress: null, error: null });
    }
    setOperationError(null);
    void checkForAppUpdate(preferences.updateChannel).then(async (info) => {
      if (updateSequence.current !== sequence) return;
      if (!info) {
        setUpdateState({ phase: manual ? "current" : "idle", info: null, progress: null, error: null });
        return;
      }
      if (!manual && preferences.skippedUpdateVersion === info.version) {
        await discardAppUpdate();
        if (updateSequence.current === sequence) setUpdateState(EMPTY_UPDATE_STATE);
        return;
      }
      if (!info.automaticInstall || manual || !preferences.automaticUpdates) {
        setUpdateState({ phase: "available", info, progress: null, error: null });
        if (!manual) setUpdateOpen(true);
        return;
      }
      await startUpdateDownload(info, manual);
    }).catch((error) => {
      if (updateSequence.current !== sequence) return;
      setUpdateState({ phase: "error", info: null, progress: null, error: errorMessage(error, t.updateFailed) });
      setOperationError(t.updateFailed);
      if (manual) setUpdateOpen(true);
    });
  }, [preferences.automaticUpdates, preferences.skippedUpdateVersion, preferences.updateChannel, startUpdateDownload, t.updateFailed, updateState.phase]);

  const refresh = useCallback(async (force = false, suppliedValues?: ProviderSnapshot[]) => {
    const sequence = ++refreshSequence.current;
    try {
      const [values, forecast] = await Promise.all([
        suppliedValues ? Promise.resolve(suppliedValues) : fetchSnapshots(force),
        fetchCodexResetForecast().catch(() => null),
      ]);
      if (refreshSequence.current !== sequence) return;
      setCodexResetForecast(forecast);
      const hasFailure = values.some((item) => item.status !== "ok");
      if (hasFailure) failures.current += 1;
      else failures.current = 0;
      for (const item of values) {
        const percentWindows = trackedQuotaWindows(item);
        const nextMetric = percentWindows.length > 0
          ? percentWindows.reduce((total, value) => total + value.window.remainingPercent, 0)
          : item.balanceRemaining ?? undefined;
        const previous = previousMetric.current.get(item.provider);
        if (nextMetric !== undefined && previous !== undefined && nextMetric < previous) {
          setConsumingProviders((current) => new Set(current).add(item.provider));
          const oldTimer = consumptionTimers.current.get(item.provider);
          if (oldTimer !== undefined) window.clearTimeout(oldTimer);
          const timer = window.setTimeout(() => {
            setConsumingProviders((current) => { const next = new Set(current); next.delete(item.provider); return next; });
            consumptionTimers.current.delete(item.provider);
          }, 5 * 60_000);
          consumptionTimers.current.set(item.provider, timer);
        }
        if (nextMetric !== undefined) previousMetric.current.set(item.provider, nextMetric);
      }
      const now = new Date();
      let detectedReset: RecentCodexReset | null = null;
      const nextCodex = values.find((item) => item.provider === "codex");
      if (nextCodex) {
        detectedReset = detectRecentCodexReset(nextCodex, snapshotsRef.current.find((item) => item.provider === "codex") ?? null, now);
        setRecentCodexReset((current) => detectedReset ?? (isRecentCodexReset(current, now) ? current : null));
      }
      const activity = recordSnapshotActivity(runtimeStateRef.current, snapshotsRef.current, values, detectedReset, preferencesRef.current.alertThreshold, now, preferencesRef.current.language, preferencesRef.current.notificationCooldownMinutes, forecast);
      let nextRuntimeState = activity.state;
      const notificationPreferences = preferencesRef.current;
      if (notificationPreferences.notificationsEnabled && !isQuietHour(now.getHours(), notificationPreferences.quietHoursStart, notificationPreferences.quietHoursEnd)) {
        for (const candidate of activity.notificationCandidates) {
          const item = candidate.event;
          const enabled = item.kind === "reset" ? notificationPreferences.notifyOnReset : item.kind === "recovered" ? notificationPreferences.notifyOnRecovery : item.kind === "quota" || item.kind === "warning";
          const key = candidate.key;
          if (!enabled || !canSendNotification(nextRuntimeState, key, notificationPreferences.notificationCooldownMinutes, now)) continue;
          if (await sendDesktopNotification(item.title, item.detail).catch(() => false)) {
            nextRuntimeState = { ...nextRuntimeState, lastNotifications: { ...nextRuntimeState.lastNotifications, [key]: now.toISOString() } };
          }
        }
      }
      if (refreshSequence.current !== sequence) return;
      commitRuntimeState({
        ...nextRuntimeState,
        comfortFeedback: runtimeStateRef.current.comfortFeedback,
        comfortPromptedDates: runtimeStateRef.current.comfortPromptedDates,
        comfortPersonId: runtimeStateRef.current.comfortPersonId,
      });
      setSnapshots((current) => {
        const merged = mergeSnapshots(current, values);
        snapshotsRef.current = merged;
        return merged;
      });
    } catch {
      if (refreshSequence.current !== sequence) return;
      setCodexResetForecast(null);
      failures.current += 1;
      setSnapshots((current) => {
        const next = current.length > 0
          ? current.map((item) => ({ ...item, status: "stale" as const, message: "Refresh failed. Please try again later." }))
          : [{ provider: "codex" as const, displayName: "CODEX", plan: null, shortWindow: null, weeklyWindow: null, resetCredits: null, resetCreditExpiresAt: [], updatedAt: new Date().toISOString(), status: "unavailable" as const, message: "Quota is temporarily unavailable. It will retry automatically." }];
        snapshotsRef.current = next;
        return next;
      });
    }
  }, [commitRuntimeState]);

  const loadVolcengineDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    try {
      setDiagnostics(await getVolcengineDiagnostics());
    } catch (error) {
      setOperationError(errorMessage(error, t.errorUnavailable));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [t.errorUnavailable]);

  const closeControlSurface = useCallback(async () => {
    if (controlOpenRef.current) await closeControlCenterWindow();
    controlOpenRef.current = false;
    setControlOpen(false);
  }, []);

  const openVolcengineDiagnostics = useCallback(async () => {
    try { await closeControlSurface(); }
    catch { setOperationError("Control center close failed."); return; }
    setUpdateOpen(false);
    setDiagnosticsOpen(true);
    void loadVolcengineDiagnostics();
  }, [closeControlSurface, loadVolcengineDiagnostics]);

  const handleVolcengineReconnect = useCallback(async () => {
    setDiagnosticsOpen(true);
    setDiagnosticsLoading(diagnostics === null);
    setReconnecting(true);
    setOperationError(t.reconnectStarted);
    try {
      const value = await reconnectVolcengine();
      setDiagnostics(value);
      await refresh(true);
      setOperationError(t.reconnectSuccess);
    } catch (error) {
      setOperationError(errorMessage(error, t.reconnectFailed));
      try {
        setDiagnostics(await getVolcengineDiagnostics());
      } catch {
        // Preserve the actionable reconnect error when diagnostics also fail.
      }
    } finally {
      setDiagnosticsLoading(false);
      setReconnecting(false);
    }
  }, [diagnostics, refresh, t.reconnectFailed, t.reconnectStarted, t.reconnectSuccess]);

  useEffect(() => {
    void loadStartupState({ getPreferences, getRuntimeState, getDiagnostics: getAppDiagnostics, getAutostartEnabled }).then((startup) => {
      if (startup.preferences) {
        const normalized = normalizeWidgetPreferences(startup.preferences);
        preferencesRef.current = normalized;
        confirmedPreferencesRef.current = normalized;
        setPreferences(normalized);
      }
      if (startup.runtimeState) {
        runtimeStateRef.current = startup.runtimeState;
        setRuntimeState(startup.runtimeState);
      }
      if (startup.diagnostics) setAppDiagnostics(startup.diagnostics);
      if (startup.autostartEnabled !== null) setAutostartState(startup.autostartEnabled);
      if (startup.failures.length > 0) setOperationError(`Some startup checks failed: ${startup.failures.join(", ")}. Available saved state was preserved.`);
      setStartupReady(true);
      void refresh(true);
    });
    return () => {
      for (const timer of consumptionTimers.current.values()) window.clearTimeout(timer);
      consumptionTimers.current.clear();
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let cleanup: () => void = () => {};
    void listenDesktopEvents({ onPreferences: (value) => { const normalized = normalizeWidgetPreferences(value); ++preferenceSaveSequence.current; preferencesRef.current = normalized; confirmedPreferencesRef.current = normalized; setPreferences(normalized); }, onRefresh: () => void refresh(true), onBackgroundSnapshots: (value) => void refresh(false, value), onUpdate: () => checkUpdate(true) }).then((value) => {
      if (cancelled) value(); else cleanup = value;
    }).catch(() => setOperationError("Desktop event listener failed to start."));
    return () => { cancelled = true; cleanup(); };
  }, [checkUpdate, refresh]);

  const checkUpdateRef = useRef(checkUpdate);
  checkUpdateRef.current = checkUpdate;
  useEffect(() => {
    let lastCheck = Number.NEGATIVE_INFINITY;
    const check = () => {
      if (!navigator.onLine || Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      checkUpdateRef.current(false);
    };
    const startup = window.setTimeout(check, 12_000);
    const periodic = window.setInterval(check, 6 * 60 * 60_000);
    window.addEventListener("online", check);
    return () => { window.clearTimeout(startup); window.clearInterval(periodic); window.removeEventListener("online", check); };
  }, []);

  useEffect(() => {
    const refreshWhenActive = () => { if (document.visibilityState === "visible") void refresh(true); };
    window.addEventListener("focus", refreshWhenActive);
    document.addEventListener("visibilitychange", refreshWhenActive);
    return () => {
      window.removeEventListener("focus", refreshWhenActive);
      document.removeEventListener("visibilitychange", refreshWhenActive);
    };
  }, [refresh]);

  useEffect(() => {
    if (hovered || preferences.pinnedProvider || snapshots.length < 2) return;
    const id = window.setInterval(() => setActiveIndex((value) => (value + 1) % snapshots.length), preferences.autoRotateSeconds * 1000);
    return () => window.clearInterval(id);
  }, [hovered, preferences.autoRotateSeconds, preferences.pinnedProvider, snapshots.length]);

  const orderedSnapshots = useMemo(() => {
    const order = normalizeProviderOrder(preferences.providerOrder);
    return [...snapshots].filter((item) => !preferences.hiddenProviders.includes(item.provider)).sort((left, right) => order.indexOf(left.provider) - order.indexOf(right.provider));
  }, [preferences.hiddenProviders, preferences.providerOrder, snapshots]);

  const current = preferences.pinnedProvider
    ? orderedSnapshots.find((item) => item.provider === preferences.pinnedProvider) ?? orderedSnapshots[0]
    : orderedSnapshots[activeIndex % Math.max(1, orderedSnapshots.length)];
  const compactLayout = effectiveCompactLayout(preferences, current?.provider ?? null);
  const stayExpanded = effectiveStayExpanded(preferences);
  // Token experience is not a quota percentage. Keep the quota policy's default
  // reference independent from every person's new token feedback and legacy data.
  const comfortCurve = useMemo(() => personalizeComfortCurve([]), []);
  const resetWatch = useWebsiteResetProbability();
  // User-selected planning scenario; website votes are not a calibrated 24h forecast.
  // Legacy overrides stay dormant until the user moves the restored slider.
  const planningRisk = (preferences.resetRiskManualEnabled ? preferences.resetRiskOverridePercent : null)
    ?? resetWatch?.resetChancePercent ?? null;
  const effectiveResetForecast = codexResetForecast;
  const carryUsageHistory = useMemo(
    () => [...codexDailyUsageHistory, ...runtimeState.dailyUsage.filter((item) => item.provider === "codex")],
    [codexDailyUsageHistory, runtimeState.dailyUsage],
  );
  const carryInPercent = useMemo(
    () => estimateCarryInPercent(runtimeState.dailyRecommendations, carryUsageHistory),
    [carryUsageHistory, runtimeState.dailyRecommendations, usageDay],
  );
  const weeklyRemainingPercent = useMemo(() => {
    if (!current || current.provider !== "codex") return null;
    if (isCodexPlus(current)) return fiveHourRemaining(current);
    return trackedQuotaWindows(current).find(({ period }) => period === "weekly")?.window.remainingPercent ?? null;
  }, [current]);
  const personalUsageCalibration = useMemo(
    () => calibratePersonalUsage(carryUsageHistory, runtimeState.dailyRecommendations),
    [carryUsageHistory, runtimeState.dailyRecommendations, usageDay],
  );
  const localRecommendation = useMemo<DailyRecommendation | null>(() => {
    if (!current || current.provider !== "codex") return null;
    const weeklyWindow = trackedQuotaWindows(current).find(({ period }) => period === "weekly") ?? null;
    if (!weeklyWindow) return null;
    const genericRecommendation = buildMidnightQuotaPlan({
      snapshot: current,
      history: runtimeState.history,
      forecast: effectiveResetForecast,
      riskPercent: planningRisk,
      fatigueKneePercent: comfortCurve.xStarPercent,
      now: planningNow,
    });
    return genericRecommendation;
  }, [planningNow, planningRisk, comfortCurve.xStarPercent, current, effectiveResetForecast, runtimeState.history]);

  const planBasis = localRecommendation?.dayPlan && current?.weeklyWindow?.resetsAt ? {
    localDate: localRecommendation.dayPlan.localDate, anchorAt: localRecommendation.dayPlan.anchorAt,
    remainingPercent: localRecommendation.dayPlan.remainingPercent, resetsAt: new Date(current.weeklyWindow.resetsAt).toISOString(),
  } : null;
  const sharedPlan = useSharedDailyPlan(planBasis,preferences.resetRiskManualEnabled ? preferences.resetRiskOverridePercent ?? null : null);
  const sharedBasis = sharedPlan.plan?.basis ?? planBasis;
  const sharedRisk = sharedPlan.plan ? sharedPlan.plan.risk.value ?? resetWatch?.resetChancePercent ?? 10 : planningRisk ?? 10;
  const dailyRecommendation: DailyRecommendation | null = localRecommendation && sharedBasis ? (() => {
    const target = sharedRecommendation(sharedBasis, sharedRisk);
    const used = Math.max(0, sharedBasis.remainingPercent - (current?.weeklyWindow?.remainingPercent ?? sharedBasis.remainingPercent));
    return { ...localRecommendation, targetPercent: target, safetyCapPercent: sharedBasis.remainingPercent,
      futureDays: (Date.parse(sharedBasis.resetsAt)-Date.parse(sharedBasis.anchorAt))/86400000,
      todayFractionRemaining: Math.max(0,Math.min(1,(Date.parse(`${sharedBasis.localDate}T00:00:00+08:00`)+86400000-Date.parse(sharedBasis.anchorAt))/86400000)),
      todayUsedPercent: used, additionalUsagePercent: Math.max(0,target-used), resetRiskPercent: sharedRisk,
      policyVersion: "shared-account-plan-v1", dayPlan: {...localRecommendation.dayPlan!,...sharedBasis} };
  })() : null;
  const planPeople = comfortUsage?.groups.filter(group => group.deviceIds.length > 0) ?? [];
  const planPerson = sharedPlan.deviceId ? planPeople.find(group => group.deviceIds.includes(sharedPlan.deviceId!)) : planPeople.find(group => group.id === comfortUsage?.localGroupId);
  const localPlanOverrides = !sharedPlan.connected && planPerson && preferences.dailyBudgetLocalDate === usageDay ? {[planPerson.id]:{value:preferences.dailyBudgetPercent,revision:0}} : {};
  const allocation = allocateSharedPlan(dailyRecommendation?.targetPercent ?? 0, planPeople.map(group=>group.id), sharedPlan.plan?.people ?? localPlanOverrides);
  const personalPlanBudget = planPerson ? allocation.allocations[planPerson.id] : preferences.dailyBudgetPercent;
  const totalPlanBudget = planPeople.length ? allocation.total : dailyRecommendation?.targetPercent ?? preferences.dailyBudgetPercent;
  const planStatus = sharedPlan.conflict ? (language === "en" ? "Changed on another device; confirm your edit again" : "其他设备已修改，请重新确认此设置") : sharedPlan.error ? (language === "en" ? "Not synced; local draft retained" : "同步未完成，保留本地设置") : sharedPlan.pending ? (language === "en" ? "Plan pending sync" : "计划待同步") : sharedPlan.plan ? (language === "en" ? "Shared plan synced" : "共享计划已同步") : (language === "en" ? "Local reference plan" : "本地参考计划");
  const planningNote = `${planPerson?.name ?? (language === "en" ? "Unassigned device" : "未分配组员")} · ${planStatus}${allocation.total > (dailyRecommendation?.targetPercent ?? 0) + 0.05 ? ` · ${language === "en" ? "Total exceeds recommendation by" : "合计超出共享建议"} ${(allocation.total-(dailyRecommendation?.targetPercent??0)).toFixed(1)}%` : ""}`;

  useEffect(() => {
    if (!startupReady || current?.provider !== "codex" || !dailyRecommendation) return;
    const now = new Date();
    const localDate = dailyRecommendation.dayPlan?.localDate ?? usageDateKey(now);
    const record = {
      provider: "codex" as const,
      localDate,
      targetPercent: dailyRecommendation.targetPercent,
      safetyCapPercent: dailyRecommendation.safetyCapPercent,
      resetRiskPercent: dailyRecommendation.resetRiskPercent,
      fatigueKneePercent: dailyRecommendation.fatigueKneePercent,
      carryInPercent: dailyRecommendation.carryInPercent,
      policyVersion: dailyRecommendation.policyVersion,
      updatedAt: now.toISOString(),
    };
    const currentRecords = runtimeStateRef.current.dailyRecommendations;
    const nextRecords = upsertDailyRecommendation(currentRecords, record);
    if (nextRecords === currentRecords) return;
    commitRuntimeState({ ...runtimeStateRef.current, dailyRecommendations: nextRecords });
  }, [commitRuntimeState, current?.provider, dailyRecommendation, startupReady]);
  const compactCapsuleRatio = useMemo(() => {
    if (!current || current.provider !== "codex") return null;
    const quotaWindows = trackedQuotaWindows(current);
    const weeklyWindow = quotaWindows.find(({ period }) => period === "weekly") ?? quotaWindows[0] ?? null;
    const todayAdvice = buildTodayQuotaAdvice({
      rateLimitSnapshot: current.rateLimitSnapshot,
      weeklyWindow: weeklyWindow?.window ?? null,
      dailyUsage: codexDailyUsage,
      status: current.status,
      dynamicRecommendation: dailyRecommendation,
    });
    return dailyUsageRatio(todayAdvice.todayUsedPercent, totalPlanBudget);
  }, [codexDailyUsage, current, dailyRecommendation, totalPlanBudget]);
  const compactCapsuleWidth = compactLayout === "capsule"
    ? capsuleLogicalWidth(compactCapsuleRatio, preferences.fontScale)
    : undefined;
  const dailyPersonCosts = useMemo(() => {
    const costs = buildDailyPersonCosts(comfortUsage, planningNow, preferences.personRingColors);
    return comfortUsageError ? { ...costs, partial: true } : costs;
  }, [comfortUsage, comfortUsageError, planningNow, preferences.personRingColors]);

  const savePreferences = useCallback((next: WidgetPreferences) => {
    const sequence = ++preferenceSaveSequence.current;
    const normalized = normalizeWidgetPreferences(next);
    preferencesRef.current = normalized;
    setPreferences(normalized);
    setOperationError(null);
    void updatePreferences(normalized)
      .then(() => { confirmedPreferencesRef.current = normalized; })
      .catch(() => {
        if (preferenceSaveSequence.current !== sequence) return;
        const confirmed = confirmedPreferencesRef.current;
        preferencesRef.current = confirmed;
        setPreferences(confirmed);
        setOperationError("Settings could not be saved. Previous state restored.");
      });
  }, []);

  const planDay = planDateKey(planningNow);

  const saveManualPlan = (field: keyof PersonPlan, value: number | null) => {
    ++planEditSequence.current;
    const day = planDateKey(new Date());
    // Serialize writes so slider events cannot invert the persisted revision order.
    planSaveQueue.current = planSaveQueue.current.catch(() => undefined).then(async () => {
      try {
        await savePersonPlan(day, field, value);
        const next = planPreferences(preferencesRef.current, { [field]: value }, day);
        if (next) savePreferences(next);
      } catch (error) {
        if (error === "sync_not_configured") {
          const next = planPreferences(preferencesRef.current, { [field]: value }, day);
          if (next) savePreferences(next);
        } else setOperationError(language === "en" ? "Personal plan could not be saved. Check this device's person and sync settings." : "个人计划未保存，请检查本机人员归属与同步设置。");
      }
    });
  };

  useEffect(() => {
    if (!startupReady || !sharedPlan.scopeReady || sharedPlan.connected) return;
    let active = true; let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true; const sequence = planEditSequence.current;
      try {
        await planSaveQueue.current;
        const plan = await getPersonPlan(planDay);
        if (active && sequence === planEditSequence.current) {
          const next = planPreferences(preferencesRef.current, plan, planDay);
          if (next) savePreferences(next);
        }
      } catch { if (active) setOperationError(language === "en" ? "Shared personal settings are unavailable; local settings are preserved." : "共享个人配置暂不可用，已保留本地设置。"); }
      finally { pending = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [startupReady, planDay, language, savePreferences, sharedPlan.connected, sharedPlan.scopeReady]);

  const handleUpdateOpen = useCallback(async () => {
    try { await closeControlSurface(); }
    catch { setOperationError("Control center close failed."); return; }
    setDiagnosticsOpen(false);
    if (["idle", "current", "error"].includes(updateState.phase)) {
      checkUpdate(true);
      return;
    }
    setUpdateOpen(true);
  }, [checkUpdate, closeControlSurface, updateState.phase]);

  const handleUpdateDownload = useCallback(() => {
    if (updateState.info) void startUpdateDownload(updateState.info, true);
  }, [startUpdateDownload, updateState.info]);

  const handleUpdateInstall = useCallback(() => {
    const info = updateState.info;
    if (!info) return;
    ++updateSequence.current;
    setUpdateOpen(true);
    setUpdateState({ phase: "installing", info, progress: updateState.progress, error: null });
    void createAutomaticBackup({ schemaVersion: 1, createdAt: new Date().toISOString(), preferences, runtimeState: runtimeStateRef.current })
      .then(() => installAppUpdate())
      .catch((error) => {
      setUpdateState({ phase: "error", info, progress: null, error: errorMessage(error, t.updateFailed) });
      setOperationError(t.updateFailed);
    });
  }, [preferences, t.updateFailed, updateState.info, updateState.progress]);

  const handleUpdateSkip = useCallback(() => {
    const version = updateState.info?.version;
    if (!version) return;
    ++updateSequence.current;
    savePreferences({ ...preferences, skippedUpdateVersion: version });
    setUpdateState(EMPTY_UPDATE_STATE);
    setUpdateOpen(false);
    setOperationError(t.updateSkipped(version));
    void discardAppUpdate();
  }, [preferences, savePreferences, t, updateState.info?.version]);

  const handleUpdateRelease = useCallback(() => {
    void openReleasePage(updateState.info?.releaseUrl).catch(() => setOperationError(t.updateFailed));
  }, [t.updateFailed, updateState.info?.releaseUrl]);

  const backupBundle = useCallback(() => ({
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    appVersion: appDiagnostics?.appVersion ?? "unknown",
    preferences,
    runtimeState,
  }), [appDiagnostics?.appVersion, preferences, runtimeState]);

  const applyBackupBundle = useCallback(async (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Backup file is invalid.");
    const bundle = value as { preferences?: Partial<WidgetPreferences>; runtimeState?: unknown };
    if (!bundle.preferences || !bundle.runtimeState) throw new Error("Backup file is missing settings or history.");
    const nextPreferences = normalizeWidgetPreferences(bundle.preferences);
    const nextRuntime = normalizeRuntimeState(bundle.runtimeState);
    ++preferenceSaveSequence.current;
    await Promise.all([updatePreferences(nextPreferences), updateRuntimeState(nextRuntime)]);
    preferencesRef.current = nextPreferences;
    confirmedPreferencesRef.current = nextPreferences;
    runtimeStateRef.current = nextRuntime;
    setPreferences(nextPreferences);
    setRuntimeState(nextRuntime);
    setOperationError(language === "en" ? "Backup restored." : "备份已恢复。");
  }, [language]);

  const handleExport = useCallback(() => {
    void exportAppData(backupBundle()).then((path) => {
      if (path) setOperationError(language === "en" ? `Backup exported: ${path}` : `备份已导出：${path}`);
    }).catch((error) => setOperationError(errorMessage(error, "Backup export failed.")));
  }, [backupBundle, language]);

  const handleImport = useCallback(() => {
    void importAppData().then((value) => value ? applyBackupBundle(value) : undefined).catch((error) => setOperationError(errorMessage(error, "Backup import failed.")));
  }, [applyBackupBundle]);

  const handleRestore = useCallback(() => {
    void restoreLatestBackup().then((value) => value ? applyBackupBundle(value) : undefined).catch((error) => setOperationError(errorMessage(error, "No automatic backup is available.")));
  }, [applyBackupBundle]);

  const handleCopyDiagnostics = useCallback(() => {
    const report = {
      generatedAt: new Date().toISOString(),
      app: appDiagnostics,
      providers: snapshots.map(({ provider, status, updatedAt }) => ({ provider, status, updatedAt })),
      historySamples: runtimeState.history.length,
      recentEvents: runtimeState.events.slice(0, 10),
    };
    void navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      .then(() => setOperationError(language === "en" ? "Diagnostic report copied." : "诊断报告已复制。"))
      .catch(() => setOperationError(language === "en" ? "Could not copy the diagnostic report." : "无法复制诊断报告。"));
  }, [appDiagnostics, language, runtimeState.events, runtimeState.history.length, snapshots]);

  const handleHover = useCallback((value: boolean) => {
    if (!value && sliderInteracting.current) {
      sliderOutsideCard.current = true;
      return;
    }
    if (value) sliderOutsideCard.current = false;
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setHovered(value);
    if (!value && (stayExpanded || controlOpen || controlOpenRef.current || diagnosticsOpen || updateOpen)) return;
    // Re-centering the native control-center window can fire a fresh mouse
    // enter event. Keep that event from enqueueing a normal widget resize.
    if (value && (controlOpen || controlOpenRef.current)) return;
    if (value && !compact && hoverTargetExpanded.current) return;
    hoverTargetExpanded.current = value;
    if (value) void refresh(true);
    if (value) {
      const sequence = ++hoverSequence.current;
      widgetTransitioning.current = true;
      delete document.documentElement.dataset.widgetCollapsing;
      const crossfade = prepareSurfaceCrossfade();
      setWidgetSurfaceSizing(true);
      setCompact(false);
      void waitForSurfacePaint()
        .then(() => {
          if (hoverSequence.current !== sequence) { crossfade.cancel(); return; }
          crossfade.start();
          return setWidgetExpanded(true, compactLayout, measureExpandedContentHeight());
        })
        .then(() => {
          if (hoverSequence.current !== sequence) return;
          widgetTransitioning.current = false;
          setWidgetSurfaceSizing(false);
          window.dispatchEvent(new Event("resize"));
        })
        .catch(() => {
          if (hoverSequence.current === sequence) {
            widgetTransitioning.current = false;
            setWidgetSurfaceSizing(false);
            setCompact(false);
          }
          setOperationError("Widget expand failed.");
        });
      return;
    }
    const sequence = ++hoverSequence.current;
    collapseTimer.current = window.setTimeout(() => {
      if (hoverSequence.current !== sequence || controlOpenRef.current) return;
      widgetTransitioning.current = true;
      setWidgetSurfaceSizing(true);
      document.documentElement.dataset.widgetCollapsing = "true";
      void setWidgetExpanded(false, compactLayout, undefined, compactCapsuleWidth)
        .then(() => {
          if (hoverSequence.current !== sequence) return;
          const crossfade = prepareSurfaceCrossfade();
          setCompact(true);
          return waitForSurfacePaint().then(() => {
            if (hoverSequence.current === sequence) crossfade.start();
            else crossfade.cancel();
          });
        })
        .then(() => {
          if (hoverSequence.current !== sequence) return;
          widgetTransitioning.current = false;
          setWidgetSurfaceSizing(false);
        })
        .catch(() => {
          if (hoverSequence.current === sequence) {
            widgetTransitioning.current = false;
            setWidgetSurfaceSizing(false);
            setCompact(true);
          }
          setOperationError("Widget collapse failed.");
        });
    }, 60);
  }, [compact, compactCapsuleWidth, compactLayout, controlOpen, diagnosticsOpen, refresh, stayExpanded, updateOpen]);

  const comfortPromptKey = comfortPrompt ? `${comfortPrompt.personId ?? ""}:${comfortPrompt.localDate}` : null;
  useEffect(() => {
    if (!comfortPromptKey) {
      autoExpandedComfortPrompt.current = null;
      return;
    }
    if (controlOpen || autoExpandedComfortPrompt.current === comfortPromptKey) return;
    autoExpandedComfortPrompt.current = comfortPromptKey;
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    hoverTargetExpanded.current = true;
    delete document.documentElement.dataset.widgetCollapsing;
    widgetTransitioning.current = true;
    setWidgetSurfaceSizing(true);
    setCompact(false);
    const sequence = ++hoverSequence.current;
    void waitForSurfacePaint()
      .then(() => hoverSequence.current === sequence ? setWidgetExpanded(true, compactLayout, measureExpandedContentHeight()) : undefined)
      .then(() => {
        if (hoverSequence.current !== sequence) return;
        widgetTransitioning.current = false;
        setWidgetSurfaceSizing(false);
        window.dispatchEvent(new Event("resize"));
      })
      .catch(() => {
        if (hoverSequence.current === sequence) {
          widgetTransitioning.current = false;
          setWidgetSurfaceSizing(false);
          setOperationError("Widget expand failed.");
        }
      });
    return () => {
      if (hoverSequence.current !== sequence) return;
      hoverSequence.current += 1;
      widgetTransitioning.current = false;
      setWidgetSurfaceSizing(false);
    };
  }, [comfortPromptKey, compactLayout, controlOpen]);

  const handleSliderInteraction = useCallback((active: boolean) => {
    sliderInteracting.current = active;
    if (active) {
      sliderOutsideCard.current = false;
      if (collapseTimer.current !== null) {
        window.clearTimeout(collapseTimer.current);
        collapseTimer.current = null;
      }
      setHovered(true);
      return;
    }
    if (sliderOutsideCard.current) {
      sliderOutsideCard.current = false;
      handleHover(false);
    }
  }, [handleHover]);

  useEffect(() => {
    const finishStrandedSliderInteraction = () => {
      if (!sliderInteracting.current) return;
      sliderInteracting.current = false;
      if (!sliderOutsideCard.current) return;
      sliderOutsideCard.current = false;
      handleHover(false);
    };
    // The native range input owns its drag path. These window-level listeners
    // cover releases outside the webview and focus loss during a native window
    // transition, so auto-collapse cannot stay blocked.
    window.addEventListener("pointerup", finishStrandedSliderInteraction, true);
    window.addEventListener("pointercancel", finishStrandedSliderInteraction, true);
    window.addEventListener("blur", finishStrandedSliderInteraction);
    return () => {
      window.removeEventListener("pointerup", finishStrandedSliderInteraction, true);
      window.removeEventListener("pointercancel", finishStrandedSliderInteraction, true);
      window.removeEventListener("blur", finishStrandedSliderInteraction);
    };
  }, [handleHover]);

  useEffect(() => {
    if (!stayExpanded || controlOpen) return;
    if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    hoverTargetExpanded.current = true;
    delete document.documentElement.dataset.widgetCollapsing;
    widgetTransitioning.current = true;
    setWidgetSurfaceSizing(true);
    setCompact(false);
    const sequence = ++hoverSequence.current;
    void waitForSurfacePaint()
      .then(() => hoverSequence.current === sequence ? setWidgetExpanded(true, compactLayout, measureExpandedContentHeight()) : undefined)
      .then(() => {
        if (hoverSequence.current !== sequence) return;
        widgetTransitioning.current = false;
        setWidgetSurfaceSizing(false);
        window.dispatchEvent(new Event("resize"));
      })
      .catch(() => {
        if (hoverSequence.current === sequence) {
          widgetTransitioning.current = false;
          setWidgetSurfaceSizing(false);
          setOperationError("Widget expand failed.");
        }
      });
    return () => {
      if (hoverSequence.current !== sequence) return;
      hoverSequence.current += 1;
      widgetTransitioning.current = false;
      setWidgetSurfaceSizing(false);
    };
  }, [compactLayout, controlOpen, stayExpanded]);

  useEffect(() => {
    if (!compact || stayExpanded || controlOpen || widgetTransitioning.current) return;
    void setWidgetExpanded(false, compactLayout, undefined, compactCapsuleWidth).catch(() => setOperationError("Widget layout resize failed."));
  }, [compact, compactCapsuleWidth, compactLayout, controlOpen, stayExpanded]);

  useEffect(() => {
    if (compact || controlOpen) return;
    const card = document.querySelector<HTMLElement>(".quota-card");
    if (!card) return;
    let animationFrame: number | null = null;
    let lastHeight = 0;
    const syncHeight = () => {
      animationFrame = null;
      if (widgetTransitioning.current || controlOpenRef.current) return;
      // Decorative layers intentionally extend beyond the rounded card. Their
      // scroll overflow must not inflate the native window at screen edges.
      const contentHeight = measureSurfaceHeight(card);
      if (contentHeight === undefined || Math.abs(contentHeight - lastHeight) < 1) return;
      lastHeight = contentHeight;
      void resizeWidgetToContent(contentHeight).catch(() => setOperationError("Widget resize failed."));
    };
    const scheduleSync = () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(syncHeight);
    };
    scheduleSync();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSync);
    resizeObserver?.observe(card);
    window.addEventListener("resize", scheduleSync);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSync);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, [compact, controlOpen]);

  if (!current) return <div className="loading-card" aria-label={t.loadingQuota}><span /><span /><span /></div>;

  if (compact) {
    const selectCompactProvider = (provider: ProviderId) => {
      const index = orderedSnapshots.findIndex((item) => item.provider === provider);
      if (index >= 0) setActiveIndex(index);
    };
    return compactLayout === "bar" ? (
      <QuotaIsland
        snapshot={current}
        snapshots={orderedSnapshots}
        language={language}
        colorTheme={preferences.colorTheme}
        accentColor={preferences.accentColor}
        resolvedAppearance={resolvedAppearance}
        onSelectProvider={selectCompactProvider}
        onDrag={() => { void startDragging().catch(() => setOperationError("Widget drag failed.")); }}
        onActivate={() => handleHover(true)}
      />
    ) : (
      <QuotaOrb
        snapshot={current}
        resetWatch={resetWatch}
        language={language}
        compactLayout={compactLayout}
        colorTheme={preferences.colorTheme}
        accentColor={preferences.accentColor}
        resolvedAppearance={resolvedAppearance}
        dailyUsage={codexDailyUsage}
        dailyRecommendation={dailyRecommendation}
        dailyBudgetPercent={totalPlanBudget}
        fontScale={preferences.fontScale}
        onDrag={() => { void startDragging().catch(() => setOperationError("Widget drag failed.")); }}
        onActivate={() => handleHover(true)}
      />
    );
  }

  return (
    <QuotaCard
      snapshot={current}
      snapshots={orderedSnapshots}
      preferences={{...preferences,dailyBudgetPercent:personalPlanBudget,resetRiskManualEnabled:sharedPlan.plan ? sharedPlan.plan.risk.value!==null : preferences.resetRiskManualEnabled}}
      sharedBudgetPercent={totalPlanBudget}
      planningNote={planningNote}
      codexDailyUsage={codexDailyUsage}
      dailyPersonCosts={dailyPersonCosts}
      dailyRecommendation={dailyRecommendation}
      personalUsageCalibration={personalUsageCalibration}
      comfortPrompt={comfortPrompt}
      comfortSaving={comfortSaving}
      comfortSaveError={comfortSaveError ?? (comfortSyncError ? (language === "en" ? "Synced comfort records could not be read; local records are preserved." : "同步体验暂时无法读取，本地记录已保留。") : null)}
      onComfortSelect={handleComfortSelect}
      onDailyBudgetChange={(value) => { if (planPerson && sharedPlan.connected) sharedPlan.change("person", value, planPerson.id); else if (sharedPlan.scopeReady) saveManualPlan("dailyBudgetPercent", value); }}
      onResetRiskChange={(value) => { if (sharedPlan.connected) sharedPlan.change("risk", value); else if (sharedPlan.scopeReady) saveManualPlan("resetRiskOverridePercent", value); }}
      onResetDailyBudget={() => {
        if (!dailyRecommendation) return;
        if(planPerson && sharedPlan.connected){sharedPlan.change("person",null,planPerson.id);return;}
        if (sharedPlan.scopeReady) {
          saveManualPlan("dailyBudgetPercent", null);
          savePreferences({
            ...preferencesRef.current,
            dailyBudgetPercent: dailyRecommendation.targetPercent / Math.max(1, planPeople.length),
            dailyBudgetLocalDate: null,
          });
        }
      }}
      onSliderInteraction={handleSliderInteraction}
      resolvedAppearance={resolvedAppearance}
      onSelectProvider={(provider: ProviderId) => {
        const index = orderedSnapshots.findIndex((item) => item.provider === provider);
        if (index < 0) return;
        setActiveIndex(index);
        if (preferences.pinnedProvider) savePreferences({ ...preferences, pinnedProvider: provider });
      }}
      onLanguage={() => savePreferences({ ...preferences, language: nextLanguage(language) })}
      onToggleStayExpanded={() => savePreferences({ ...preferences, stayExpanded: !preferences.stayExpanded })}
      onReorderProviders={(providerOrder) => {
        const visibleOrder = providerOrder.filter((provider) => orderedSnapshots.some((item) => item.provider === provider));
        const nextIndex = visibleOrder.indexOf(current.provider);
        if (nextIndex >= 0) setActiveIndex(nextIndex);
        savePreferences({ ...preferences, providerOrder });
      }}
      onLock={() => { setOperationError(null); void setAlwaysOnTop(!preferences.alwaysOnTop).then((value) => { const normalized = normalizeWidgetPreferences(value); ++preferenceSaveSequence.current; preferencesRef.current = normalized; confirmedPreferencesRef.current = normalized; setPreferences(normalized); }).catch(() => setOperationError("Always-on-top toggle failed.")); }}
      onDrag={() => { void startDragging().catch(() => setOperationError("Widget drag failed.")); }}
      onHover={handleHover}
      onRefresh={() => refresh(true)}
      onDiagnostics={openVolcengineDiagnostics}
      onCloseDiagnostics={() => setDiagnosticsOpen(false)}
      onReconnect={() => void handleVolcengineReconnect()}
      diagnostics={diagnostics}
      diagnosticsOpen={diagnosticsOpen}
      diagnosticsLoading={diagnosticsLoading}
      reconnecting={reconnecting}
      recentCodexReset={recentCodexReset}
      resetWatch={resetWatch}
      resetForecast={effectiveResetForecast}
      onOpenResetForecast={(url) => void openExternalUrl(url).catch(() => setOperationError("Reset forecast could not be opened."))}
      paceBaselines={runtimeState.dailyPaceBaselines}
      history={runtimeState.history}
      dailyUsage={runtimeState.dailyUsage}
      updateState={updateState}
      updateOpen={updateOpen}
      onUpdateOpen={handleUpdateOpen}
      onUpdateClose={() => setUpdateOpen(false)}
      onUpdateDownload={handleUpdateDownload}
      onUpdateInstall={handleUpdateInstall}
      onUpdateRetry={() => checkUpdate(true)}
      onUpdateLater={() => setUpdateOpen(false)}
      onUpdateSkip={handleUpdateSkip}
      onUpdateRelease={handleUpdateRelease}
      controlOpen={controlOpen}
      onControlOpen={() => {
        controlOpenRef.current = true;
        // Cancel an already queued collapse before it can shrink the control center.
        ++hoverSequence.current;
        if (collapseTimer.current !== null) {
          window.clearTimeout(collapseTimer.current);
          collapseTimer.current = null;
        }
        hoverTargetExpanded.current = true;
        widgetTransitioning.current = false;
        delete document.documentElement.dataset.widgetCollapsing;
        setWidgetSurfaceSizing(false);
        setCompact(false);
        setDiagnosticsOpen(false);
        setUpdateOpen(false);
        setControlOpen(true);
        void openControlCenterWindow().catch(() => {
          controlOpenRef.current = false;
          setControlOpen(false);
          setOperationError(language === "en" ? "Control center could not be opened." : "无法打开控制中心。");
        });
        void getAppDiagnostics().then(setAppDiagnostics).catch(() => undefined);
      }}
      controlCenter={(
        <ControlCenter
          preferences={preferences}
          language={language}
          comfortFeedback={runtimeState.comfortFeedback}
          dailyUsage={runtimeState.dailyUsage}
          dailyUsageHistory={codexDailyUsageHistory}
          dailyRecommendation={dailyRecommendation}
          weeklyRemainingPercent={weeklyRemainingPercent}
          carryInPercent={carryInPercent}
          onComfortFeedback={handleComfortHistoryChange}
          comfortUsage={comfortUsage}
          comfortPersonId={comfortPersonId}
          comfortUsageError={comfortUsageError}
          comfortSaving={comfortSaving}
          comfortSaveError={comfortSaveError ?? (comfortSyncError ? (language === "en" ? "Synced comfort records could not be read; local records are preserved." : "同步体验暂时无法读取，本地记录已保留。") : null)}
          onComfortPersonChange={handleComfortPersonChange}
          onComfortSnapshotRefresh={handleComfortSnapshotRefresh}
          onUsageGroupsChange={refreshComfortUsage}
          onCheckUpdate={() => void handleUpdateOpen()}
          onClose={() => {
            void closeControlSurface().catch(() => setOperationError("Control center close failed."));
          }}
          onRefresh={() => { void refresh(true); }}
          onOpenCodexResets={() => void openExternalUrl(CODEX_RESETS_URL).catch(() => setOperationError(language === "en" ? "Codex Resets could not be opened." : "无法打开 Codex Resets。"))}
          onDrag={() => { void startDragging().catch(() => setOperationError("Control center drag failed.")); }}
          onPreferences={savePreferences}
          onSliderInteraction={handleSliderInteraction}
          autostartEnabled={autostartEnabled}
          onAutostart={(enabled) => {
            const previous = autostartEnabled;
            setAutostartState(enabled);
            void setAutostartEnabled(enabled).then(setAutostartState).catch(() => { setAutostartState(previous); setOperationError(language === "en" ? "Autostart could not be changed." : "无法修改开机启动设置。"); });
          }}
        />
      )}
      isConsuming={consumingProviders.has(current.provider)}
      consumingProviders={consumingProviders}
      notice={operationError}
    />
  );
}
