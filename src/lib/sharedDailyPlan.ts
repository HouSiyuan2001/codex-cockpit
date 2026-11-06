export interface SharedPlanBasis { localDate: string; anchorAt: string; remainingPercent: number; resetsAt: string }
export interface PlanField { value: number | null; revision: number }
export interface SharedDailyPlan { basis: SharedPlanBasis; people: Record<string, PlanField>; risk: PlanField }
export function sharedRecommendation(basis: SharedPlanBasis, riskPercent: number): number {
  const day = 86400000, anchor = Date.parse(basis.anchorAt);
  const end = Date.parse(`${basis.localDate}T00:00:00+08:00`) + day;
  const days = (Date.parse(basis.resetsAt) - anchor) / day;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const remaining = Math.max(0, Math.min(100, basis.remainingPercent));
  const today = Math.min(days, Math.max(0, Math.min(1, (end - anchor) / day)));
  if (today === 0) return 0;

  // Each future hour gets less weight as the chance of retaining this quota falls.
  const risk = Math.max(0, Math.min(100, riskPercent)) / 100;
  const logSurvival = Math.log1p(-risk);
  const share = risk === 0 ? today / days
    : Math.expm1(logSurvival * today) / Math.expm1(logSurvival * days);
  return Math.round(remaining * share * 10) / 10;
}
export function allocateSharedPlan(total: number, people: readonly string[], overrides: SharedDailyPlan["people"]) {
  const ids = [...new Set(people)];
  const share = ids.length ? total / ids.length : 0;
  const allocations = Object.fromEntries(ids.map(id => [id, overrides[id]?.value ?? share]));
  return { allocations, total: Object.values(allocations).reduce((a,b)=>a+b,0) };
}
