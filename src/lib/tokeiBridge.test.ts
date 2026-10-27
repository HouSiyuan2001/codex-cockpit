import { chinaTime } from "../test/chinaTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateGlobalUsage, createUsagePreview, withLiveLocalUsage, type ProjectUsageSnapshot, type TokeiUsage } from "./tokeiUsage";

const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
let getProjectUsage: typeof import("./tokeiBridge")["getProjectUsage"];
let getTokeiUsage: typeof import("./tokeiBridge")["getTokeiUsage"];
const now = chinaTime(2026, 8, 10, 12);
const localId = "local-synthetic-device";

function standalone() {
  const preview = createUsagePreview(now);
  const usage: TokeiUsage = { ...preview, status: "unavailable", devices: [], groups: [], defaultGroupId: null, localGroupId: null, warnings: ["config_unavailable", "sync_unavailable"] };
  const projects: ProjectUsageSnapshot = { deviceId: localId, updatedAt: preview.fetchedAt, status: "ready", coverage: "local", scannedFiles: 1, pricingSource: "bundled-catalog", pricingUpdatedAt: null, warnings: [], projects: [{ id: "synthetic-project", name: "Synthetic project", daily: preview.devices[0].daily }], tasks: [] };
  api.invoke.mockImplementation(async (command: string) => {
    if (command === "get_tokei_usage") return usage;
    if (command === "get_codex_project_usage") return projects;
    throw new Error(`Unexpected command: ${command}`);
  });
  return { usage, projects };
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: api.invoke } });
  api.invoke.mockReset();
  ({ getProjectUsage, getTokeiUsage } = await import("./tokeiBridge"));
});
afterEach(() => vi.unstubAllGlobals());

describe("native local usage reads", () => {
  it("uses the native stable identity without Tokei, cloud settings or a saved ledger", async () => {
    const { usage, projects } = standalone();
    const [aggregate, source] = await Promise.all([getTokeiUsage(), getProjectUsage()]);
    const result = withLiveLocalUsage(aggregate, source);
    expect(aggregateGlobalUsage(result, "all", now).totalTokens).toBe(2_000_000);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].id).toBe(localId);
    expect(result.status).toBe("ready");
    expect(result.warnings).toEqual([]);
    expect(usage.devices).toEqual([]);
    expect(projects.deviceId).toBe(localId);
    expect(api.invoke.mock.calls.map(([command]) => command).sort()).toEqual(["get_codex_project_usage", "get_tokei_usage"]);
  });

  it("shares concurrent collection between task and aggregate readers", async () => {
    const { projects } = standalone();
    let resolve!: (value: ProjectUsageSnapshot) => void;
    const pending = new Promise<ProjectUsageSnapshot>(done => { resolve = done; });
    api.invoke.mockImplementation(() => pending);
    const first = getProjectUsage();
    const second = getProjectUsage();
    await vi.waitFor(() => expect(api.invoke).toHaveBeenCalledTimes(1));
    resolve(projects);
    expect(await first).toBe(projects);
    expect(await second).toBe(projects);
    expect(api.invoke).toHaveBeenCalledTimes(1);
  });

  it("collects again after completion instead of serving an old result forever", async () => {
    const { projects } = standalone();
    expect(await getProjectUsage()).toBe(projects);
    const newer = { ...projects, updatedAt: "2026-09-10T08:00:00Z" };
    api.invoke.mockResolvedValueOnce(newer);
    expect(await getProjectUsage()).toBe(newer);
    expect(api.invoke).toHaveBeenCalledTimes(2);
  });

  it("propagates a failed read and permits a fresh retry", async () => {
    const { projects } = standalone();
    api.invoke.mockRejectedValueOnce(new Error("collector_busy"));
    const reads = [getProjectUsage(), getProjectUsage()];
    await Promise.all(reads.map(read => expect(read).rejects.toThrow("collector_busy")));
    expect(api.invoke).toHaveBeenCalledTimes(1);
    expect(await getProjectUsage()).toBe(projects);
    expect(api.invoke).toHaveBeenCalledTimes(2);
  });

  it("never rewrites missing identity or source errors into a virtual device or zero usage", async () => {
    const { usage, projects } = standalone();
    Object.assign(projects, { deviceId: null, status: "unavailable", projects: [], warnings: ["source_permission_denied"] });
    const source = await getProjectUsage();
    expect(source.deviceId).toBeNull();
    expect(withLiveLocalUsage(usage, source)).toBe(usage);
    api.invoke.mockRejectedValueOnce(new Error("local_settings_corrupt"));
    await expect(getTokeiUsage()).rejects.toThrow("local_settings_corrupt");
  });

  it("preserves configured identities and retained peer ledgers", async () => {
    const { usage, projects } = standalone();
    usage.devices = [{ ...createUsagePreview(now).devices[0], id: "Previous-PC" }];
    usage.status = "partial";
    const aggregate = await getTokeiUsage();
    expect(aggregate).toBe(usage);
    expect(api.invoke.mock.calls.map(([command]) => command)).toEqual(["get_tokei_usage"]);
    projects.deviceId = "Configured-PC";
    const merged = withLiveLocalUsage(aggregate, await getProjectUsage());
    expect(merged.devices.map(device => device.id)).toEqual(["Previous-PC", "Configured-PC"]);
    expect(merged.devices[0]).toBe(usage.devices[0]);
    expect(withLiveLocalUsage(merged, projects)).toBe(merged);
  });

  it("shows a first partial scan but retains a completed ledger during a rescan", async () => {
    const { usage, projects } = standalone();
    const complete = withLiveLocalUsage(usage, await getProjectUsage());
    const partial = { ...projects, updatedAt: "2026-09-10T08:00:00Z", status: "partial" as const, warnings: ["scan_limit"] };
    const first = withLiveLocalUsage(usage, partial);
    expect(first.status).toBe("partial");
    expect(first.devices[0].collectionPartial).toBe(true);
    expect(first.warnings).toContain("scan_limit");
    expect(withLiveLocalUsage(complete, partial)).toBe(complete);
  });

  it("keeps complete tokens visible when task titles or model prices are unknown", async () => {
    const { usage, projects } = standalone();
    projects.warnings = ["task_metadata_title_missing", "missing_model_price", "cost_context_unavailable"];
    for (const day of Object.values(projects.projects[0].daily)) {
      day.estimatedCostUsd = null;
      day.models.forEach(model => { model.estimatedCostUsd = null; });
    }
    const result = withLiveLocalUsage(usage, await getProjectUsage());
    const summary = aggregateGlobalUsage(result, "all", now);
    expect(result.status).toBe("ready");
    expect(result.devices[0].collectionPartial).toBe(false);
    expect(summary.totalTokens).toBe(2_000_000);
    expect(summary.estimatedCostUsd).toBeNull();
    expect(result.warnings).toEqual(projects.warnings);
  });
});
