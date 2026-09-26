import { describe, expect, it } from "vitest";
import { allocateSharedPlan, sharedRecommendation } from "./sharedDailyPlan";
import { quotaHeatmapUsage } from "../components/ResetRiskQuotaHeatmap";

describe("shared account planning", () => {
  it("splits the recommendation equally without reallocating another person's share", () => {
    expect(allocateSharedPlan(20,["alex","blair"],{}).allocations).toEqual({alex:10,blair:10});
    expect(allocateSharedPlan(20,["alex","blair"],{alex:{value:12,revision:1}})).toEqual({allocations:{alex:12,blair:10},total:22});
    expect(allocateSharedPlan(20,["alex","blair"],{alex:{value:null,revision:2}}).total).toBe(20);
    expect(allocateSharedPlan(20,["alex","blair"],{alex:{value:0,revision:3}}).allocations.blair).toBe(10);
  });
  it("uses the account balance, reset horizon and risk, not a person's comfort knee", () => {
    const basis={localDate:"2026-09-15",anchorAt:"2026-09-14T16:00:00.000Z",resetsAt:"2026-09-18T16:00:00.000Z",remainingPercent:80};
    expect(sharedRecommendation(basis,0)).toBe(20);
    expect(sharedRecommendation(basis,50)).toBe(35);
    expect(sharedRecommendation(basis,100)).toBe(80);
    expect(quotaHeatmapUsage({sharedAccount:true,remainingPercent:80,daysUntilReset:4,tomorrowRiskPercent:50,fatigueKneePercent:1,isWeekend:true})).toBe(35);
  });
  it("accounts for a partial first day and an expired cycle", () => {
    const basis={localDate:"2026-09-15",anchorAt:"2026-09-15T04:00:00.000Z",resetsAt:"2026-09-19T04:00:00.000Z",remainingPercent:80};
    expect(sharedRecommendation(basis,0)).toBe(10);
    expect(sharedRecommendation({...basis,resetsAt:basis.anchorAt},50)).toBe(0);
  });
});
