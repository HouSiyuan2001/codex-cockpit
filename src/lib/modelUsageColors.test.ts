import { describe, expect, it } from "vitest";
import { colorbarSample, modelUsageColors } from "./modelUsageColors";

describe("generation colorbar", () => {
  it("spans five evenly spaced colors independent of usage order", () => {
    const ids = ["openai/gpt-5.5", "openai/gpt-5.6-luna", "openai/gpt-5.6-sol", "openai/gpt-5.4-mini", "openai/gpt-6-astra"];
    const colors = modelUsageColors(ids.map(id => ({ id, name: id })));
    expect(colors[ids[4]]).toBe("#e76254");
    expect(colors[ids[1]]).toBe(colorbarSample(.25));
    expect(colors[ids[2]]).toBe(colorbarSample(.5));
    expect(colors[ids[0]]).toBe(colorbarSample(.75));
    expect(colors[ids[3]]).toBe("#1e466e");
    expect(new Set(Object.values(colors)).size).toBe(5);
    expect(modelUsageColors([...ids].reverse().map(id => ({ id, name: id })))).toEqual(colors);
  });
  it("sorts version numbers numerically and does not invent a generation for review labels", () => {
    const colors = modelUsageColors(["GPT-5.9", "GPT-5.10", "GPT-6", "Codex Auto Review"].map(name => ({ id: `tokei-name:${name}`, name })));
    expect(colors["tokei-name:GPT-6"]).toBe("#e76254");
    expect(colors["tokei-name:GPT-5.9"]).toBe("#1e466e");
    expect(colors["tokei-name:Codex Auto Review"]).toBeUndefined();
  });
  it("never wraps colors when more than ten generations are visible", () => {
    const colors = modelUsageColors(Array.from({ length: 12 }, (_, i) => ({ id: `gpt-${i + 1}`, name: `gpt-${i + 1}` })));
    expect(new Set(Object.values(colors)).size).toBe(12);
  });
});
