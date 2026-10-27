import { describe, expect, it } from "vitest";
import { endOfUsageDay, usageDateKey, localDateKey } from "./usageDay";

describe("Beijing usage day", () => {
  it("rolls over at 04:00 Asia/Shanghai regardless of the machine timezone", () => {
    expect(usageDateKey(new Date("2026-08-13T19:59:59.000Z"))).toBe("2026-08-13");
    expect(usageDateKey(new Date("2026-08-13T20:00:00.000Z"))).toBe("2026-08-14");
  });

  it("ends the usage day at the next Beijing 04:00", () => {
    expect(endOfUsageDay(new Date("2026-08-13T20:00:00.000Z"))).toBe(new Date("2026-08-14T20:00:00.000Z").getTime());
  });
});

it("keeps calendar midnight distinct from the quota 04:00 boundary", () => {
  const before = new Date("2026-12-31T07:59:59-08:00");
  const midnight = new Date("2026-12-31T08:00:00-08:00");
  const four = new Date("2026-12-31T12:00:00-08:00");
  expect(localDateKey(before)).toBe("2026-12-31");
  expect(localDateKey(midnight)).toBe("2027-01-01");
  expect(usageDateKey(midnight)).toBe("2026-12-31");
  expect(usageDateKey(four)).toBe("2027-01-01");
});

it("maps both US daylight-saving folds into China dates without a duplicate day", () => {
  for (const timestamp of ["2026-11-01T01:30:00-07:00", "2026-11-01T01:30:00-08:00"]) {
    expect(localDateKey(new Date(timestamp))).toBe("2026-11-01");
    expect(usageDateKey(new Date(timestamp))).toBe("2026-11-01");
  }
});
