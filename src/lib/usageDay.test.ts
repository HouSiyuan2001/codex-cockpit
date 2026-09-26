import { describe, expect, it } from "vitest";
import { endOfUsageDay, usageDateKey } from "./usageDay";

describe("Beijing usage day", () => {
  it("rolls over at 04:00 Asia/Shanghai regardless of the machine timezone", () => {
    expect(usageDateKey(new Date("2026-08-13T19:59:59.000Z"))).toBe("2026-08-13");
    expect(usageDateKey(new Date("2026-08-13T20:00:00.000Z"))).toBe("2026-08-14");
  });

  it("ends the usage day at the next Beijing 04:00", () => {
    expect(endOfUsageDay(new Date("2026-08-13T20:00:00.000Z"))).toBe(new Date("2026-08-14T20:00:00.000Z").getTime());
  });
});
