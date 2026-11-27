import { describe, expect, it } from "vitest";
import { measureSurfaceHeight } from "./windowMetrics";

describe("window surface measurement", () => {
  it("ignores decorative overflow outside the visible card", () => {
    const surface = {
      querySelector: () => null,
      clientHeight: 620,
      scrollHeight: 836,
      getBoundingClientRect: () => ({ height: 620 }),
    } as unknown as HTMLElement;

    expect(measureSurfaceHeight(surface)).toBe(620);
  });

  it("measures the full cockpit content even when part of it must scroll", () => {
    const body = {
      getBoundingClientRect: () => ({ height: 510.5 }),
      parentElement: { getBoundingClientRect: () => ({ height: 210 }) },
    };
    const surface = {
      clientHeight: 284,
      getBoundingClientRect: () => ({ height: 286 }),
      querySelector: () => body,
    } as unknown as HTMLElement;

    expect(measureSurfaceHeight(surface)).toBe(587);
  });

  it("keeps the larger rendered height when content grows", () => {
    const surface = {
      querySelector: () => null,
      clientHeight: 620,
      getBoundingClientRect: () => ({ height: 684.4 }),
    } as unknown as HTMLElement;

    expect(measureSurfaceHeight(surface)).toBe(685);
  });
});
