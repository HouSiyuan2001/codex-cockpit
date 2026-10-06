export interface UsageMetrics {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface ModelUsage extends UsageMetrics { id: string; name: string; costIncomplete?: boolean }
/** Strip only the known OpenAI namespace; keep variants, dates and other providers distinct. */
export function canonicalModelId(id: string): string {
  const candidate = id.trim().replace(/^tokei-name:/i, "").replace(/^openai\//i, "").toLowerCase();
  return /^gpt-\d[\w.-]*$/.test(candidate) ? candidate : id;
}

function addModel(models: Map<string, ModelUsage>, model: ModelUsage): void {
  const id = canonicalModelId(model.id);
  const aggregate = models.get(id) ?? { ...ZERO, id, name: /^gpt-\d/.test(id) ? id : model.name };
  addMetrics(aggregate, model);
  if (model.costIncomplete) aggregate.costIncomplete = true;
  models.set(id, aggregate);
}
export interface DailyModelUsage extends UsageMetrics { models: ModelUsage[] }
export interface TokeiGroup { id: string; name: string; deviceIds: string[] }
export interface TokeiGroupSettings { groups: TokeiGroup[]; defaultGroupId: string | null }
export interface TokeiDevice {
  id: string;
  updatedAt: string | null;
  stale: boolean;
  collectionPartial?: boolean;
  daily: Record<string, DailyModelUsage>;
  ranges: Record<string, DailyModelUsage & { start: string | null; end: string | null }>;
}
export interface TokeiUsage extends TokeiGroupSettings {
  /** Derived on this device; never part of shared member settings. */
  localGroupId?: string | null;
  fetchedAt: string;
  status: "ready" | "partial" | "unavailable";
  devices: TokeiDevice[];
  warnings: string[];
  projectBreakdownAvailable: boolean;
}

export type UsagePeriod = "today" | "7d" | "30d" | "week" | "month" | "all";
export type UsageMetric = "tokens" | "cost";
export const metricValue = (row: UsageMetrics, metric: UsageMetric) => metric === "cost" ? row.estimatedCostUsd : row.totalTokens;
export const formatCost = (value: number | null, zh: boolean) => value === null ? (zh ? "暂无估算" : "Unavailable") : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Virtual, never persisted. A device belongs to exactly one user; unassigned devices remain visible. */
export function globalUsageData(data: TokeiUsage): TokeiUsage {
  const assigned = new Set<string>();
  const groups = data.groups.map(group => ({ ...group, deviceIds: group.deviceIds.filter(id => {
    if (assigned.has(id)) return false;
    assigned.add(id); return true;
  }) }));
  const unassigned = [...new Set(data.devices.map(device => device.id))].filter(id => !assigned.has(id));
  let id = "__unassigned";
  while (groups.some(group => group.id === id)) id += "_";
  if (unassigned.length) groups.push({ id, name: "未分组 / Unassigned", deviceIds: unassigned });
  return { ...data, groups };
}

export function aggregateGlobalUsage(data: TokeiUsage, period: UsagePeriod, now = new Date()) {
  const normalized = globalUsageData(data);
  const users = normalized.groups.map(group => {
    const summary = aggregateGroupUsage(normalized, group.id, period, now);
    return { ...summary, id: group.id, name: group.name, estimatedCostUsd: summary.knownCostUsd, costIncomplete: summary.estimatedCostUsd === null };
  });
  const summary = aggregateGroupUsage({ ...normalized, groups: [{ id: "global", name: "global", deviceIds: normalized.groups.flatMap(group => group.deviceIds) }] }, "global", period, now);
  if (summary.missingDeviceIds.length || users.some(user => user.costIncomplete)) summary.estimatedCostUsd = null;
  return { ...summary, users };
}
export interface ProjectUsageSnapshot {
  deviceId: string | null;
  updatedAt: string;
  status: "ready" | "partial" | "unavailable";
  coverage: "local";
  scannedFiles: number;
  pricingSource: string;
  pricingUpdatedAt: string | null;
  taskMetadataCoverage?: "complete" | "partial" | "unavailable";
  projects: { id: string; name: string; daily: Record<string, DailyModelUsage> }[];
  /** Local-only task metadata. Optional while reading legacy native snapshots and test fixtures. */
  tasks?: TaskUsage[];
  peerTasks?: { deviceId: string; updatedAt: string; partial: boolean; tasks: TaskUsage[] }[];
  warnings: string[];
}

export type TaskRelation = "root" | "subagent" | "fork" | "unlinked";
export interface TaskUsage {
  id: string;
  name: string;
  projectName?: string;
  parentId?: string;
  rootId?: string;
  relation: TaskRelation;
  agentNickname?: string;
  agentRole?: string;
  /** Self usage only. Descendant usage is folded exactly once by aggregateTaskUsage. */
  daily: Record<string, DailyModelUsage>;
}

export interface TaskUsageDetail extends UsageMetrics {
  knownCostUsd?: number | null;
  id: string;
  name: string;
  projectName?: string;
  relation: TaskRelation;
  agentNickname?: string;
  agentRole?: string;
  models: ModelUsage[];
}

export interface AggregatedTaskUsage extends UsageMetrics {
  sourceDevice?: string;
  knownCostUsd?: number | null;
  id: string;
  name: string;
  rawName: string;
  projectName?: string;
  relation: TaskRelation;
  self: TaskUsageDetail;
  children: TaskUsageDetail[];
  costIncomplete?: boolean;
}

/** Each device is an independent ledger. Never fold lineage across devices. */
export function aggregateSyncedTaskUsage(data: ProjectUsageSnapshot, settings: TokeiGroupSettings, groupId: string | null, period: UsagePeriod, now = new Date()): TaskUsageAggregate {
  const local = aggregateTaskUsage(data, settings, groupId, period, now);
  const rows = local.rows.map(row => ({ ...row, id: JSON.stringify([data.deviceId, row.id]) }));
  const peers = new Map<string, NonNullable<ProjectUsageSnapshot["peerTasks"]>[number]>();
  for (const peer of data.peerTasks ?? []) {
    if (peer.deviceId === data.deviceId) continue;
    const old = peers.get(peer.deviceId);
    if (!old || Date.parse(peer.updatedAt) > Date.parse(old.updatedAt)) peers.set(peer.deviceId, peer);
  }
  for (const peer of peers.values()) {
    const aggregate = aggregateTaskUsage({ ...data, deviceId: peer.deviceId, tasks: peer.tasks }, settings, groupId, period, now);
    rows.push(...aggregate.rows.map(row => ({ ...row, id: JSON.stringify([peer.deviceId, row.id]), sourceDevice: peer.deviceId })));
  }
  const attributed = { ...ZERO };
  for (const row of rows) addMetrics(attributed, row);
  return { rows, attributed, localIncluded: local.localIncluded };
}

export interface TaskUsageAggregate {
  rows: AggregatedTaskUsage[];
  attributed: UsageMetrics;
  localIncluded: boolean;
}

function aggregateTaskDetail(task: TaskUsage, period: UsagePeriod, now: Date): TaskUsageDetail & { hasData: boolean } {
  const start = periodStart(period, now);
  const today = localDateKey(now);
  const result: TaskUsageDetail & { hasData: boolean } = {
    ...ZERO,
    id: task.id,
    name: task.name,
    projectName: task.projectName,
    relation: task.relation,
    agentNickname: task.agentNickname,
    agentRole: task.agentRole,
    models: [],
    hasData: false,
  };
  const models = new Map<string, ModelUsage>();
  let knownCostUsd: number | null = null;
  for (const [date, day] of Object.entries(task.daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > today) continue;
    result.hasData = true;
    addMetrics(result, day);
    const known = day.estimatedCostUsd !== null ? [day.estimatedCostUsd] : day.models.flatMap(model => model.estimatedCostUsd === null ? [] : [model.estimatedCostUsd]);
    for (const cost of known) knownCostUsd = (knownCostUsd ?? 0) + cost;
    for (const model of day.models) {
      addModel(models, model);
    }
  }
  result.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  result.knownCostUsd = knownCostUsd;
  return result;
}

function shortTaskId(id: string): string {
  return id.length <= 8 ? id : id.slice(-8);
}

/**
 * Fold only proven subagents into their originating task. Broken links and cycles stay
 * independent, so malformed lineage cannot hide or double-count a task.
 */
export function aggregateTaskUsage(data: ProjectUsageSnapshot, settings: TokeiGroupSettings, groupId: string | null, period: UsagePeriod, now = new Date()): TaskUsageAggregate {
  const localIncluded = Boolean(data.deviceId && settings.groups.find((group) => group.id === groupId)?.deviceIds.includes(data.deviceId));
  const empty = (): UsageMetrics => ({ ...ZERO });
  if (!localIncluded) return { rows: [], attributed: empty(), localIncluded: false };

  // Duplicate ids are invalid as stable identities. Count the first occurrence once.
  const tasks = [...new Map((data.tasks ?? []).map((task) => [task.id, task])).values()];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const foldTarget = new Map<string, string>();
  for (const task of tasks) {
    if (task.relation !== "subagent") continue;
    const seen = new Set([task.id]);
    let current: TaskUsage | undefined = task;
    while (current?.relation === "subagent") {
      const nextId: string | undefined = current.rootId ?? current.parentId;
      if (!nextId || seen.has(nextId)) { current = undefined; break; }
      seen.add(nextId);
      current = byId.get(nextId);
    }
    if (current) foldTarget.set(task.id, current.id);
  }

  const details = new Map(tasks.map((task) => [task.id, aggregateTaskDetail(task, period, now)]));
  const children = new Map<string, Array<TaskUsageDetail & { hasData: boolean }>>();
  for (const [childId, targetId] of foldTarget) {
    const child = details.get(childId);
    if (child) children.set(targetId, [...(children.get(targetId) ?? []), child]);
  }

  const rawRows = tasks.filter((task) => !foldTarget.has(task.id)).map((task) => {
    const self = details.get(task.id)!;
    const childRows = (children.get(task.id) ?? []).filter((child) => child.hasData);
    const aggregate: UsageMetrics = empty();
    addMetrics(aggregate, self);
    for (const child of childRows) addMetrics(aggregate, child);
    return {
      ...aggregate,
      id: task.id,
      name: task.name,
      rawName: task.name,
      projectName: task.projectName,
      relation: task.relation,
      self,
      children: childRows,
      hasData: self.hasData || childRows.length > 0,
      costIncomplete: aggregate.estimatedCostUsd === null,
      knownCostUsd: [self, ...childRows].reduce<number | null>((sum, detail) => detail.knownCostUsd == null ? sum : (sum ?? 0) + detail.knownCostUsd, null),
    };
  }).filter((row) => row.hasData);

  const duplicateNames = new Map<string, number>();
  for (const row of rawRows) duplicateNames.set(row.rawName, (duplicateNames.get(row.rawName) ?? 0) + 1);
  const rows: AggregatedTaskUsage[] = rawRows.map(({ hasData: _hasData, ...row }) => ({
    ...row,
    name: (duplicateNames.get(row.rawName) ?? 0) > 1
      ? `${row.rawName} · ${row.projectName ? `${row.projectName} · ` : ""}${shortTaskId(row.id)}`
      : row.rawName,
  })).sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  const attributed = empty();
  for (const row of rows) addMetrics(attributed, row);
  return { rows, attributed, localIncluded: true };
}

export interface TaskUsageReconciliation {
  outstandingLocal: UsageMetrics | null;
  nonLocal: UsageMetrics | null;
  mismatch: "tasks-exceed-local" | "local-exceeds-group" | null;
}

function subtractMetrics(total: UsageMetrics, part: UsageMetrics): UsageMetrics {
  return {
    inputTokens: total.inputTokens - part.inputTokens,
    cachedInputTokens: total.cachedInputTokens - part.cachedInputTokens,
    outputTokens: total.outputTokens - part.outputTokens,
    reasoningTokens: total.reasoningTokens - part.reasoningTokens,
    totalTokens: total.totalTokens - part.totalTokens,
    estimatedCostUsd: total.estimatedCostUsd === null || part.estimatedCostUsd === null ? null : total.estimatedCostUsd - part.estimatedCostUsd,
  };
}

function metricsExceed(part: UsageMetrics, total: UsageMetrics): boolean {
  return COUNT_KEYS.some((key) => part[key] > total[key])
    || (part.estimatedCostUsd !== null && total.estimatedCostUsd !== null && part.estimatedCostUsd > total.estimatedCostUsd + 1e-9);
}

/** Reconcile independently collected totals without manufacturing zero/negative remainders. */
export function reconcileTaskUsage(group: UsageMetrics, local: UsageMetrics, attributed: UsageMetrics): TaskUsageReconciliation {
  if (metricsExceed(attributed, local)) return { outstandingLocal: null, nonLocal: metricsExceed(local, group) ? null : subtractMetrics(group, local), mismatch: "tasks-exceed-local" };
  if (metricsExceed(local, group)) return { outstandingLocal: subtractMetrics(local, attributed), nonLocal: null, mismatch: "local-exceeds-group" };
  return { outstandingLocal: subtractMetrics(local, attributed), nonLocal: subtractMetrics(group, local), mismatch: null };
}

export function aggregateProjectUsage(data: ProjectUsageSnapshot, settings: TokeiGroupSettings, groupId: string | null, period: UsagePeriod, now = new Date()): ModelUsage[] {
  if (!data.deviceId || !settings.groups.find((group) => group.id === groupId)?.deviceIds.includes(data.deviceId)) return [];
  return data.projects.map((project) => {
    const summary = aggregateGroupUsage({ ...settings, fetchedAt: data.updatedAt, status: data.status, warnings: [], projectBreakdownAvailable: true, devices: [{ id: data.deviceId!, updatedAt: data.updatedAt, stale: false, daily: project.daily, ranges: {} }] }, groupId, period, now);
    return { ...summary, id: project.id, name: project.name };
  }).filter((project) => project.hasData).sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
}
export interface GroupUsage extends UsageMetrics {
  models: ModelUsage[];
  devices: TokeiDevice[];
  missingDeviceIds: string[];
  hasData: boolean;
  incompleteModels: boolean;
  rangeDeviceIds: string[];
  unavailablePeriodDeviceIds: string[];
  knownCostUsd: number | null;
}

const ZERO: UsageMetrics = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
const COUNT_KEYS = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "totalTokens"] as const;

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function periodStart(period: UsagePeriod, now: Date): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "all") return "0000-00-00";
  if (period === "7d") start.setDate(start.getDate() - 6);
  if (period === "30d") start.setDate(start.getDate() - 29);
  if (period === "week") start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (period === "month") start.setDate(1);
  return localDateKey(start);
}

export function periodEndExclusive(period: UsagePeriod, now: Date): string {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (period === "month") return localDateKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  if (period === "week") {
    const monday = new Date(`${periodStart("week", now)}T12:00:00`);
    monday.setDate(monday.getDate() + 7);
    return localDateKey(monday);
  }
  return localDateKey(end);
}

/** Pick one source per device: dated ledger OR one exactly matching range, never both. */
export function selectDeviceUsage(device: TokeiDevice, period: UsagePeriod, now = new Date()): { records: DailyModelUsage[]; source: "daily" | "range" | "none" } {
  const start = periodStart(period, now);
  const today = localDateKey(now);
  const daily = Object.entries(device.daily).filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= start && date <= today).map(([, day]) => day);
  const dailyTotal = daily.reduce((sum, day) => sum + day.totalTokens, 0);
  const updated = Date.parse(device.updatedAt ?? "");
  if (!Number.isFinite(updated) || updated > now.getTime() + 300000) return daily.length ? { records: daily, source: "daily" } : { records: [], source: "none" };
  const end = periodEndExclusive(period, now);
  // Prefer explicit names only when bounds also match; week never stands for rolling 7d.
  const ranges = period === "all" ? [["all", device.ranges.all] as const] : Object.entries(device.ranges);
  for (const [key, range] of ranges) {
    if (!range) continue;
    const matches = period === "all" ? key === "all" && range.start === null && range.end === null
      : range.start === start && range.end === end && localDateKey(new Date(updated)) >= start;
    if (matches && (!daily.length || range.totalTokens > dailyTotal)) return { records: [range], source: "range" };
  }
  return daily.length ? { records: daily, source: "daily" } : { records: [], source: "none" };
}

function addMetrics(target: UsageMetrics, value: UsageMetrics): void {
  for (const key of COUNT_KEYS) target[key] += value[key];
  target.estimatedCostUsd = target.estimatedCostUsd === null || value.estimatedCostUsd === null
    ? null : target.estimatedCostUsd + value.estimatedCostUsd;
}

/** Daily records avoid mistaking a peer's stale `today` snapshot for today's usage. */
export function aggregateGroupUsage(data: TokeiUsage, groupId: string | null, period: UsagePeriod, now = new Date()): GroupUsage {
  const group = data.groups.find((item) => item.id === groupId);
  const wanted = new Set(group?.deviceIds ?? []);
  // A second copy of a device never counts twice; retain its newest snapshot.
  const unique = new Map<string, TokeiDevice>();
  for (const device of data.devices) {
    if (!wanted.has(device.id)) continue;
    const previous = unique.get(device.id);
    if (!previous || (Date.parse(device.updatedAt ?? "") || 0) > (Date.parse(previous.updatedAt ?? "") || 0)) unique.set(device.id, device);
  }
  const devices = [...unique.values()];
  const result: GroupUsage = {
    ...ZERO, models: [], devices,
    missingDeviceIds: [...wanted].filter((id) => !unique.has(id)),
    hasData: false, incompleteModels: false, rangeDeviceIds: [], unavailablePeriodDeviceIds: [], knownCostUsd: null,
  };
  const models = new Map<string, ModelUsage>();
  for (const device of devices) {
    const selected = selectDeviceUsage(device, period, now);
    if (selected.source === "range") result.rangeDeviceIds.push(device.id);
    if (selected.source === "none") result.unavailablePeriodDeviceIds.push(device.id);
    for (const day of selected.records) {
      result.hasData = true;
      addMetrics(result, day);
      const known = day.estimatedCostUsd === null ? day.models.filter(model => model.estimatedCostUsd !== null).map(model => model.estimatedCostUsd!) : [day.estimatedCostUsd];
      if (known.length) result.knownCostUsd = (result.knownCostUsd ?? 0) + known.reduce((sum, cost) => sum + cost, 0);
      let modelTotal = 0;
      for (const model of day.models) {
        addModel(models, model);
        modelTotal += model.totalTokens;
      }
      if (modelTotal !== day.totalTokens) result.incompleteModels = true;
    }
  }
  result.models = [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name));
  if (!result.hasData || result.unavailablePeriodDeviceIds.length || result.missingDeviceIds.length) result.estimatedCostUsd = null;
  return result;
}

export function formatTokens(count: number, zh = false): string {
  if (zh) {
    const number = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, useGrouping: false }).format(value);
    if (count >= 1e8) return `${number(count / 1e8)}亿`;
    if (count >= 1e4) return `${number(count / 1e4)}万`;
    if (count >= 1e3) return `${number(count / 1e3)}千`;
    return number(count);
  }
  if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
  return count.toLocaleString("en-US");
}

export function validateGroupSettings(settings: TokeiGroupSettings): boolean {
  if (settings.groups.length > 32) return false;
  const ids = new Set<string>();
  const names = new Set<string>();
  const devices = new Set<string>();
  for (const group of settings.groups) {
    const name = group.name.trim();
    if (!group.id || ids.has(group.id) || !name || name.length > 64 || names.has(name)) return false;
    ids.add(group.id); names.add(name);
    for (const id of group.deviceIds) {
      if (!id || devices.has(id)) return false;
      devices.add(id);
    }
  }
  return settings.defaultGroupId === null || ids.has(settings.defaultGroupId);
}

/** Synthetic browser preview only; no local data or real device/person names. */
export function createUsagePreview(now = new Date()): TokeiUsage {
  const first: ModelUsage = { id: "demo-a", name: "Model A", inputTokens: 220000, cachedInputTokens: 1300000, outputTokens: 80000, reasoningTokens: 25000, totalTokens: 1600000, estimatedCostUsd: 2.4 };
  const second: ModelUsage = { id: "demo-b", name: "Model B", inputTokens: 80000, cachedInputTokens: 290000, outputTokens: 30000, reasoningTokens: 9000, totalTokens: 400000, estimatedCostUsd: 0.3 };
  const day = { ...ZERO, models: [first, second] };
  addMetrics(day, first); addMetrics(day, second);
  return {
    fetchedAt: now.toISOString(), status: "ready", groups: [{ id: "demo", name: "示例分组", deviceIds: ["Demo Mac"] }], defaultGroupId: "demo", localGroupId: "demo",
    devices: [{ id: "Demo Mac", updatedAt: now.toISOString(), stale: false, ranges: {}, daily: { [localDateKey(now)]: day } }],
    warnings: [], projectBreakdownAvailable: false,
  };
}
