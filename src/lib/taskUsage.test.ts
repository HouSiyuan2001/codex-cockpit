import { describe, expect, it } from "vitest";
import { aggregateTaskUsage, aggregateSyncedTaskUsage, reconcileTaskUsage, type DailyModelUsage, type ProjectUsageSnapshot, type TaskUsage, type TokeiGroupSettings, type UsageMetrics } from "./tokeiUsage";

const now = new Date(2026, 8, 10, 12);
const settings: TokeiGroupSettings = { groups: [{ id: "mine", name: "Mine", deviceIds: ["Local Mac"] }], defaultGroupId: "mine" };

function day(totalTokens: number, model = "GPT-5.6"): DailyModelUsage {
  const usage = { inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens, estimatedCostUsd: totalTokens / 100 };
  return { ...usage, models: [{ ...usage, id: model, name: model }] };
}

function task(id: string, relation: TaskUsage["relation"], totalTokens: number, extra: Partial<TaskUsage> = {}): TaskUsage {
  return { id, name: id, relation, daily: { "2026-09-10": day(totalTokens) }, ...extra };
}

function snapshot(tasks: TaskUsage[]): ProjectUsageSnapshot {
  return { deviceId: "Local Mac", updatedAt: now.toISOString(), status: "ready", coverage: "local", scannedFiles: tasks.length, pricingSource: "test", pricingUpdatedAt: null, taskMetadataCoverage: "complete", projects: [], tasks, warnings: [] };
}

describe("synced task usage", () => {
  it("isolates device identities and lineage, ignores local echoes, and takes newest peer snapshot", () => {
    const data = snapshot([task("root", "root", 100)]);
    data.peerTasks = [
      { deviceId: "Peer", updatedAt: "2026-09-10T01:00:00Z", partial: false, tasks: [task("root", "root", 900)] },
      { deviceId: "Peer", updatedAt: "2026-09-10T02:00:00Z", partial: false, tasks: [task("root", "root", 20), task("child", "subagent", 10, { parentId: "root" })] },
      { deviceId: "Local Mac", updatedAt: now.toISOString(), partial: false, tasks: [task("root", "root", 999)] },
    ];
    const both = { groups: [{ id: "both", name: "Both", deviceIds: ["Local Mac", "Peer"] }], defaultGroupId: "both" };
    const result = aggregateSyncedTaskUsage(data, both, "both", "today", now);
    expect(result.rows).toHaveLength(2);
    expect(new Set(result.rows.map(row => row.id)).size).toBe(2);
    expect(result.attributed.totalTokens).toBe(130);
    expect(result.rows.find(row => row.sourceDevice === "Peer")?.children).toHaveLength(1);
    expect(aggregateSyncedTaskUsage(data, settings, "mine", "today", now).attributed.totalTokens).toBe(100);
    const remote = aggregateSyncedTaskUsage(data, { groups: [{ id: "peer", name: "Peer", deviceIds: ["Peer"] }], defaultGroupId: "peer" }, "peer", "today", now);
    expect(remote.localIncluded).toBe(false);
    expect(remote.attributed.totalTokens).toBe(30);
  });
});

describe("local task usage", () => {
  it("includes exactly thirty calendar dates across month boundaries", () => {
    const ranged = task("rolling", "root", 10);
    ranged.daily = { "2026-08-11": day(1000), "2026-08-12": day(20), "2026-09-10": day(10), "2026-09-11": day(1000) };
    const result = aggregateTaskUsage(snapshot([ranged]), settings, "mine", "30d", now);
    expect(result.attributed.totalTokens).toBe(30);
  });
  it("recovers known model costs from an incomplete day without double-counting complete days", () => {
    const mixed = task("mixed", "root", 100);
    const partial = day(100);
    partial.estimatedCostUsd = null;
    partial.models.push({ ...day(50).models[0], id: "unpriced", name: "unpriced", estimatedCostUsd: null });
    partial.totalTokens = 150;
    mixed.daily = { "2026-09-09": day(200), "2026-09-10": partial };
    const result = aggregateTaskUsage(snapshot([mixed]), settings, "mine", "7d", now);
    expect(result.rows[0]).toMatchObject({ estimatedCostUsd: null, knownCostUsd: 3, costIncomplete: true, totalTokens: 350 });
  });

  it("keeps known costs without pretending incomplete totals are complete", () => {
    const unknown = task("child", "subagent", 50, { parentId: "root" });
    unknown.daily["2026-09-10"].estimatedCostUsd = null;
    unknown.daily["2026-09-10"].models[0].estimatedCostUsd = null;
    const result = aggregateTaskUsage(snapshot([task("root", "root", 100), unknown]), settings, "mine", "today", now);
    expect(result.rows[0]).toMatchObject({ estimatedCostUsd: null, knownCostUsd: 1, costIncomplete: true, totalTokens: 150 });
    expect(result.attributed.estimatedCostUsd).toBeNull();
    expect(result.rows[0].children[0].knownCostUsd).toBeNull();
  });

  it("folds nested subagents into their originating task while keeping normal forks distinct", () => {
    const result = aggregateTaskUsage(snapshot([
      task("root", "root", 100, { name: "Research task" }),
      task("child", "subagent", 50, { name: "Worker", parentId: "root", rootId: "root", agentNickname: "成员甲", agentRole: "worker" }),
      task("grandchild", "subagent", 25, { name: "Nested worker", parentId: "child", rootId: "root", agentRole: "explorer" }),
      task("fork", "fork", 40, { name: "Independent fork", parentId: "root", rootId: "root" }),
    ]), settings, "mine", "today", now);

    expect(result.rows.map((row) => [row.id, row.totalTokens])).toEqual([["root", 175], ["fork", 40]]);
    expect(result.rows[0].self.totalTokens).toBe(100);
    expect(result.rows[0].children.map((child) => [child.id, child.agentRole])).toEqual([["child", "worker"], ["grandchild", "explorer"]]);
    expect(result.attributed.totalTokens).toBe(215);
  });

  it("uses a proven root despite a missing immediate parent and leaves an orphan visible", () => {
    const result = aggregateTaskUsage(snapshot([
      task("root", "root", 100),
      task("known-root", "subagent", 30, { parentId: "missing", rootId: "root" }),
      task("orphan", "subagent", 20, { parentId: "missing" }),
    ]), settings, "mine", "today", now);

    expect(result.rows.find((row) => row.id === "root")?.children.map((child) => child.id)).toEqual(["known-root"]);
    expect(result.rows.find((row) => row.id === "orphan")?.totalTokens).toBe(20);
    expect(result.attributed.totalTokens).toBe(150);
  });

  it("breaks lineage cycles without hiding or counting either task twice", () => {
    const result = aggregateTaskUsage(snapshot([
      task("cycle-a", "subagent", 11, { rootId: "cycle-b" }),
      task("cycle-b", "subagent", 13, { rootId: "cycle-a" }),
    ]), settings, "mine", "today", now);

    expect(result.rows.map((row) => row.id).sort()).toEqual(["cycle-a", "cycle-b"]);
    expect(result.attributed.totalTokens).toBe(24);
  });

  it("selects only dates in the requested range and excludes tasks when the local device is outside the group", () => {
    const ranged = task("ranged", "root", 10);
    ranged.daily = {
      "2026-09-03": day(3),
      "2026-09-04": day(4),
      "2026-09-10": day(10),
      "2026-09-11": day(99),
    };
    const data = snapshot([ranged]);
    expect(aggregateTaskUsage(data, settings, "mine", "today", now).attributed.totalTokens).toBe(10);
    expect(aggregateTaskUsage(data, settings, "mine", "7d", now).attributed.totalTokens).toBe(14);
    expect(aggregateTaskUsage(data, settings, "mine", "week", now).attributed.totalTokens).toBe(10);
    expect(aggregateTaskUsage(data, settings, "mine", "month", now).attributed.totalTokens).toBe(17);
    const excluded = aggregateTaskUsage(data, { groups: [{ id: "other", name: "Other", deviceIds: ["Peer"] }], defaultGroupId: "other" }, "other", "all", now);
    expect(excluded).toMatchObject({ rows: [], localIncluded: false, attributed: { totalTokens: 0 } });
  });

  it("disambiguates repeated titles with project and short id while identity follows the stable id", () => {
    const firstId = "01a08b5b-27a7-7182-b733-111111111111";
    const secondId = "01a08b5b-27a7-7182-b733-222222222222";
    const data = snapshot([
      task(firstId, "root", 10, { name: "Same title", projectName: "P020" }),
      task(secondId, "fork", 20, { name: "Same title", projectName: "P021" }),
    ]);
    const result = aggregateTaskUsage(data, settings, "mine", "today", now);
    expect(result.rows.map((row) => row.name).sort()).toEqual(["Same title · P020 · 11111111", "Same title · P021 · 22222222"]);
    data.tasks![0].name = "Renamed title";
    expect(aggregateTaskUsage(data, settings, "mine", "today", now).rows.find((row) => row.id === firstId)?.name).toBe("Renamed title");
  });

  it("reports arithmetic mismatches instead of clamping a negative remainder", () => {
    const metrics = (totalTokens: number): UsageMetrics => ({ inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens, estimatedCostUsd: totalTokens / 100 });
    const valid = reconcileTaskUsage(metrics(300), metrics(200), metrics(150));
    expect(valid.outstandingLocal?.totalTokens).toBe(50);
    expect(valid.nonLocal?.totalTokens).toBe(100);
    expect(valid.mismatch).toBeNull();
    const mismatch = reconcileTaskUsage(metrics(300), metrics(200), metrics(250));
    expect(mismatch.outstandingLocal).toBeNull();
    expect(mismatch.mismatch).toBe("tasks-exceed-local");
  });
});
