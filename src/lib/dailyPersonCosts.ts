import { aggregateGlobalUsage, type TokeiUsage } from "./tokeiUsage";

export interface PersonCostShare {
  id: string;
  name: string;
  cost: number;
  share: number;
  color: string;
  unassigned: boolean;
}
export interface DailyPersonCosts { people: PersonCostShare[]; partial: boolean }
const PERSON_COLORS = ["#9981eb", "#54aeb6", "#e6984e", "#648cca", "#d37898", "#89a54e"];

/** Identity-based color: refreshing, ranking and renaming cannot swap colors. */
export function personCostColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return PERSON_COLORS[hash % PERSON_COLORS.length];
}

export function groupColors(ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  // Resolve collisions over ALL configured identities, not just today's active
  // people. Zero usage, refreshing, renaming and sorting cannot swap colors.
  for (const id of [...new Set(ids)].sort()) {
    const preferred = personCostColor(id);
    const start = PERSON_COLORS.indexOf(preferred);
    const choices = [...PERSON_COLORS.slice(start), ...PERSON_COLORS.slice(0, start)];
    const color = choices.find(candidate => !used.has(candidate)) ?? preferred;
    used.add(color);
    result.set(id, color);
  }
  return result;
}

/** Only known money participates; token counts never substitute for missing prices.
 * Existing global aggregation deduplicates devices and includes unassigned devices.
 * Calendar-day costs describe a share, not an official per-user quota measurement.
 */
export function buildDailyPersonCosts(data: TokeiUsage | null, now = new Date(), overrides: Record<string, string> = {}): DailyPersonCosts {
  if (!data) return { people: [], partial: true };
  const summary = aggregateGlobalUsage(data, "today", now);
  const known = summary.users.filter(user => Number.isFinite(user.estimatedCostUsd) && (user.estimatedCostUsd ?? 0) > 0);
  const total = known.reduce((sum, user) => sum + user.estimatedCostUsd!, 0);
  const colors = groupColors(data.groups.map(group => group.id));
  for (const [id, color] of Object.entries(overrides)) {
    if (/^#[0-9a-f]{6}$/i.test(color)) colors.set(id, color);
  }
  return {
    partial: data.status !== "ready" || summary.estimatedCostUsd === null || summary.devices.some(device => device.stale || device.collectionPartial),
    people: total > 0 ? known.map(user => {
      const unassigned = !data.groups.some(group => group.id === user.id);
      return { id: user.id, name: user.name, cost: user.estimatedCostUsd!, share: user.estimatedCostUsd! / total, color: unassigned ? "#929baa" : colors.get(user.id)!, unassigned };
    }).sort((a, b) => a.id.localeCompare(b.id)) : [],
  };
}
