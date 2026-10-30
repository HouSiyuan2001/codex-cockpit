export interface WidgetFrame {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

export interface WidgetMorphGeometry {
  from: WidgetFrame;
  to: WidgetFrame;
  scaleFactor: number;
  frameTicket?: number | null;
}

export interface SurfaceBox { left: number; top: number; width: number; height: number }

const EXPAND_MS = 250;
const COLLAPSE_MS = 190;
const EASING = "cubic-bezier(.22, 1, .36, 1)";
let compactBox: SurfaceBox | null = null;
let ghost: HTMLElement | null = null;
let activeAnimations: Animation[] = [];
let activeRun = 0;
let ghostAnchor: { x: number; y: number } | null = null;
let ghostFrame: number | null = null;

function syncGhostToScreen(): void {
  if (!ghost || !ghostAnchor) return;
  // Windows moves the HWND before WebView2 delivers its new viewport or the
  // invoke response. Keep the outgoing capsule in SCREEN coordinates during
  // that gap, including render ticks that still report the compact viewport.
  ghost.style.left = `${ghostAnchor.x - window.screenX}px`;
  ghost.style.top = `${ghostAnchor.y - window.screenY}px`;
}

function trackGhostAnchor(): void {
  syncGhostToScreen();
  if (ghost && typeof window.requestAnimationFrame === "function") {
    ghostFrame = window.requestAnimationFrame(trackGhostAnchor);
  }
}

export function usesWidgetMorph(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
    && typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
}

function surface(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#root > .quota-card, #root > .quota-orb, #root > .quota-island");
}

/** The small frame in the expanded surface's coordinates, including DPI and
 * right/bottom docking. A single round inset clips ALL four corners equally. */
export function capsuleClip(geometry: WidgetMorphGeometry, box: SurfaceBox, expanding: boolean, source?: SurfaceBox | null): string {
  const scale = Number.isFinite(geometry.scaleFactor) && geometry.scaleFactor > 0 ? geometry.scaleFactor : 1;
  const small = expanding ? geometry.from : geometry.to;
  const large = expanding ? geometry.to : geometry.from;
  const inset = 4;
  const width = source?.width ?? Math.max(1, small.size.width / scale - inset * 2);
  const height = source?.height ?? Math.max(1, small.size.height / scale - inset * 2);
  const left = (small.position.x - large.position.x) / scale + (source?.left ?? inset) - box.left;
  const top = (small.position.y - large.position.y) / scale + (source?.top ?? inset) - box.top;
  const right = box.width - left - width;
  const bottom = box.height - top - height;
  const round = Math.min(width, height) / 2;
  const px = (value: number) => `${Math.round(value * 100) / 100}px`;
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${px(round)})`;
}

export function clearWidgetMorph(): void {
  ++activeRun;
  if (ghostFrame !== null) window.cancelAnimationFrame(ghostFrame);
  ghostFrame = null;
  ghostAnchor = null;
  window.removeEventListener("resize", syncGhostToScreen);
  for (const animation of activeAnimations) animation.cancel();
  activeAnimations = [];
  ghost?.remove();
  ghost = null;
  delete document.documentElement.dataset.widgetMorphPreparing;
  delete document.documentElement.dataset.widgetMorphActive;
  delete document.documentElement.dataset.widgetMorphSettling;
}

/** Keep only the tiny outgoing capsule visible while React lays out the
 * expanded panel offscreen. Never clone the dashboard or its live controls. */
export function prepareWidgetMorph(): { start: () => void; cancel: () => void } {
  if (!usesWidgetMorph()) return { start() {}, cancel() {} };
  const element = surface();
  if (!element || (!element.classList.contains("quota-orb") && !element.classList.contains("quota-island"))) {
    return { start: clearWidgetMorph, cancel: clearWidgetMorph };
  }
  clearWidgetMorph();
  const bounds = element.getBoundingClientRect();
  compactBox = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  ghost = element.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach(item => item.removeAttribute("id"));
  ghost.classList.add("widget-morph-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed", left: `${bounds.left}px`, top: `${bounds.top}px`,
    width: `${bounds.width}px`, height: `${bounds.height}px`, maxWidth: "none",
    margin: "0", pointerEvents: "none", zIndex: "9999",
  });
  document.body.append(ghost);
  ghostAnchor = { x: window.screenX + bounds.left, y: window.screenY + bounds.top };
  window.addEventListener("resize", syncGhostToScreen);
  trackGhostAnchor();
  document.documentElement.dataset.widgetMorphPreparing = "true";
  // App starts this hook before the native frame changes. The bridge reveals
  // the new surface only AFTER that single native change has completed.
  return { start() {}, cancel: clearWidgetMorph };
}

async function waitForMorphViewport(geometry: WidgetMorphGeometry): Promise<void> {
  const ready = () => Math.abs(window.innerWidth - geometry.to.size.width / geometry.scaleFactor) <= 1
    && Math.abs(window.innerHeight - geometry.to.size.height / geometry.scaleFactor) <= 1;
  if (ready()) return;
  await new Promise<void>(resolve => {
    const finish = () => { window.clearTimeout(timeout); window.removeEventListener("resize", check); resolve(); };
    const check = () => { if (ready()) finish(); };
    const timeout = window.setTimeout(finish, 120);
    window.addEventListener("resize", check);
    check();
  });
}

async function waitForMorphPaint(maximumWait = 80): Promise<void> {
  await new Promise<void>(resolve => {
    const timeout = window.setTimeout(resolve, maximumWait);
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      window.clearTimeout(timeout);
      resolve();
    }));
  });
}

export async function animateWidgetMorph(geometry: WidgetMorphGeometry | null | undefined, expanding: boolean, revealFrame?: () => Promise<void>): Promise<void> {
  const element = surface();
  if (!geometry || !element || element.classList.contains("quota-orb") || element.classList.contains("quota-island")) {
    clearWidgetMorph();
    return;
  }
  const run = ++activeRun;
  for (const animation of activeAnimations) animation.cancel();
  activeAnimations = [];
  const root = document.documentElement;
  if (expanding) syncGhostToScreen();
  if (expanding && usesWidgetMorph()) {
    // SetWindowPos has completed, but WebView2 can deliver the new viewport on
    // its next render tick. Do not reveal into the old square backing surface.
    // Cloaked WebView2 can stop rAF even with background throttling disabled.
    // Viewport readiness is observable without waiting out two paint timeouts.
    if (revealFrame) await waitForMorphViewport(geometry);
    else await waitForMorphPaint();
    if (run !== activeRun) return;
    syncGhostToScreen();
  }
  const bounds = element.getBoundingClientRect();
  const box = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  const smallClip = capsuleClip(geometry, box, expanding, expanding ? compactBox : null);
  const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 28;
  const fullClip = `inset(0px 0px 0px 0px round ${radius}px)`;
  const duration = expanding ? EXPAND_MS : COLLAPSE_MS;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  root.dataset.widgetMorphActive = "true";
  delete root.dataset.widgetMorphPreparing;
  delete root.dataset.widgetMorphSettling;
  if (!reduced && typeof element.animate === "function") {
    const shape = element.animate([
      { clipPath: expanding ? smallClip : fullClip },
      { clipPath: expanding ? fullClip : smallClip },
    ], { duration, easing: EASING, fill: "both" });
    activeAnimations.push(shape);
    for (const child of Array.from(element.children)) {
      if (!(child instanceof HTMLElement) || child.classList.contains("aurora")) continue;
      activeAnimations.push(child.animate(expanding ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
        duration: expanding ? 150 : 90, delay: expanding ? 70 : 0, easing: "ease-out", fill: "both",
      }));
    }
    if (ghost && expanding) activeAnimations.push(ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, fill: "both" }));
    if (revealFrame) {
      // Commit the correctly positioned, fully rounded FIRST frame while DWM
      // still masks the HWND. Starting the tween before the native reveal can
      // expose an old backing bitmap or skip the beginning of the animation.
      for (const animation of activeAnimations) { animation.pause(); animation.currentTime = 0; }
      await waitForMorphPaint(34);
      if (run !== activeRun) return;
      await revealFrame();
      if (run !== activeRun) return;
      for (const animation of activeAnimations) animation.play();
    }
    // A stopped/minimized WebView must never leave an invisible or unclickable
    // widget. Native collapse is applied only after this bounded visual phase.
    await new Promise<void>(resolve => {
      const timeout = window.setTimeout(resolve, duration + 100);
      void shape.finished.catch(() => undefined).then(() => { window.clearTimeout(timeout); resolve(); });
    });
  } else if (revealFrame) {
    clearWidgetMorph();
    await waitForMorphPaint(34);
    await revealFrame();
    return;
  }
  if (run !== activeRun) return;
  if (expanding) clearWidgetMorph();
  else {
    root.dataset.widgetMorphSettling = "true";
    // Keep the small shape hidden only until React commits the live capsule.
    // App's paint/cleanup path clears this even when a native operation fails.
    for (const animation of activeAnimations) animation.cancel();
    activeAnimations = [];
    delete root.dataset.widgetMorphActive;
  }
}
