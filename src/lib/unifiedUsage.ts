import type { DailyModelUsage, ModelUsage, ProjectUsageSnapshot, TokeiDevice, TokeiUsage } from './tokeiUsage';

const timestamp = (value: string | null | undefined) => Date.parse(value ?? '') || 0;
const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const;
const zero = () => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, estimatedCostUsd: 0 as number | null });

// One immutable display ledger: task self-usage is the source for both pivots.
// Never merge a scan prefix with an older timezone ledger or persist this projection.
export function unifiedUsage(data: TokeiUsage, source: ProjectUsageSnapshot | null) {
  const devices = new Map<string, TokeiDevice>();
  for (const device of data.devices) {
    const old = devices.get(device.id);
    if (!old || timestamp(device.updatedAt) > timestamp(old.updatedAt)) devices.set(device.id, device);
  }
  const peers = new Map<string, NonNullable<ProjectUsageSnapshot['peerTasks']>[number]>();
  for (const peer of source?.peerTasks ?? []) {
    if (peer.deviceId === source?.deviceId) continue;
    const old = peers.get(peer.deviceId);
    if (!old || timestamp(peer.updatedAt) > timestamp(old.updatedAt)) peers.set(peer.deviceId, peer);
  }
  const ids = new Set([...devices.keys(), ...peers.keys(), ...(source?.deviceId ? [source.deviceId] : [])]);
  const taskDevices: NonNullable<ProjectUsageSnapshot['peerTasks']> = [];
  const projected: TokeiDevice[] = [];
  for (const id of ids) {
    const old = devices.get(id);
    const local = id === source?.deviceId && source.status !== 'unavailable' && source.tasks !== undefined;
    const peer = peers.get(id);
    const peerAvailable = peer !== undefined && (!peer.taskDetailsStatus || peer.taskDetailsStatus === 'available');
    const available = local || peerAvailable;
    const raw = local ? source!.tasks! : (peerAvailable ? peer.tasks : undefined) ?? [{ id: '__unattributed', name: '未归属任务 / Unattributed', relation: 'unlinked' as const, daily: old?.daily ?? {} }];
    const tasks = [...new Map(raw.map(task => [task.id, task])).values()].map(task => ({ ...task, daily: Object.fromEntries(Object.entries(task.daily).map(([date, day]) => [date, normalizeDay(day)])) }));
    const daily: Record<string, DailyModelUsage> = {};
    for (const task of tasks) for (const [date, day] of Object.entries(task.daily)) {
      const target = daily[date] ?? { ...zero(), models: [] };
      for (const key of keys) target[key] += day[key];
      target.estimatedCostUsd = target.estimatedCostUsd === null || day.estimatedCostUsd === null ? null : target.estimatedCostUsd + day.estimatedCostUsd;
      // Preserve individual priced/unpriced contributions; the shared aggregator
      // combines model identities without throwing away their known portion.
      target.models.push(...day.models);
      daily[date] = target;
    }
    const partial = local ? source!.status !== 'ready' : peer?.partial ?? true;
    const updatedAt = local ? source!.updatedAt : peer?.updatedAt ?? old?.updatedAt ?? data.fetchedAt;
    const ranges = !available ? Object.fromEntries(Object.entries(old?.ranges ?? {}).map(([key, range]) => [key, { ...normalizeDay(range), start: range.start, end: range.end }])) : {};
    const device = { id, updatedAt, stale: old?.stale ?? false, collectionPartial: partial, liveLocal: available, daily, ranges };
    projected.push(device);
    if (!available) tasks[0] = { ...tasks[0], summaryDevice: device } as typeof tasks[number];
    taskDevices.push({ deviceId: id, updatedAt, partial: partial || !available, tasks, taskDetailsStatus: peer?.taskDetailsStatus });
  }
  const localId = source?.deviceId ?? null;
  const projects: ProjectUsageSnapshot = {
    ...(source ?? { deviceId: null, updatedAt: data.fetchedAt, status: 'partial', coverage: 'local', scannedFiles: 0, pricingSource: '', pricingUpdatedAt: null, projects: [], warnings: [] }),
    tasks: taskDevices.find(device => device.deviceId === localId)?.tasks ?? [],
    peerTasks: taskDevices.filter(device => device.deviceId !== localId),
  };
  return { data: { ...data, devices: projected }, projects };
}

function normalizeDay(day: DailyModelUsage): DailyModelUsage {
  const totals = zero();
  for (const model of day.models) for (const key of keys) totals[key] += model[key];
  const cost = day.models.reduce<number | null>((sum, model) => sum === null || model.estimatedCostUsd === null ? null : sum + model.estimatedCostUsd, 0);
  const consistent = keys.every(key => totals[key] === day[key]) && (day.estimatedCostUsd === null || cost !== null && Math.abs(cost - day.estimatedCostUsd) < 1e-6);
  if (consistent) return { ...day, models: day.models.map(model => ({ ...model })) };
  // A legacy daily summary cannot establish a model split. Keep its complete
  // measured total explicitly unattributed rather than inventing model weights.
  const { models: _models, ...metrics } = day;
  const model: ModelUsage = { ...metrics, id: '__unattributed_model', name: '未归属模型 / Unattributed' };
  return { ...day, models: [model] };
}
