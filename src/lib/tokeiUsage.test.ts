import { describe, expect, it } from "vitest";
import { aggregateGroupUsage, canonicalModelId, createUsagePreview, formatTokens, periodStart, validateGroupSettings, withLiveLocalUsage, type ProjectUsageSnapshot } from "./tokeiUsage";

const now = new Date(2026, 8, 10, 12);

describe("personal Codex usage", () => {
  it("uses a newer live local scan for both model and task-era cost, without changing peers", () => {
    const data = createUsagePreview(now);
    const local = data.devices[0];
    local.updatedAt = "2026-09-10T02:26:00Z";
    data.devices.push({ ...structuredClone(local), id: "Peer PC" });
    const oldDay = local.daily["2026-09-10"];
    const freshDay = structuredClone(oldDay);
    freshDay.estimatedCostUsd = 138.83;
    freshDay.models[0].estimatedCostUsd = 100;
    freshDay.models[1].estimatedCostUsd = 38.83;
    local.ranges.all = { ...structuredClone(oldDay), start: null, end: null };
    const projects: ProjectUsageSnapshot = {
      deviceId: local.id, updatedAt: "2026-09-10T04:53:00Z", status: "ready", coverage: "local",
      scannedFiles: 1, pricingSource: "app-catalog", pricingUpdatedAt: null, warnings: [],
      projects: [{ id: "one", name: "One", daily: { "2026-09-10": freshDay } }],
    };
    const merged = withLiveLocalUsage(data, projects);
    expect(aggregateGroupUsage(merged, "demo", "today", now).estimatedCostUsd).toBeCloseTo(138.83);
    expect(aggregateGroupUsage(merged, "demo", "all", now).estimatedCostUsd).toBeCloseTo(138.83);
    expect(merged.devices[1]).toBe(data.devices[1]);
    expect(data.devices[0].daily["2026-09-10"].estimatedCostUsd).toBe(oldDay.estimatedCostUsd);
    expect(withLiveLocalUsage(data, { ...projects, updatedAt: "2026-09-10T01:00:00Z" })).toBe(data);
    expect(withLiveLocalUsage(data, { ...projects, warnings: ["scan_limit"] })).toBe(data);
  });
  it("uses Chinese count units only in Chinese", () => {
    expect([999, 1200, 10000, 206710000, 1e9].map(value => formatTokens(value, true))).toEqual(["999", "1.2千", "1万", "2.07亿", "10亿"]);
    expect(formatTokens(206710000, false)).toBe("206.71M");
  });
  it("merges OpenAI aliases without changing totals or inventing variant identities", () => {
    const data = createUsagePreview(now);
    for (const device of data.devices) for (const day of Object.values(device.daily)) {
      day.models = day.models.map((model, index) => ({ ...model, id: index ? "gpt-6-astra" : "openai/gpt-6-astra" }));
    }
    const result = aggregateGroupUsage(data, "demo", "today", now);
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({ id: "gpt-6-astra", name: "gpt-6-astra", totalTokens: result.totalTokens });
    expect(result.models[0].estimatedCostUsd).toBeCloseTo(2.7);
    const day = data.devices[0].daily["2026-09-10"];
    data.devices[0].ranges.all = { ...structuredClone(day), start: null, end: null };
    data.devices[0].daily = {};
    expect(aggregateGroupUsage(data, "demo", "all", now).models).toEqual(result.models);
    data.devices[0].ranges.all.models[0].estimatedCostUsd = null;
    expect(aggregateGroupUsage(data, "demo", "all", now).models[0].estimatedCostUsd).toBeNull();
    expect(canonicalModelId("tokei-name:openai/GPT-6-ASTRA")).toBe("gpt-6-astra");
    expect(canonicalModelId("gpt-6-astra-2026-09-01")).not.toBe("gpt-6-astra");
    expect(canonicalModelId("other/gpt-6-astra")).toBe("other/gpt-6-astra");
    expect(canonicalModelId("tokei-name:GPT-6")).toBe("gpt-6");
    expect(canonicalModelId("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(canonicalModelId("tokei-name:openai/GPT-6.1-SOL")).toBe("gpt-6.1-sol");
    expect(canonicalModelId("gpt-6.1-sol")).not.toBe(canonicalModelId("gpt-6-sol"));
    expect(canonicalModelId("tokei-name:openai/GPT-6-LUNA")).toBe("gpt-6-luna");
    expect(canonicalModelId("gpt-6-sol")).not.toBe(canonicalModelId("gpt-5.6-sol"));
  });
  it("keeps source variants separate and leaves generation-only history generic", () => {
    const data = createUsagePreview(now);
    const day = data.devices[0].daily["2026-09-10"];
    day.models = [
      { ...day.models[0], id: "openai/gpt-5.6-sol", name: "openai/gpt-5.6-sol", totalTokens: 100_000, estimatedCostUsd: 1 },
      { ...day.models[1], id: "gpt-5.6-luna", name: "gpt-5.6-luna", totalTokens: 200_000, estimatedCostUsd: 4 },
      { ...day.models[1], id: "gpt-6-astra", name: "gpt-6-astra", totalTokens: 250_000, estimatedCostUsd: 7.5 },
    ];
    const result = aggregateGroupUsage(data, "demo", "today", now);
    expect(result.models.map(model => ({ id: model.id, tokens: model.totalTokens, cost: model.estimatedCostUsd }))).toEqual([
      { id: "gpt-6-astra", tokens: 250_000, cost: 7.5 },
      { id: "gpt-5.6-luna", tokens: 200_000, cost: 4 },
      { id: "gpt-5.6-sol", tokens: 100_000, cost: 1 },
    ]);
    expect(canonicalModelId("tokei-name:GPT-5.6")).toBe("gpt-5.6");
    expect(canonicalModelId("tokei-name:GPT-6")).toBe("gpt-6");
  });
  it("includes cache once and does not add reasoning to output", () => {
    const result = aggregateGroupUsage(createUsagePreview(now), "demo", "today", now);
    expect(result.totalTokens).toBe(2000000);
    expect(result.totalTokens).toBe(result.inputTokens + result.cachedInputTokens + result.outputTokens);
    expect(result.models.map((item) => item.totalTokens)).toEqual([1600000, 400000]);
    expect(result.estimatedCostUsd).toBeCloseTo(2.7);
  });
  it("never folds unassigned devices or unknown groups into personal usage", () => {
    const data = createUsagePreview(now);
    data.devices.push({ ...structuredClone(data.devices[0]), id: "Someone else" });
    expect(aggregateGroupUsage(data, "demo", "today", now).totalTokens).toBe(2000000);
    expect(aggregateGroupUsage(data, "unknown", "today", now).hasData).toBe(false);
    expect(aggregateGroupUsage(data, null, "today", now).totalTokens).toBe(0);
  });
  it("deduplicates devices and selects only requested dates, not stale range names", () => {
    const data = createUsagePreview(now);
    const day = data.devices[0].daily["2026-09-10"];
    data.devices[0].daily["2026-09-03"] = structuredClone(day);
    data.devices[0].daily["2026-09-04"] = structuredClone(day);
    data.devices[0].daily["2026-09-11"] = structuredClone(day);
    data.devices.push(structuredClone(data.devices[0]));
    expect(aggregateGroupUsage(data, "demo", "today", now).totalTokens).toBe(2000000);
    expect(aggregateGroupUsage(data, "demo", "7d", now).totalTokens).toBe(4000000);
    expect(aggregateGroupUsage(data, "demo", "month", now).totalTokens).toBe(6000000);
    expect(periodStart("7d", new Date(2026, 0, 3))).toBe("2025-12-28");
  });
  it("exposes missing model data and missing costs without inventing zero", () => {
    const data = createUsagePreview(now);
    data.groups[0].deviceIds.push("Offline");
    data.devices[0].daily["2026-09-10"].estimatedCostUsd = null;
    data.devices[0].daily["2026-09-10"].models.pop();
    const result = aggregateGroupUsage(data, "demo", "today", now);
    expect(result.estimatedCostUsd).toBeNull();
    expect(result.incompleteModels).toBe(true);
    expect(result.missingDeviceIds).toEqual(["Offline"]);
    expect(aggregateGroupUsage(data, "demo", "today", new Date(2026, 8, 12)).estimatedCostUsd).toBeNull();
  });
  it("accepts arbitrary names but rejects ambiguous duplicate membership", () => {
    expect(validateGroupSettings({ groups: [{ id: "a", name: "My research", deviceIds: ["a"] }], defaultGroupId: "a" })).toBe(true);
    expect(validateGroupSettings({ groups: [{ id: "a", name: " ", deviceIds: [] }], defaultGroupId: "a" })).toBe(false);
    expect(validateGroupSettings({ groups: [{ id: "a", name: "One", deviceIds: ["x"] }, { id: "b", name: "Two", deviceIds: ["x"] }], defaultGroupId: "a" })).toBe(false);
    expect(validateGroupSettings({ groups: [], defaultGroupId: "removed" })).toBe(false);
    expect(validateGroupSettings({ groups: [], defaultGroupId: null })).toBe(true);
  });
  it("formats compact readable counts", () => {
    expect(formatTokens(110)).toBe("110");
    expect(formatTokens(1200)).toBe("1.2K");
    expect(formatTokens(2400000)).toBe("2.40M");
    expect(formatTokens(2500000000)).toBe("2.50B");
  });
});
