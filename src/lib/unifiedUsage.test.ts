import { describe, expect, it } from 'vitest';
import { unifiedUsage } from './unifiedUsage';
import { aggregateGroupUsage, aggregateSyncedTaskUsage, createUsagePreview, type DailyModelUsage, type ProjectUsageSnapshot, type TaskUsage, type UsagePeriod } from './tokeiUsage';
import { tasksInRange, usageInRange } from './usageCalendar';
const now = new Date('2026-10-27T00:30:00-07:00');
function day(tokens: number, cost: number | null): DailyModelUsage {
  const metrics = { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: tokens, estimatedCostUsd: cost };
  return { ...metrics, models: [{ ...metrics, id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' }] };
}
function task(id: string, tokens: number, cost: number | null): TaskUsage {
  return { id, name: id, relation: 'root', daily: { '2026-10-27': day(tokens, cost), '2026-10-26': day(10, 1) } };
}
function fixture() {
  const data = createUsagePreview(now);
  data.devices[0].daily = { '2026-10-27': day(193000000, 15.14) };
  const source: ProjectUsageSnapshot = { deviceId: data.devices[0].id, updatedAt: now.toISOString(), status: 'partial', coverage: 'local', scannedFiles: 2, pricingSource: 'test', pricingUpdatedAt: null, projects: [], tasks: [task('root', 1000, 300), { ...task('child', 100, 6.06), relation: 'subagent', parentId: 'root' }], warnings: ['scan_limit'] };
  return { data, source };
}
function verify(result: ReturnType<typeof unifiedUsage>, period: UsagePeriod) {
  const models = aggregateGroupUsage(result.data, 'demo', period, now);
  const tasks = aggregateSyncedTaskUsage(result.projects, result.data, 'demo', period, now);
  expect(tasks.attributed.totalTokens).toBe(models.totalTokens);
  expect(tasks.attributed.estimatedCostUsd).toBe(models.estimatedCostUsd);
  const known = tasks.rows.reduce((sum, row) => sum + (row.knownCostUsd ?? 0), 0);
  expect(known).toBeCloseTo(models.knownCostUsd ?? 0, 8);
  expect(models.models.reduce((sum, model) => sum + (model.estimatedCostUsd ?? 0), 0)).toBeCloseTo(known, 8);
  return { models, tasks };
}
describe('one ledger for model and task pivots', () => {
  it('uses the same scan prefix despite a newer and larger legacy model ledger', () => {
    const { data, source } = fixture(); data.devices[0].updatedAt = '2026-10-28T00:00:00Z';
    const before = JSON.stringify(data);
    const result = unifiedUsage(data, source);
    expect(verify(result, 'today').models.estimatedCostUsd).toBe(306.06);
    expect(verify(result, 'today').tasks.rows).toHaveLength(1);
    for (const period of ['7d', '30d', 'week', 'month', 'all'] as const) verify(result, period);
    const range = { start: '2026-10-26', end: '2026-10-26', scale: 'day' as const };
    verify({ data: usageInRange(result.data, range), projects: tasksInRange(result.projects, range) }, 'all');
    expect(JSON.stringify(data)).toBe(before);
  });
  it('selects newest peer tasks, ignores local echoes and deduplicates task IDs', () => {
    const { data, source } = fixture(); data.groups[0].deviceIds.push('peer');
    source.tasks!.push(source.tasks![0]);
    source.peerTasks = [
      { deviceId: 'peer', updatedAt: '2026-10-27T00:00:00Z', partial: false, tasks: [task('root', 20, 2)] },
      { deviceId: 'peer', updatedAt: now.toISOString(), partial: true, tasks: [task('root', 30, 3)] },
      { deviceId: source.deviceId!, updatedAt: now.toISOString(), partial: false, tasks: [task('echo', 100000, 999)] },
    ];
    expect(verify(unifiedUsage(data, source), 'today').models.estimatedCostUsd).toBeCloseTo(309.06);
  });
  it('preserves public peer availability and replaces an undated placeholder', () => {
    const { data, source } = fixture();
    const id = data.devices[0].id;
    source.deviceId = 'other-local';
    source.tasks = [];
    source.peerTasks = [{ deviceId: id, updatedAt: null, partial: true, taskDetailsStatus: 'not-received', tasks: [] }];
    const missing = unifiedUsage(data, source);
    expect(missing.data.devices.find(device => device.id === id)?.daily['2026-10-27'].totalTokens).toBe(193000000);
    expect(missing.projects.peerTasks?.find(peer => peer.deviceId === id)?.taskDetailsStatus).toBe('not-received');
    verify(missing, 'today');
    source.peerTasks.push({ deviceId: id, updatedAt: now.toISOString(), partial: false, taskDetailsStatus: 'available', tasks: [task('shared', 30, 3)] });
    const ready = unifiedUsage(data, source);
    expect(ready.data.devices.find(device => device.id === id)?.daily['2026-10-27'].totalTokens).toBe(30);
    expect(ready.projects.peerTasks?.find(peer => peer.deviceId === id)?.taskDetailsStatus).toBe('available');
    verify(ready, 'today');
  });
  it('retains known contributions when the same model has unpriced records', () => {
    const { data, source } = fixture(); source.tasks!.push(task('unpriced', 40, null));
    const { models } = verify(unifiedUsage(data, source), 'today');
    expect(models.estimatedCostUsd).toBeNull();
    expect(models.models[0].costIncomplete).toBe(true);
    expect(models.knownCostUsd).toBeCloseTo(306.06);
  });
  it('exposes summary-only devices as unattributed, including loading and unavailable scans', () => {
    const { data, source } = fixture();
    for (const scan of [null, { ...source, status: 'unavailable' as const }]) {
      const { tasks } = verify(unifiedUsage(data, scan), 'today');
      expect(tasks.rows[0].name).toContain('未归属');
    }
    data.devices[0].daily['2026-10-27'].models = [];
    verify(unifiedUsage(data, null), 'today');
  });
});
