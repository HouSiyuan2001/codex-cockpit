import { describe, expect, it } from "vitest";
import { aggregateGlobalUsage, createUsagePreview } from "./tokeiUsage";

describe("global user accounting", () => {
  it("retains a user's known cost when one of their devices lacks today's data", () => {
    const data = createUsagePreview();
    data.groups[0].deviceIds.push("Offline Mac");
    data.devices.push({ ...data.devices[0], id: "Offline Mac", daily: {}, ranges: {} });
    const total = aggregateGlobalUsage(data, "today");
    expect(total.estimatedCostUsd).toBeNull();
    expect(total.knownCostUsd).toBeCloseTo(2.7);
    expect(total.users[0].estimatedCostUsd).toBeCloseTo(2.7);
    expect(total.users[0].costIncomplete).toBe(true);
    expect(total.users[0].unavailablePeriodDeviceIds).toEqual(["Offline Mac"]);
  });
  it("deduplicates snapshots and overlapping assignments, retaining the newest timestamp", () => {
    const data = createUsagePreview();
    data.devices.unshift({ ...data.devices[0], updatedAt: null, daily: {} });
    data.groups.push({ id: "overlap", name: "Overlap", deviceIds: ["Demo Mac"] });
    const total = aggregateGlobalUsage(data, "today");
    expect(total.totalTokens).toBe(2000000);
    expect(total.devices).toHaveLength(1);
    expect(total.users.reduce((sum, user) => sum + user.totalTokens, 0)).toBe(total.totalTokens);
  });
  it("includes unassigned devices and marks missing users unknown, never zero cost", () => {
    const data = createUsagePreview();
    data.groups[0].deviceIds = ["Missing"];
    const total = aggregateGlobalUsage(data, "today");
    expect(total.estimatedCostUsd).toBeNull();
    expect(total.users[0].estimatedCostUsd).toBeNull();
    expect(total.users[1].name).toContain("Unassigned");
    expect(total.users[1].estimatedCostUsd).toBeCloseTo(2.7);
  });
  it("uses the selected period rather than stale range snapshots", () => {
    const now = new Date("2026-09-10T12:00:00");
    const data = createUsagePreview(new Date("2026-09-09T12:00:00"));
    expect(aggregateGlobalUsage(data, "today", now).estimatedCostUsd).toBeNull();
    expect(aggregateGlobalUsage(data, "7d", now).estimatedCostUsd).toBeCloseTo(2.7);
  });
  it("does not call an active user's amount a complete total when another user has no dated records", () => {
    const data = createUsagePreview();
    data.groups.push({ id: "empty", name: "Empty user", deviceIds: ["Empty Mac"] });
    data.devices.push({ ...data.devices[0], id: "Empty Mac", daily: {} });
    expect(aggregateGlobalUsage(data, "today").estimatedCostUsd).toBeNull();
  });
});
