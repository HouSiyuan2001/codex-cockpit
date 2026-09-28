// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { EMPTY_RUNTIME_STATE } from "./lib/activity";
import { DEFAULT_WIDGET_PREFERENCES } from "./lib/preferences";
import type { ComfortFeedbackRecord, ProviderSnapshot, ResetForecast, ResetWatch, RuntimeState } from "./types";
import { fetchCodexResetForecast, fetchWebsiteResetProbability, setWidgetExpanded, openControlCenterWindow } from "./lib/bridge";
import type { TokeiUsage } from "./lib/tokeiUsage";
import { savePersonPlan, planDateKey } from "./lib/personPlanSync";

vi.mock("./lib/personPlanSync", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/personPlanSync")>(),
  getPersonPlan: vi.fn(async () => ({})),
  savePersonPlan: vi.fn(async () => undefined),
}));

const LOCAL_DATE = "2026-09-08";

const mocks = vi.hoisted(() => ({
  initialRuntime: null as RuntimeState | null,
  comfortUsage: null as TokeiUsage | null,
  refreshComfortUsage: vi.fn<() => Promise<TokeiUsage>>(),
  fetchSnapshots: vi.fn(),
  getPreferences: vi.fn(),
  getRuntimeState: vi.fn(),
  updateRuntimeState: vi.fn(),
  sendDesktopNotification: vi.fn(),
  recordSnapshotActivity: vi.fn(),
  getSyncedComfortFeedback: vi.fn(),
  promptTarget: null as { localDate: string; isCatchUp: boolean } | null,
}));

vi.mock("./lib/usageSyncBridge", () => ({
  getSyncedComfortFeedback: () => mocks.getSyncedComfortFeedback(),
}));

vi.mock("./components/QuotaCard", () => ({
  capsuleLogicalWidth: () => 100,
  QuotaIsland: ({ onActivate }: { onActivate: () => void }) => <button onClick={onActivate}>expand</button>,
  QuotaOrb: ({ onActivate }: { onActivate: () => void }) => <button onClick={onActivate}>expand</button>,
  QuotaCard: ({ onHover, onControlOpen, onRefresh, controlCenter, resetForecast, resetWatch, dailyRecommendation, onResetRiskChange, comfortPrompt }: { onHover: (value: boolean) => void; onControlOpen: () => void; onRefresh: () => void; controlCenter: React.ReactNode; resetForecast: ResetForecast | null; resetWatch: ResetWatch | null; dailyRecommendation: { resetRiskPercent: number } | null; onResetRiskChange: (value: number | null) => void; comfortPrompt: { localDate: string } | null }) => <div>
    <button onClick={() => { onHover(false); onControlOpen(); }}>leave then open control</button>
    <button onClick={() => onHover(false)}>leave widget</button>
    <output data-testid="pending-comfort">{comfortPrompt?.localDate ?? "none"}</output>
    <button onClick={onRefresh}>quota refresh</button>
    <output data-testid="reset-sources">{JSON.stringify({ model: resetForecast?.tomorrowRiskPercent, website: resetWatch?.resetChancePercent, planning: dailyRecommendation?.resetRiskPercent })}</output>
    <button onClick={() => onResetRiskChange(70)}>manual risk</button>
    <button onClick={() => onResetRiskChange(null)}>website risk</button>
    {controlCenter}
  </div>,
}));

vi.mock("./components/ControlCenter", () => ({
  ControlCenter: (props: {
    comfortFeedback: ComfortFeedbackRecord[];
    comfortSaveError: string | null;
    onComfortFeedback: (date: string, comfort: "comfortable") => void;
    onComfortSnapshotRefresh: (date: string) => void;
  }) => <section>
    <button onClick={() => props.onComfortFeedback(LOCAL_DATE, "comfortable")}>save comfort</button>
    <button onClick={() => props.onComfortSnapshotRefresh(LOCAL_DATE)}>refresh token snapshot</button>
    <output data-testid="comfort-state">{JSON.stringify(props.comfortFeedback)}</output>
    {props.comfortSaveError ? <p role="alert">{props.comfortSaveError}</p> : null}
  </section>,
}));

vi.mock("./lib/useComfortUsage", () => ({
  useComfortUsage: () => ({
    data: mocks.comfortUsage,
    error: false,
    refresh: mocks.refreshComfortUsage,
    localDeviceId: "device-local",
  }),
}));

vi.mock("./lib/activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/activity")>();
  return { ...actual, recordSnapshotActivity: (...args: unknown[]) => mocks.recordSnapshotActivity(...args) };
});

vi.mock("./lib/comfortFeedback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/comfortFeedback")>();
  return {
    ...actual,
    getPersonComfortPromptTarget: () => mocks.promptTarget,
    nextComfortReminderAt: () => new Date(Date.now() + 86_400_000),
  };
});

vi.mock("./lib/bridge", () => ({
  isTauri: () => false,
  createAutomaticBackup: vi.fn(async () => undefined),
  exportAppData: vi.fn(async () => null),
  fetchCodexResetForecast: vi.fn(async () => null),
  fetchWebsiteResetProbability: vi.fn(async () => null),
  fetchSnapshots: (...args: unknown[]) => mocks.fetchSnapshots(...args),
  getAppDiagnostics: vi.fn(async () => ({ appVersion: "test", platform: "test", configDirectory: "/tmp", preferencesBackupAvailable: false, runtimeBackupAvailable: false })),
  getAutostartEnabled: vi.fn(async () => false),
  getPreferences: (...args: unknown[]) => mocks.getPreferences(...args),
  getRuntimeState: (...args: unknown[]) => mocks.getRuntimeState(...args),
  getVolcengineDiagnostics: vi.fn(async () => null),
  importAppData: vi.fn(async () => null),
  listenDesktopEvents: vi.fn(async () => () => undefined),
  openControlCenterWindow: vi.fn(async () => undefined),
  closeControlCenterWindow: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  reconnectVolcengine: vi.fn(async () => null),
  resizeWidgetToContent: vi.fn(async () => undefined),
  restoreLatestBackup: vi.fn(async () => null),
  sendDesktopNotification: (...args: unknown[]) => mocks.sendDesktopNotification(...args),
  setAlwaysOnTop: vi.fn(async () => DEFAULT_WIDGET_PREFERENCES),
  setAutostartEnabled: vi.fn(async (enabled: boolean) => enabled),
  setWidgetExpanded: vi.fn(async () => undefined),
  startDragging: vi.fn(async () => undefined),
  updatePreferences: vi.fn(async () => undefined),
  updateRuntimeState: (...args: unknown[]) => mocks.updateRuntimeState(...args),
}));

vi.mock("./lib/appUpdate", () => ({
  checkForAppUpdate: vi.fn(async () => null),
  discardAppUpdate: vi.fn(async () => undefined),
  downloadAppUpdate: vi.fn(async () => undefined),
  installAppUpdate: vi.fn(async () => undefined),
  openReleasePage: vi.fn(async () => undefined),
}));

vi.mock("./lib/windowTransition", () => ({
  prepareSurfaceCrossfade: () => ({ start: vi.fn(), cancel: vi.fn() }),
  waitForSurfacePaint: vi.fn(async () => undefined),
}));

const snapshot: ProviderSnapshot = {
  provider: "codex",
  displayName: "CODEX",
  plan: "PRO",
  shortWindow: null,
  weeklyWindow: null,
  resetCredits: null,
  updatedAt: "2026-09-10T04:00:00.000Z",
  status: "ok",
  message: null,
};

const tokenSnapshot = {
  localDate: LOCAL_DATE,
  observedAt: "2026-09-09T00:00:00.000Z",
  metricVersion: "p020-person-calendar-token-v1",
  coverage: "complete" as const,
  inputTokens: 4_000_000,
  cachedInputTokens: 1_000_000,
  outputTokens: 1_000_000,
  reasoningTokens: 500_000,
  totalTokens: 6_000_000,
  models: [],
  deviceIds: ["device-local"],
  missingDeviceIds: [],
  incompleteDeviceIds: [],
};

function feedback(comfort: ComfortFeedbackRecord["comfort"] = "idle"): ComfortFeedbackRecord {
  return {
    localDate: LOCAL_DATE,
    observedAt: "2026-09-09T00:00:00.000Z",
    comfort,
    personId: "person-a",
    personName: "成员甲",
    tokenSnapshot,
    observedUsedPercent: null,
    usageObservedAt: null,
    usageCoverage: "unavailable",
    usageSource: "unavailable",
    curveVersion: "p014-t014-ordinal-map-v3",
  };
}

function usage(): TokeiUsage {
  return {
    fetchedAt: "2026-09-10T04:00:00.000Z",
    status: "ready",
    devices: [],
    warnings: [],
    projectBreakdownAvailable: false,
    groups: [{ id: "person-a", name: "成员甲", deviceIds: ["device-local"] }],
    defaultGroupId: "person-a",
  };
}

beforeEach(() => {
  vi.mocked(savePersonPlan).mockReset().mockResolvedValue(undefined);
  vi.mocked(fetchCodexResetForecast).mockReset().mockResolvedValue(null);
  vi.mocked(fetchWebsiteResetProbability).mockReset().mockResolvedValue(null);
  mocks.getSyncedComfortFeedback.mockReset().mockResolvedValue([]);
  mocks.promptTarget = null;
  mocks.initialRuntime = { ...structuredClone(EMPTY_RUNTIME_STATE), comfortPersonId: "person-a", comfortFeedback: [feedback()] };
  mocks.comfortUsage = usage();
  mocks.fetchSnapshots.mockReset().mockResolvedValue([snapshot]);
  mocks.getPreferences.mockReset().mockResolvedValue({ ...DEFAULT_WIDGET_PREFERENCES, quietHoursStart: 0, quietHoursEnd: 0 });
  mocks.getRuntimeState.mockReset().mockImplementation(async () => structuredClone(mocks.initialRuntime));
  mocks.updateRuntimeState.mockReset().mockResolvedValue(undefined);
  mocks.sendDesktopNotification.mockReset().mockResolvedValue(true);
  mocks.refreshComfortUsage.mockReset().mockImplementation(async () => usage());
  mocks.recordSnapshotActivity.mockReset().mockImplementation((state: RuntimeState) => ({ state, createdEvents: [], notificationCandidates: [] }));
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function expandApp(): Promise<void> {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "expand" }));
  await screen.findByRole("button", { name: "save comfort" });
}

describe("App comfort persistence regressions", () => {
  it("collapses with an unanswered comfort check-in and shows it again on expand", async () => {
    mocks.initialRuntime = { ...structuredClone(EMPTY_RUNTIME_STATE), comfortPersonId: "person-a" };
    mocks.promptTarget = { localDate: LOCAL_DATE, isCatchUp: true };

    render(<App />);
    expect(await screen.findByTestId("pending-comfort")).toHaveTextContent(LOCAL_DATE);
    await waitFor(() => expect(vi.mocked(setWidgetExpanded).mock.calls.some(call => call[0] === true)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "leave widget" }));
    await waitFor(() => expect(vi.mocked(setWidgetExpanded).mock.calls.some(call => call[0] === false)).toBe(true));
    expect(await screen.findByRole("button", { name: "expand" })).toBeInTheDocument();
    expect(mocks.initialRuntime.comfortFeedback).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "expand" }));
    expect(await screen.findByTestId("pending-comfort")).toHaveTextContent(LOCAL_DATE);
  });
  it("cancels pending collapse when control center opens", async () => {
    await expandApp();
    await waitFor(() => expect(vi.mocked(setWidgetExpanded).mock.calls.some(call => call[0] === true)).toBe(true));
    vi.mocked(setWidgetExpanded).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "leave then open control" }));
    await waitFor(() => expect(openControlCenterWindow).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(vi.mocked(setWidgetExpanded).mock.calls.some(call => call[0] === false)).toBe(false);
  });
  it("defaults to website risk, supports a persisted manual scenario, and restores website risk", async () => {
    mocks.fetchSnapshots.mockResolvedValue([{ ...snapshot, updatedAt: new Date().toISOString(), weeklyWindow: { remainingPercent: 26, windowSeconds: 604800, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString() } }]);
    mocks.getPreferences.mockResolvedValue({ ...DEFAULT_WIDGET_PREFERENCES, resetRiskOverridePercent: 10 });
    vi.mocked(fetchCodexResetForecast).mockResolvedValue({ score: 67.6, tomorrowRiskPercent: 67.6, windowHours: 24, fetchedAt: new Date().toISOString(), resetAnnounced: false, sourceUrl: "https://codex-resets.com/" });
    vi.mocked(fetchWebsiteResetProbability).mockResolvedValue({ level: "elevated", resetChancePercent: 83, checkedAt: new Date().toISOString(), observedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), episodeId: "test-ballot" });
    await expandApp();
    expect(screen.getByTestId("reset-sources")).toHaveTextContent('"model":67.6');
    expect(screen.getByTestId("reset-sources")).toHaveTextContent('"website":83');
    expect(screen.getByTestId("reset-sources")).toHaveTextContent('"planning":83');
    fireEvent.click(screen.getByRole("button", { name: "manual risk" }));
    await waitFor(() => expect(screen.getByTestId("reset-sources")).toHaveTextContent('"planning":70'));
    expect(savePersonPlan).toHaveBeenLastCalledWith(planDateKey(new Date()), "resetRiskOverridePercent", 70);
    fireEvent.click(screen.getByRole("button", { name: "website risk" }));
    await waitFor(() => expect(screen.getByTestId("reset-sources")).toHaveTextContent('"planning":83'));
    expect(savePersonPlan).toHaveBeenLastCalledWith(planDateKey(new Date()), "resetRiskOverridePercent", null);
  });
  it("reports a failed sync read without clearing feedback", async () => {
    mocks.getSyncedComfortFeedback.mockRejectedValueOnce(new Error("comfort_snapshot_invalid"));
    await expandApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("同步体验暂时无法读取，本地记录已保留。");
    expect(screen.getByTestId("comfort-state")).toHaveTextContent('"comfort":"idle"');
  });
  it("merges a sync result against current feedback, preserving edits made while it loads", async () => {
    let resolveSync!: (value: ComfortFeedbackRecord[]) => void;
    mocks.getSyncedComfortFeedback.mockReturnValueOnce(new Promise<ComfortFeedbackRecord[]>(resolve => { resolveSync = resolve; }));
    await expandApp();
    fireEvent.click(screen.getByRole("button", { name: "save comfort" }));
    await waitFor(() => expect(screen.getByTestId("comfort-state")).toHaveTextContent('"comfort":"comfortable"'));
    await waitFor(() => expect(mocks.updateRuntimeState).toHaveBeenCalled());
    resolveSync([feedback(), { ...feedback(), personId: "person-b" }]);
    await waitFor(() => {
      const persisted = mocks.updateRuntimeState.mock.calls.at(-1)?.[0] as RuntimeState;
      expect(persisted.comfortFeedback.find(r => r.personId === "person-a")?.comfort).toBe("comfortable");
      expect(persisted.comfortFeedback.find(r => r.personId === "person-b")).toBeDefined();
    });
  });
  it("preserves feedback saved while a quota notification is pending", async () => {
    let resolveNotification!: (value: boolean) => void;
    const pendingNotification = new Promise<boolean>((resolve) => { resolveNotification = resolve; });
    mocks.recordSnapshotActivity
      .mockImplementationOnce((state: RuntimeState) => ({ state, createdEvents: [], notificationCandidates: [] }))
      .mockImplementationOnce((state: RuntimeState) => ({
        state: { ...state, events: [{ id: "quota-event", provider: "codex", kind: "quota", occurredAt: new Date().toISOString(), title: "Quota changed", detail: "test" }, ...state.events] },
        createdEvents: [],
        notificationCandidates: [{ key: "quota-event", event: { id: "quota-event", provider: "codex", kind: "quota", occurredAt: new Date().toISOString(), title: "Quota changed", detail: "test" } }],
      }));
    mocks.sendDesktopNotification.mockReturnValueOnce(pendingNotification);

    await expandApp();
    await waitFor(() => expect(mocks.sendDesktopNotification).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "save comfort" }));
    await waitFor(() => expect(screen.getByTestId("comfort-state")).toHaveTextContent('"comfort":"comfortable"'));

    resolveNotification(true);
    await waitFor(() => {
      const persisted = mocks.updateRuntimeState.mock.calls.at(-1)?.[0] as RuntimeState;
      expect(persisted.comfortFeedback[0]?.comfort).toBe("comfortable");
      expect(persisted.events[0]?.id).toBe("quota-event");
    });
  });

  it("keeps a complete saved snapshot when an explicit token refresh fails", async () => {
    mocks.refreshComfortUsage.mockRejectedValueOnce(new Error("offline"));
    await expandApp();
    await waitFor(() => expect(mocks.recordSnapshotActivity).toHaveBeenCalledTimes(2));
    mocks.updateRuntimeState.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "refresh token snapshot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("刷新失败，已保留原来的分摊记录。");
    expect(screen.getByTestId("comfort-state")).toHaveTextContent('"coverage":"complete"');
    expect(screen.getByTestId("comfort-state")).toHaveTextContent('"totalTokens":6000000');
    expect(mocks.updateRuntimeState).not.toHaveBeenCalled();
  });
});
