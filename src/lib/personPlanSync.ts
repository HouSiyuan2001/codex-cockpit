import { isTauri } from "./bridge";
import type { WidgetPreferences } from "../types";

export type PersonPlan = Partial<Pick<WidgetPreferences, "dailyBudgetPercent" | "resetRiskOverridePercent">>;
/** Planning follows Beijing midnight; the usage ledger retains its historical 04:00 day. */
export function planDateKey(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}
export function planPreferences(current: WidgetPreferences, plan: PersonPlan, day: string): WidgetPreferences | null {
  const next = { ...current };
  if (typeof plan.dailyBudgetPercent === "number" && Number.isFinite(plan.dailyBudgetPercent) && plan.dailyBudgetPercent >= 1 && plan.dailyBudgetPercent <= 100) {
    next.dailyBudgetPercent = plan.dailyBudgetPercent; next.dailyBudgetLocalDate = day;
  }
  if (Object.hasOwn(plan, "resetRiskOverridePercent") && (plan.resetRiskOverridePercent === null || (typeof plan.resetRiskOverridePercent === "number" && Number.isFinite(plan.resetRiskOverridePercent) && plan.resetRiskOverridePercent >= 0 && plan.resetRiskOverridePercent <= 100))) {
    next.resetRiskOverridePercent = plan.resetRiskOverridePercent;
    next.resetRiskManualEnabled = plan.resetRiskOverridePercent !== null;
  }
  return next.dailyBudgetPercent !== current.dailyBudgetPercent || next.dailyBudgetLocalDate !== current.dailyBudgetLocalDate || next.resetRiskOverridePercent !== current.resetRiskOverridePercent || next.resetRiskManualEnabled !== current.resetRiskManualEnabled ? next : null;
}
export async function getPersonPlan(localDate: string): Promise<PersonPlan> {
  if (!isTauri()) return {};
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("get_person_plan", { localDate });
}
export async function savePersonPlan(localDate: string, field: keyof PersonPlan, value: number | null): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_person_plan", { localDate, field, value });
}
