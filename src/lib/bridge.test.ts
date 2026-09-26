import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RUNTIME_STATE } from "./activity";
import {
  fetchCodexDailyUsage,
  fetchCodexDailyUsageHistory,
  getVolcengineDiagnostics,
  listenDesktopEvents,
  openControlCenterWindow,
  setControlCenterCalendarOpen,
  closeControlCenterWindow,
  openExternalUrl,
  reconnectVolcengine,
  resizeWidgetToContent,
  setWidgetExpanded,
  startDragging,
  updatePreferences,
  updateRuntimeState,
} from "./bridge";
import { DEFAULT_WIDGET_PREFERENCES } from "./preferences";

const api = vi.hoisted(() => ({
  calls: [] as string[],
  invoke: vi.fn(async (command: string) => {
    api.calls.push(`start:${command}`);
    await Promise.resolve();
    api.calls.push(`end:${command}`);
  }),
  currentMonitor: vi.fn(async () => ({
    workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
  })),
  startDragging: vi.fn(async () => undefined),
  outerPosition: vi.fn(async () => ({ x: 120, y: 160 })),
  getCurrentWindow: vi.fn(() => ({
    startDragging: api.startDragging,
    outerPosition: api.outerPosition,
  })),
}));
const events = vi.hoisted(() => ({ listen: vi.fn() }));
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async () => undefined) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: api.currentMonitor, getCurrentWindow: api.getCurrentWindow }));
vi.mock("@tauri-apps/api/event", () => ({ listen: events.listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl }));

beforeEach(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  await closeControlCenterWindow();
  vi.clearAllMocks();
  api.calls.length = 0;
  events.listen.mockReset();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

describe("widget transitions", () => {
  it("passes the reset dashboard URL to the native opener", async () => {
    const url = "https://codex-reset-risk-dashboard.xr08255920.workers.dev/";
    await openExternalUrl(url);
    expect(opener.openUrl).toHaveBeenCalledWith(url);
  });

  it("passes the monitor work area to the Rust expansion command", async () => {
    await setWidgetExpanded(true);
    expect(api.invoke).toHaveBeenCalledWith("expand_widget", {
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
      compactLayout: "float",
    });
  });

  it("finishes a native drag against the active monitor work area", async () => {
    const timer: { tick: () => void } = { tick: () => undefined };
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      setInterval: vi.fn((callback: () => void) => {
        timer.tick = callback;
        return 7;
      }),
      clearInterval: vi.fn(),
    });

    await startDragging();
    expect(api.invoke).toHaveBeenCalledWith("begin_widget_drag");
    timer.tick();
    await Promise.resolve();
    timer.tick();
    await Promise.resolve();
    timer.tick();
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith("finish_widget_drag", {
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    }));
  });

  it("passes bar sizing intent to both transition commands", async () => {
    await setWidgetExpanded(true, "bar");
    await setWidgetExpanded(false, "bar");
    expect(api.invoke).toHaveBeenCalledWith("expand_widget", expect.objectContaining({ compactLayout: "bar" }));
    expect(api.invoke).toHaveBeenCalledWith("collapse_widget", { compactLayout: "bar" });
  });

  it("passes the focused Codex capsule geometry to both transition commands", async () => {
    await setWidgetExpanded(true, "capsule");
    await setWidgetExpanded(false, "capsule");
    expect(api.invoke).toHaveBeenCalledWith("expand_widget", expect.objectContaining({ compactLayout: "capsule" }));
    expect(api.invoke).toHaveBeenCalledWith("collapse_widget", { compactLayout: "capsule" });
  });

  it("passes content-driven capsule width into the native collapse command", async () => {
    await setWidgetExpanded(false, "capsule", undefined, 122);
    expect(api.invoke).toHaveBeenCalledWith("collapse_widget", { compactLayout: "capsule", compactWidth: 122 });
  });

  it("passes the painted card height into the initial expansion", async () => {
    await setWidgetExpanded(true, "capsule", 828);
    expect(api.invoke).toHaveBeenCalledWith("expand_widget", expect.objectContaining({
      compactLayout: "capsule",
      contentHeight: 828,
    }));
  });

  it("dispatches a reversal without waiting for the running animation", async () => {
    let finishExpansion!: () => void;
    api.invoke.mockImplementationOnce(async () => new Promise<void>((resolve) => { finishExpansion = resolve; }));
    const expansion = setWidgetExpanded(true);
    await vi.waitFor(() => expect(finishExpansion).toBeTypeOf("function"));
    const collapse = setWidgetExpanded(false);
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledWith("collapse_widget", { compactLayout: "float" }));
    finishExpansion();
    await Promise.all([expansion, collapse]);
  });

  it("passes measured content height and monitor bounds to the resize command", async () => {
    await resizeWidgetToContent(213.4);
    expect(api.invoke).toHaveBeenCalledWith("resize_expanded_widget", {
      contentHeight: 213.4,
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    });
  });

  it("discards a queued content resize after a newer collapse intent", async () => {
    let finishExpansion!: () => void;
    api.invoke.mockImplementationOnce(async () => new Promise<void>((resolve) => { finishExpansion = resolve; }));
    const expansion = setWidgetExpanded(true);
    await vi.waitFor(() => expect(finishExpansion).toBeTypeOf("function"));
    const staleResize = resizeWidgetToContent(620);
    const collapse = setWidgetExpanded(false);
    finishExpansion();
    await Promise.all([expansion, staleResize, collapse]);
    expect(api.invoke.mock.calls.some(([command]) => command === "resize_expanded_widget")).toBe(false);
  });

  it("does not cancel an entering expansion when the same press starts a drag", async () => {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {},
      setInterval: vi.fn(() => 7),
      clearInterval: vi.fn(),
    });
    await Promise.all([setWidgetExpanded(true), startDragging()]);
    expect(api.invoke.mock.calls.some(([command]) => command === "expand_widget")).toBe(true);
    await setWidgetExpanded(false);
  });

  it("keeps resize and control-center positioning on the capsule's original display", async () => {
    const anchorArea = { position: { x: -1280, y: 0 }, size: { width: 1280, height: 984 } };
    api.currentMonitor.mockResolvedValueOnce({ workArea: anchorArea });

    await setWidgetExpanded(true, "capsule");
    await resizeWidgetToContent(620);
    await openControlCenterWindow();

    expect(api.currentMonitor).toHaveBeenCalledTimes(1);
    expect(api.invoke).toHaveBeenCalledWith("resize_expanded_widget", { contentHeight: 620, workArea: anchorArea });
    expect(api.invoke).toHaveBeenCalledWith("open_control_center", { workArea: anchorArea });
    await closeControlCenterWindow();
    await setWidgetExpanded(false, "capsule");
  });

  it("opens the control center against the active work area", async () => {
    await openControlCenterWindow();
    expect(api.invoke).toHaveBeenCalledWith("open_control_center", {
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    });
  });

  it("widens and restores the owned control center for the calendar", async () => {
    await openControlCenterWindow();
    await setControlCenterCalendarOpen(true);
    await setControlCenterCalendarOpen(false);
    expect(api.invoke.mock.calls.map(([name]) => name)).toEqual([
      "open_control_center", "set_control_center_calendar_open", "set_control_center_calendar_open",
    ]);
    expect(api.invoke).toHaveBeenCalledWith("set_control_center_calendar_open", {
      open: true,
      workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1040 } },
    });
    await closeControlCenterWindow();
  });

  it("rejects hover and observer geometry while a dialog is opening and open", async () => {
    const opening = openControlCenterWindow();
    await Promise.all([setWidgetExpanded(false), setWidgetExpanded(true), resizeWidgetToContent(80)]);
    await opening;
    await Promise.all([setWidgetExpanded(false), resizeWidgetToContent(80)]);
    expect(api.invoke.mock.calls.map(([name]) => name)).toEqual(["open_control_center"]);
    await closeControlCenterWindow();
    await setWidgetExpanded(false);
    expect(api.invoke).toHaveBeenLastCalledWith("collapse_widget", { compactLayout: "float" });
  });

  it("does not let a late collapse cancel a dialog queued behind an in-flight resize", async () => {
    let finishResize!: () => void;
    api.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finishResize = resolve; }));
    const resize = resizeWidgetToContent(600);
    await vi.waitFor(() => expect(finishResize).toBeTypeOf("function"));
    const opening = openControlCenterWindow();
    await setWidgetExpanded(false, "capsule", undefined, 100);
    finishResize();
    await Promise.all([resize, opening]);
    expect(api.invoke.mock.calls.map(([name]) => name)).toEqual(["resize_expanded_widget", "open_control_center"]);
  });

  it("releases native ownership after a failed open so the capsule can recover", async () => {
    api.invoke.mockRejectedValueOnce(new Error("open failed"));
    await expect(openControlCenterWindow()).rejects.toThrow("open failed");
    expect(api.invoke).toHaveBeenLastCalledWith("close_control_center");
    await setWidgetExpanded(false);
    expect(api.invoke).toHaveBeenLastCalledWith("collapse_widget", { compactLayout: "float" });
  });

  it("keeps dialog ownership if native close fails", async () => {
    await openControlCenterWindow();
    api.invoke.mockRejectedValueOnce(new Error("close failed"));
    await expect(closeControlCenterWindow()).rejects.toThrow("close failed");
    const calls = api.invoke.mock.calls.length;
    await setWidgetExpanded(false);
    expect(api.invoke).toHaveBeenCalledTimes(calls);
    await closeControlCenterWindow();
  });

  it("reads daily usage from the dedicated official-session command", async () => {
    api.invoke.mockResolvedValueOnce({
      localDate: "2026-08-12",
      observedUsedPercent: 41,
      sampleCount: 924,
      firstObservedAt: "2026-08-12T14:24:00+08:00",
      lastObservedAt: "2026-08-12T18:00:00+08:00",
      coverage: "partial",
      source: "codex-session-rate-limits",
    } as never);
    await expect(fetchCodexDailyUsage()).resolves.toMatchObject({ observedUsedPercent: 41, coverage: "partial" });
    expect(api.invoke).toHaveBeenCalledWith("get_codex_daily_usage");
  });

  it("reads historical daily usage from the dedicated official-session command", async () => {
    api.invoke.mockResolvedValueOnce([
      {
        localDate: "2026-08-12",
        observedUsedPercent: 5,
        sampleCount: 12,
        firstObservedAt: "2026-08-12T04:05:00+08:00",
        lastObservedAt: "2026-08-12T18:00:00+08:00",
        coverage: "complete",
        source: "codex-session-rate-limits",
      },
    ] as never);
    await expect(fetchCodexDailyUsageHistory()).resolves.toMatchObject([{ localDate: "2026-08-12", observedUsedPercent: 5 }]);
    expect(api.invoke).toHaveBeenCalledWith("get_codex_daily_usage_history");
  });

  it("ignores invalid content heights", async () => {
    await resizeWidgetToContent(Number.NaN);
    await resizeWidgetToContent(0);
    expect(api.invoke).not.toHaveBeenCalled();
  });

  it("uses dedicated redacted diagnostics and reconnect commands", async () => {
    await getVolcengineDiagnostics();
    await reconnectVolcengine();
    expect(api.invoke).toHaveBeenCalledWith("get_volcengine_diagnostics");
    expect(api.invoke).toHaveBeenCalledWith("reconnect_volcengine");
  });

  it("serializes rapid preference writes so the newest state cannot be overwritten", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    api.invoke.mockImplementationOnce(async (command: string) => {
      api.calls.push(`start:${command}`);
      await firstWrite;
      api.calls.push(`end:${command}`);
    });
    const first = updatePreferences({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 20 });
    const second = updatePreferences({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 10 });
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalled());
    expect(api.invoke).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(api.calls).toEqual([
      "start:set_preferences",
      "end:set_preferences",
      "start:set_preferences",
      "end:set_preferences",
    ]);
  });

  it("coalesces pending preference writes to the latest slider value", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    api.invoke.mockImplementationOnce(async (command: string) => {
      api.calls.push(`start:${command}`);
      await firstWrite;
      api.calls.push(`end:${command}`);
    });
    const first = updatePreferences({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 20 });
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
    const second = updatePreferences({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 15 });
    const third = updatePreferences({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 10 });

    releaseFirst();
    await Promise.all([first, second, third]);

    expect(api.invoke).toHaveBeenCalledTimes(2);
    expect(api.invoke).toHaveBeenLastCalledWith("set_preferences", { preferences: expect.objectContaining({ alertThreshold: 10 }) });
  });

  it("serializes runtime writes so older state cannot overwrite newer state", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    api.invoke.mockImplementationOnce(async (command: string) => {
      api.calls.push(`start:${command}`);
      await firstWrite;
      api.calls.push(`end:${command}`);
    });
    const first = updateRuntimeState({ ...EMPTY_RUNTIME_STATE, lastNotifications: { first: "2026-07-22T00:00:00Z" } });
    const second = updateRuntimeState({ ...EMPTY_RUNTIME_STATE, lastNotifications: { second: "2026-07-22T00:00:01Z" } });
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second]);
    expect(api.calls).toEqual([
      "start:set_runtime_state",
      "end:set_runtime_state",
      "start:set_runtime_state",
      "end:set_runtime_state",
    ]);
  });

  it("removes listeners registered before a later registration fails", async () => {
    const unlistenPreferences = vi.fn();
    events.listen
      .mockResolvedValueOnce(unlistenPreferences)
      .mockRejectedValueOnce(new Error("listener unavailable"));
    await expect(listenDesktopEvents({ onPreferences: vi.fn(), onRefresh: vi.fn(), onBackgroundSnapshots: vi.fn(), onUpdate: vi.fn() })).rejects.toThrow("listener unavailable");
    expect(unlistenPreferences).toHaveBeenCalledOnce();
  });
});
