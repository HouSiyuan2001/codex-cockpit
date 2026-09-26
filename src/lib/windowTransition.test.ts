// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { prepareSurfaceCrossfade, waitForSurfacePaint } from "./windowTransition";

describe("waitForSurfacePaint", () => {
  it("waits for two animation frames before releasing the native resize", async () => {
    const frames: FrameRequestCallback[] = [];
    const schedule = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const ready = vi.fn();

    void waitForSurfacePaint(schedule).then(ready);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()?.(16);
    await Promise.resolve();
    expect(ready).toHaveBeenCalledOnce();
  });
});

describe("surface crossfade", () => {
  it("keeps an inert unscaled outgoing surface and removes it on completion", () => {
    document.body.innerHTML = '<div id="root"><main class="quota-card"><button id="action">Open</button></main></div>';
    const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }> = [];
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: vi.fn(() => {
      const animation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation;
    }) });
    const source = document.querySelector<HTMLElement>("main")!;
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue({ left: 4, top: 4, width: 520, height: 600 } as DOMRect);
    const reveal = prepareSurfaceCrossfade();
    const outgoing = document.body.lastElementChild as HTMLElement;
    expect(outgoing.inert).toBe(true);
    expect(outgoing.getAttribute("aria-hidden")).toBe("true");
    expect(outgoing.querySelector("[id]")).toBeNull();
    expect(outgoing.style.width).toBe("520px");
    expect(outgoing.style.pointerEvents).toBe("none");
    reveal.start();
    expect(animations).toHaveLength(2);
    animations[0].onfinish?.();
    expect(outgoing.isConnected).toBe(false);
    animations[1].onfinish?.();
    expect(animations[1].cancel).toHaveBeenCalledOnce();
    const superseded = prepareSurfaceCrossfade();
    const cancelledCopy = document.body.lastElementChild;
    superseded.cancel();
    superseded.start();
    expect(cancelledCopy?.isConnected).toBe(false);
    expect(animations).toHaveLength(2);
  });
});
