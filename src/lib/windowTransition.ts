import { prepareWidgetMorph } from "./widgetMorph";

type FrameScheduler = (callback: FrameRequestCallback) => number;

/** Keep App's transition hook stable. Windows retains a small outgoing capsule
 * while preparing the new frame; other platforms keep the existing no-op hook.
 * The expanded dashboard and its live controls are never cloned. */
export function prepareSurfaceCrossfade(): { start: () => void; cancel: () => void } {
  return prepareWidgetMorph();
}

export function waitForSurfacePaint(scheduleFrame: FrameScheduler = window.requestAnimationFrame.bind(window)): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    // A small/occluded GTK WebView may stop producing frames. The native
    // resize is needed to make it paint again, so never wait indefinitely.
    const timeout = window.setTimeout(finish, 120);
    // The first frame commits the React surface; the second guarantees WebKit
    // has had a paint opportunity before the native Tauri frame starts growing.
    scheduleFrame(() => { if (!settled) scheduleFrame(finish); });
  });
}
