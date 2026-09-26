type FrameScheduler = (callback: FrameRequestCallback) => number;

let removePreviousSurface = () => {};

/** Retain only an inert visual copy while React switches the live surface.
 * Neither copy is scaled: the native window provides the clipping container. */
export function prepareSurfaceCrossfade(): { start: () => void; cancel: () => void } {
  removePreviousSurface();
  const noop = { start: () => {}, cancel: () => {} };
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return noop;
  const source = document.querySelector<HTMLElement>("#root > .quota-card, #root > .quota-island");
  if (!source || typeof source.animate !== "function") return noop;
  const bounds = source.getBoundingClientRect();
  const outgoing = source.cloneNode(true) as HTMLElement;
  outgoing.removeAttribute("id");
  outgoing.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  outgoing.setAttribute("aria-hidden", "true");
  outgoing.inert = true;
  Object.assign(outgoing.style, {
    position: "fixed", left: `${bounds.left}px`, top: `${bounds.top}px`,
    width: `${bounds.width}px`, height: `${bounds.height}px`, maxWidth: "none",
    margin: "0", pointerEvents: "none", zIndex: "9999",
  });
  document.body.append(outgoing);
  let dispose = () => outgoing.remove();
  let cancelled = false;
  const cancel = () => { cancelled = true; dispose(); };
  removePreviousSurface = cancel;
  const start = () => {
    if (cancelled) return;
    const live = document.querySelector<HTMLElement>("#root > .quota-card, #root > .quota-island");
    const options = { duration: 140, easing: "ease-out", fill: "both" as const };
    const exit = outgoing.animate([{ opacity: 1 }, { opacity: 0 }], options);
    exit.onfinish = () => outgoing.remove();
    const enter = live?.animate([{ opacity: 0 }, { opacity: 1 }], options);
    if (enter) enter.onfinish = () => enter.cancel();
    dispose = () => { exit.cancel(); enter?.cancel(); outgoing.remove(); };
  };
  return { start, cancel };
}

export function waitForSurfacePaint(scheduleFrame: FrameScheduler = window.requestAnimationFrame.bind(window)): Promise<void> {
  return new Promise((resolve) => {
    // The first frame commits the React surface; the second guarantees WebKit
    // has painted it before the native Tauri frame starts growing.
    scheduleFrame(() => scheduleFrame(() => resolve()));
  });
}
