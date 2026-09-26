import { describe, expect, it } from "vitest";
import { buildDailyPersonCosts } from "./dailyPersonCosts";
import type { DailyModelUsage, TokeiUsage } from "./tokeiUsage";

const now = new Date(2026, 8, 14, 12);
const day = (cost: number | null, tokens = 1): DailyModelUsage => ({ estimatedCostUsd: cost, totalTokens: tokens, inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, models: [] });
function fixture(): TokeiUsage {
  return { fetchedAt: now.toISOString(), status: "ready", warnings: [], projectBreakdownAvailable: true, defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: ["a"] }, { id: "blair", name: "成员乙", deviceIds: ["b"] }], devices: [
    { id: "a", updatedAt: now.toISOString(), stale: false, daily: { "2026-09-14": day(30, 9000), "2026-09-13": day(900) }, ranges: {} },
    { id: "b", updatedAt: now.toISOString(), stale: false, daily: { "2026-09-14": day(70, 1) }, ranges: {} },
  ] };
}
describe("daily cost ring shares", () => {
  it("applies valid saved colors without changing cost shares", () => {
    const result = buildDailyPersonCosts(fixture(), now, { alex: "#123456", blair: "invalid" });
    expect(result.people.find(p => p.id === "alex")).toMatchObject({ color: "#123456", share: .3 });
    expect(result.people.find(p => p.id === "blair")?.color).not.toBe("invalid");
  });
  it("uses today's money, not token share or historical spending", () => {
    const result = buildDailyPersonCosts(fixture(), now);
    expect(result.people.find(p => p.id === "alex")?.share).toBe(.3);
    expect(result.people.find(p => p.id === "blair")?.share).toBe(.7);
    expect(result.people[0].color).not.toBe(result.people[1].color);
  });
  it("counts each device once and includes unassigned money in gray", () => {
    const data = fixture();
    data.groups[1].deviceIds.push("a");
    data.devices.push({ ...data.devices[0], id: "c", daily: { "2026-09-14": day(100) } });
    const result = buildDailyPersonCosts(data, now);
    expect(result.people.reduce((n, p) => n + p.cost, 0)).toBe(200);
    expect(result.people.find(p => p.unassigned)).toMatchObject({ share: .5, color: "#929baa" });
  });
  it("keeps known model amounts under incomplete pricing without inventing the rest", () => {
    const data = fixture();
    data.devices[0].daily["2026-09-14"] = { ...day(null), models: [{ ...day(30), id: "priced", name: "priced" }, { ...day(null), id: "unknown", name: "unknown" }] };
    const result = buildDailyPersonCosts(data, now);
    expect(result.partial).toBe(true);
    expect(result.people.find(p => p.id === "alex")).toMatchObject({ cost: 30, share: .3 });
  });
  it("does not assign unknown costs a guessed arc", () => {
    const data = fixture();
    data.devices.forEach(d => { d.daily["2026-09-14"] = day(null); });
    expect(buildDailyPersonCosts(data, now)).toEqual({ people: [], partial: true });
    expect(buildDailyPersonCosts(null, now)).toEqual({ people: [], partial: true });
  });
  it("keeps identity colors when names, order and usage rankings change", () => {
    const data = fixture();
    const before = buildDailyPersonCosts(data, now).people;
    data.groups.reverse();
    data.groups[0].name = "Renamed";
    data.devices[0].daily["2026-09-14"] = day(1000);
    const after = buildDailyPersonCosts(data, now).people;
    expect(after.map(p => [p.id, p.color])).toEqual(before.map(p => [p.id, p.color]));
  });
  it("separates colliding identity colors and keeps them when a person has zero cost", () => {
    const data = fixture();
    data.groups[0].id = "a";
    data.groups[1].id = "g";
    const both = buildDailyPersonCosts(data, now).people;
    expect(both[0].color).not.toBe(both[1].color);
    data.devices[0].daily["2026-09-14"] = day(0);
    expect(buildDailyPersonCosts(data, now).people[0].color).toBe(both[1].color);
  });
});
