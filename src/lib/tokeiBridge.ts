import { isTauri } from "./bridge";
import { createUsagePreview, validateGroupSettings, type DailyModelUsage, type ProjectUsageSnapshot, type TokeiGroupSettings, type TokeiUsage, type UsageMetrics } from "./tokeiUsage";

let previewSettings: TokeiGroupSettings | null = null;

export async function getProjectUsage(): Promise<ProjectUsageSnapshot> {
  if (!isTauri()) {
    const preview = createUsagePreview();
    const daily = preview.devices[0]?.daily ?? {};
    const scaledMetrics = (metrics: UsageMetrics, factor: number): UsageMetrics => ({ inputTokens: metrics.inputTokens * factor, cachedInputTokens: metrics.cachedInputTokens * factor, outputTokens: metrics.outputTokens * factor, reasoningTokens: metrics.reasoningTokens * factor, totalTokens: metrics.totalTokens * factor, estimatedCostUsd: metrics.estimatedCostUsd === null ? null : metrics.estimatedCostUsd * factor });
    const scaledDaily = (factor: number): Record<string, DailyModelUsage> => Object.fromEntries(Object.entries(daily).map(([date, day]) => [date, { ...scaledMetrics(day, factor), models: day.models.map(model => ({ ...model, ...scaledMetrics(model, factor) })) }]));
    return { deviceId: preview.devices[0]?.id ?? null, updatedAt: preview.fetchedAt, status: "ready", coverage: "local", scannedFiles: 3, pricingSource: "sample", pricingUpdatedAt: null, taskMetadataCoverage: "complete", warnings: [], projects: [{ id: "demo-project", name: "示例项目", daily }], tasks: [
      { id: "demo-root", name: "改进用量面板", projectName: "示例项目", relation: "root", rootId: "demo-root", daily: scaledDaily(.4) },
      { id: "demo-child", name: "检查统计归属", agentNickname: "示例助手", agentRole: "reviewer", projectName: "示例项目", parentId: "demo-root", rootId: "demo-root", relation: "subagent", daily: scaledDaily(.1) },
      { id: "demo-fork", name: "比较另一个设计方案", projectName: "示例项目", parentId: "demo-root", rootId: "demo-fork", relation: "fork", daily: scaledDaily(.5) },
    ] };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ProjectUsageSnapshot>("get_codex_project_usage");
}

export async function getTokeiUsage(): Promise<TokeiUsage> {
  if (!isTauri()) {
    const usage = { ...createUsagePreview(), ...(previewSettings ?? {}) };
    usage.localGroupId = usage.groups.find(group => group.deviceIds.includes("Demo Mac"))?.id ?? null;
    return usage;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<TokeiUsage>("get_tokei_usage");
}

export async function saveTokeiGroups(settings: TokeiGroupSettings, expected: TokeiGroupSettings): Promise<TokeiGroupSettings> {
  if (!validateGroupSettings(settings)) throw new Error("Invalid groups");
  if (!isTauri()) { previewSettings = structuredClone(settings); return previewSettings; }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<TokeiGroupSettings>("save_tokei_groups", { settings, expected });
}
