// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { animateWidgetMorph, capsuleClip, clearWidgetMorph, prepareWidgetMorph, usesWidgetMorph, type WidgetMorphGeometry } from "./widgetMorph";

const geometry: WidgetMorphGeometry = {
  from: { position: { x: 900, y: 800 }, size: { width: 104, height: 48 } },
  to: { position: { x: 476, y: 280 }, size: { width: 528, height: 568 } }, scaleFactor: 1,
};
afterEach(() => { clearWidgetMorph(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); document.body.innerHTML = ""; });

it("enables the compositor path only in a Windows native WebView", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
  expect(usesWidgetMorph()).toBe(false);
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  try {
    expect(usesWidgetMorph()).toBe(true);
    for (const userAgent of ["Macintosh; Intel Mac OS X", "X11; Linux x86_64"]) {
      vi.stubGlobal("navigator", { userAgent });
      expect(usesWidgetMorph()).toBe(false);
    }
  } finally {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
});

describe("rounded capsule geometry", () => {
  it("keeps right/bottom anchored capsules inside the same four-corner round clip", () => {
    const box = { left: 4, top: 4, width: 520, height: 560 };
    expect(capsuleClip(geometry, box, true)).toBe("inset(520px 0px 0px 424px round 20px)");
    expect(capsuleClip({ ...geometry, from: geometry.to, to: geometry.from }, box, false)).toBe(capsuleClip(geometry, box, true));
  });
  it("uses logical pixels on a high-DPI display with a negative screen origin", () => {
    const scaled = {
      from: { position: { x: -1500, y: 100 }, size: { width: 156, height: 72 } },
      to: { position: { x: -1500, y: 100 }, size: { width: 792, height: 852 } }, scaleFactor: 1.5,
    };
    expect(capsuleClip(scaled, { left: 4, top: 4, width: 520, height: 560 }, true)).toBe("inset(0px 424px 520px 0px round 20px)");
  });
});

describe("visual lifetime", () => {
  it("releases a ready native viewport promptly when cloaking pauses animation frames", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(528);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(568);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    document.body.innerHTML = '<div id="root"><main class="quota-card"></main></div>';
    const effect = { finished: new Promise(() => {}), cancel: vi.fn(), pause: vi.fn(), play: vi.fn(), currentTime: null as number | null };
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => effect });
    const reveal = vi.fn(async () => {});
    const motion = animateWidgetMorph(geometry, true, reveal);
    await vi.advanceTimersByTimeAsync(40);
    expect(reveal).toHaveBeenCalledOnce();
    expect(effect.play).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(400);
    await motion;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  it("paints a paused first frame and reveals it before playing the tween", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><main class="quota-card" style="border-radius:28px"></main></div>';
    const events: string[] = [];
    const effect = { finished: new Promise(() => {}), cancel: vi.fn(), pause: () => events.push("pause"), play: () => events.push("play"), currentTime: null as number | null };
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => effect });
    let release!: () => void;
    const motion = animateWidgetMorph(geometry, true, () => {
      events.push("reveal");
      expect(effect.currentTime).toBe(0);
      return new Promise<void>(resolve => { release = resolve; });
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual(["pause", "reveal"]);
    release();
    await vi.advanceTimersByTimeAsync(400);
    await motion;
    expect(events).toEqual(["pause", "reveal", "play"]);
    expect(effect.cancel).toHaveBeenCalled();
  });

  it("also reveals an unclipped settled surface when reduced motion skips the tween", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.body.innerHTML = '<div id="root"><main class="quota-card"></main></div>';
    const reveal = vi.fn(async () => { expect(document.documentElement.dataset.widgetMorphActive).toBeUndefined(); });
    const motion = animateWidgetMorph(geometry, true, reveal);
    await vi.advanceTimersByTimeAsync(150);
    await motion;
    expect(reveal).toHaveBeenCalledOnce();
  });
  it("keeps the ghost at its screen anchor before native resize/invoke finishes", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    vi.spyOn(window, "screenX", "get").mockReturnValue(573);
    vi.spyOn(window, "screenY", "get").mockReturnValue(600);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    document.body.innerHTML = '<div id="root"><main class="quota-orb">Quota</main></div>';
    vi.spyOn(document.querySelector(".quota-orb")!, "getBoundingClientRect").mockReturnValue({ left: 4, top: 4, width: 88, height: 40 } as DOMRect);
    const transition = prepareWidgetMorph();
    const ghost = document.querySelector<HTMLElement>(".widget-morph-ghost")!;
    vi.spyOn(window, "screenX", "get").mockReturnValue(357);
    vi.spyOn(window, "screenY", "get").mockReturnValue(80);
    // The first frame after HWND movement still has the OLD viewport and no
    // native response. Waiting for either used to paint the ghost 216px left.
    frames.shift()!(0);
    expect(ghost.style.left).toBe("220px");
    expect(ghost.style.top).toBe("524px");
    expect(window.screenX + parseFloat(ghost.style.left)).toBe(577);
    expect(window.screenY + parseFloat(ghost.style.top)).toBe(604);
    vi.spyOn(window, "screenX", "get").mockReturnValue(300);
    window.dispatchEvent(new Event("resize"));
    expect(ghost.style.left).toBe("277px");
    transition.cancel();
    expect(cancel).toHaveBeenCalled();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  it("captures the real capsule class and hides the newly mounted panel before the native jump", () => {
    vi.stubGlobal("navigator", { userAgent: "Windows NT 10.0" });
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    document.body.innerHTML = '<div id="root"><main class="quota-orb"><button id="source-action">Quota</button></main></div>';
    const transition = prepareWidgetMorph();
    expect(document.querySelectorAll(".widget-morph-ghost")).toHaveLength(1);
    expect(document.querySelector(".widget-morph-ghost")?.querySelector("[id]")).toBeNull();
    expect(document.documentElement.dataset.widgetMorphPreparing).toBe("true");
    transition.cancel();
    expect(document.querySelector(".widget-morph-ghost")).toBeNull();
    expect(document.documentElement.dataset.widgetMorphPreparing).toBeUndefined();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  it("settles a stopped animation and restores the surface when frames never finish", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><main class="quota-card" style="border-radius:28px"><header>Quota</header></main></div>';
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ finished: new Promise(() => {}), cancel }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    const motion = animateWidgetMorph(geometry, true);
    await vi.advanceTimersByTimeAsync(400);
    await motion;
    expect(document.documentElement.dataset.widgetMorphActive).toBeUndefined();
    expect(cancel).toHaveBeenCalled();
  });
  it("skips tweens for reduced motion and keeps collapse masked until the capsule is committed", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.body.innerHTML = '<div id="root"><main class="quota-card"><header>Quota</header></main></div>';
    await animateWidgetMorph({ ...geometry, from: geometry.to, to: geometry.from }, false);
    expect(document.documentElement.dataset.widgetMorphSettling).toBe("true");
    clearWidgetMorph();
    expect(document.documentElement.dataset.widgetMorphSettling).toBeUndefined();
  });
});
