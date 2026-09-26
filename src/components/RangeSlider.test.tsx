// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RangeSlider } from "./RangeSlider";

afterEach(cleanup);

function installPointerEvent(): void {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;

    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
}

describe("RangeSlider", () => {
  it("leaves native range dragging intact and reports the interaction lifecycle", () => {
    installPointerEvent();
    const onInteractionChange = vi.fn();
    render(<RangeSlider aria-label="Daily budget" min="1" max="100" value="20" onChange={() => undefined} onInteractionChange={onInteractionChange} />);

    const slider = screen.getByRole("slider", { name: "Daily budget" });
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.assign(slider, { setPointerCapture, releasePointerCapture, hasPointerCapture: () => true });

    fireEvent.pointerDown(slider, { button: 0, pointerId: 7 });
    // Keep the browser's native range drag path intact. Capturing the pointer
    // on the input itself breaks native dragging in the macOS WebView.
    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onInteractionChange).toHaveBeenLastCalledWith(true);

    fireEvent.pointerUp(slider, { pointerId: 7 });
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);

    // Native range inputs keep keyboard focus after a mouse click. Focus alone
    // must not strand the whole widget in its expanded state.
    fireEvent.focus(slider);
    fireEvent.pointerDown(slider, { button: 0, pointerId: 8 });
    fireEvent.pointerUp(slider, { pointerId: 8 });
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);

    fireEvent.pointerDown(slider, { button: 0, pointerId: 9 });
    fireEvent.pointerCancel(slider, { pointerId: 9 });
    expect(onInteractionChange).toHaveBeenLastCalledWith(false);
  });
});
