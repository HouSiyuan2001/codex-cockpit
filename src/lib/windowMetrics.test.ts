import { describe, expect, it } from "vitest";
import { measureSurfaceHeight } from "./windowMetrics";

describe("window surface measurement", () => {
  it("ignores decorative overflow outside the visible card", () => {
    const surface = {
      clientHeight: 620,
      scrollHeight: 836,
      getBoundingClientRect: () => ({ height: 620 }),
    } as unknown as HTMLElement;

    expect(measureSurfaceHeight(surface)).toBe(620);
  });

  it("keeps the larger rendered height when content grows", () => {
    const surface = {
      clientHeight: 620,
      getBoundingClientRect: () => ({ height: 684.4 }),
    } as unknown as HTMLElement;

    expect(measureSurfaceHeight(surface)).toBe(685);
  });
});
