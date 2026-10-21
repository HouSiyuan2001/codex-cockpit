type FrameScheduler = (callback: FrameRequestCallback) => number;

/** Keep the transition hook stable for App while leaving the painted surface
 * untouched. Cloning and opacity-fading the compact surface makes text and
 * rings look soft while Windows is already doing expensive native resizes. */
export function prepareSurfaceCrossfade(): { start: () => void; cancel: () => void } {
  return { start: () => {}, cancel: () => {} };
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
