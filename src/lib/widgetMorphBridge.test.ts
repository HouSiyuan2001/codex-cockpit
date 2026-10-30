// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn(), animate: vi.fn(), clear: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ currentMonitor: async () => null }));
vi.mock("./widgetMorph", () => ({ usesWidgetMorph: () => true, animateWidgetMorph: native.animate, clearWidgetMorph: native.clear }));
import { closeControlCenterWindow, setWidgetExpanded } from "./bridge";

beforeEach(async () => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  native.invoke.mockResolvedValue({ from: {}, to: {}, scaleFactor: 1 });
  native.animate.mockResolvedValue(undefined);
  await closeControlCenterWindow();
  vi.clearAllMocks();
});
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("reveals the native frame only after the compositor prepares its first frame", async () => {
  native.invoke.mockResolvedValueOnce({ from: {}, to: {}, scaleFactor: 1, frameTicket: 42 });
  native.animate.mockImplementationOnce(async (_geometry, _expanding, reveal) => {
    expect(native.invoke.mock.calls.some(([command]) => command === "reveal_widget_frame")).toBe(false);
    await reveal();
  });
  await setWidgetExpanded(true, "capsule", 560);
  expect(native.invoke.mock.calls.filter(([command]) => command === "reveal_widget_frame")).toEqual([
    ["reveal_widget_frame", { frameTicket: 42 }],
  ]);
});

it("releases a native frame mask even when the renderer fails", async () => {
  native.invoke.mockResolvedValueOnce({ from: {}, to: {}, scaleFactor: 1, frameTicket: 43 });
  native.animate.mockRejectedValueOnce(new Error("renderer stopped"));
  await expect(setWidgetExpanded(true, "capsule", 560)).rejects.toThrow("renderer stopped");
  expect(native.invoke).toHaveBeenLastCalledWith("reveal_widget_frame", { frameTicket: 43 });
  expect(native.clear).toHaveBeenCalledOnce();
});

it("restores the outgoing surface if the native expansion fails before a reveal ticket exists", async () => {
  native.invoke.mockRejectedValueOnce(new Error("native window stopped"));
  await expect(setWidgetExpanded(true, "capsule", 560)).rejects.toThrow("native window stopped");
  expect(native.clear).toHaveBeenCalledOnce();
});

it("does not clear a newer surface when an obsolete expansion fails", async () => {
  let rejectOld!: (error: Error) => void;
  native.animate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  const old = setWidgetExpanded(true, "capsule", 560);
  const oldResult = expect(old).rejects.toThrow("obsolete renderer stopped");
  await vi.waitFor(() => expect(rejectOld).toBeTypeOf("function"));
  await setWidgetExpanded(true, "capsule", 560);
  rejectOld(new Error("obsolete renderer stopped"));
  await oldResult;
  expect(native.clear).not.toHaveBeenCalled();
});

it("finishes the visual collapse before changing the native window bounds", async () => {
  let finish!: () => void;
  native.animate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const closing = setWidgetExpanded(false, "capsule", undefined, 104);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(native.invoke).toHaveBeenCalledExactlyOnceWith("collapse_widget", { compactLayout: "capsule", preview: true, compactWidth: 104 });
  finish();
  await closing;
  expect(native.invoke).toHaveBeenLastCalledWith("collapse_widget", { compactLayout: "capsule", compositorMotion: true, compactWidth: 104 });
});

it("never applies an old collapse after the user requests expansion", async () => {
  let finish!: () => void;
  native.animate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const closing = setWidgetExpanded(false, "capsule");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await setWidgetExpanded(true, "capsule", 560);
  finish();
  await closing;
  expect(native.invoke.mock.calls.filter(([command, args]) => command === "collapse_widget" && !args.preview)).toHaveLength(0);
  expect(native.invoke).toHaveBeenLastCalledWith("expand_widget", { compactLayout: "capsule", contentHeight: 560, workArea: null, compositorMotion: true });
});
