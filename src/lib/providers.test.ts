import { describe, expect, it } from "vitest";
import { normalizeProviderOrder } from "./providers";

describe("provider ordering", () => {
  it("preserves a custom order and appends missing providers", () => {
    expect(normalizeProviderOrder(["volcengine", "codex"])).toEqual([
      "volcengine",
      "codex",
      "qoder",
      "trae",
      "workbuddy",
      "antigravity",
    ]);
  });

  it("deduplicates provider ids", () => {
    expect(normalizeProviderOrder(["qoder", "qoder", "codex"])).toEqual([
      "qoder",
      "codex",
      "trae",
      "workbuddy",
      "volcengine",
      "antigravity",
    ]);
  });
});
