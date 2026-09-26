import { describe, expect, it } from "vitest";
import { resolveAppearanceMode } from "./appearance";

describe("appearance mode", () => {
  it("resolves system appearance without changing explicit choices", () => {
    expect(resolveAppearanceMode("system", true)).toBe("dark");
    expect(resolveAppearanceMode("system", false)).toBe("light");
    expect(resolveAppearanceMode("light", true)).toBe("light");
    expect(resolveAppearanceMode("dark", false)).toBe("dark");
  });
});
