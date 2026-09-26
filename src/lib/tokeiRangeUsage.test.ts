import { describe, expect, it } from "vitest";
import { aggregateGlobalUsage, aggregateGroupUsage, createUsagePreview, selectDeviceUsage } from "./tokeiUsage";

const now = new Date(2026, 8, 10, 14);
function fixture() {
  const data = createUsagePreview(now);
  const day = data.devices[0].daily["2026-09-10"];
  data.devices[0].ranges = {
    today: { ...day, start: "2026-09-10", end: "2026-09-11" },
    week: { ...day, start: "2026-09-07", end: "2026-09-14" },
    month: { ...day, start: "2026-09-01", end: "2026-10-01" },
    all: { ...day, start: null, end: null },
  };
  data.devices[0].daily = {};
  return data;
}

describe("range-only peer compatibility", () => {
  it("reads today, calendar week, month and all without inventing daily bins", () => {
    const data = fixture();
    for (const period of ["today", "week", "month", "all"] as const) {
      const result = aggregateGroupUsage(data, "demo", period, now);
      expect(result.estimatedCostUsd).toBeCloseTo(2.7);
      expect(result.totalTokens).toBe(2000000);
      expect(result.models).toHaveLength(2);
      expect(result.rangeDeviceIds).toEqual(["Demo Mac"]);
      expect(Object.keys(result.devices[0].daily)).toHaveLength(0);
    }
    expect(aggregateGroupUsage(data, "demo", "7d", now).estimatedCostUsd).toBeNull();
    expect(aggregateGroupUsage(data, "demo", "7d", now).unavailablePeriodDeviceIds).toEqual(["Demo Mac"]);
  });
  it("does not double count a device with both ledgers and ranges", () => {
    const data = fixture();
    data.devices[0].daily["2026-09-10"] = data.devices[0].ranges.today;
    const result = aggregateGroupUsage(data, "demo", "month", now);
    expect(result.totalTokens).toBe(2000000);
    expect(result.rangeDeviceIds).toHaveLength(0);
  });
  it("preserves a larger historical range while a new ledger is still partial", () => {
    const data = fixture();
    data.devices[0].daily["2026-09-10"] = { ...data.devices[0].ranges.today, totalTokens: 100 };
    const result = aggregateGroupUsage(data, "demo", "all", now);
    expect(result.totalTokens).toBe(2000000);
    expect(result.rangeDeviceIds).toEqual(["Demo Mac"]);
  });
  it("keeps a verified zero distinct from no data and propagates unknown cost", () => {
    const data = fixture();
    Object.assign(data.devices[0].ranges.today, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0, models: [] });
    expect(aggregateGroupUsage(data, "demo", "today", now).estimatedCostUsd).toBe(0);
    expect(aggregateGroupUsage(data, "demo", "today", now).hasData).toBe(true);
    data.devices[0].ranges.today.estimatedCostUsd = null;
    expect(aggregateGroupUsage(data, "demo", "today", now).estimatedCostUsd).toBeNull();
  });
  it("rejects stale date labels, missing time, future snapshots and mismatched month bounds", () => {
    const data = fixture(); const device = data.devices[0];
    device.ranges.today.start = "2026-09-09";
    expect(selectDeviceUsage(device, "today", now).source).toBe("none");
    device.ranges.month.end = "2026-09-30";
    expect(selectDeviceUsage(device, "month", now).source).toBe("none");
    device.updatedAt = null;
    expect(selectDeviceUsage(device, "all", now).source).toBe("none");
    device.updatedAt = new Date(now.getTime() + 600000).toISOString();
    expect(selectDeviceUsage(device, "all", now).source).toBe("none");
  });
  it("combines users from different source formats with matching periods", () => {
    const data = fixture();
    const local = createUsagePreview(now).devices[0];
    data.devices.push({ ...local, id: "Local" });
    data.groups.push({ id: "local", name: "Local user", deviceIds: ["Local"] });
    const summary = aggregateGlobalUsage(data, "month", now);
    expect(summary.estimatedCostUsd).toBeCloseTo(5.4);
    expect(summary.users.map(user => user.estimatedCostUsd)).toEqual([2.6999999999999997, 2.6999999999999997]);
  });
  it("allows calendar week for rolling seven days only when both bounds exactly match", () => {
    const data = fixture();
    const sunday = new Date(2026, 8, 13, 14);
    expect(selectDeviceUsage(data.devices[0], "7d", sunday).source).toBe("range");
  });
});
