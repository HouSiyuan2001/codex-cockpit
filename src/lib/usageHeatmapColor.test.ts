import { expect, it } from "vitest";
import { calendarHeatmapColor, calendarHeatmapGradient, calendarHeatmapTextColor, usageHeatmapColor, usageHeatmapTextColor } from "./usageHeatmapColor";

it("matches the established heatmap's cool-to-warm colorbar", () => {
  expect(usageHeatmapColor(0, 0, 10)).toBe("rgb(48, 91, 132)");
  expect(usageHeatmapColor(5, 0, 10)).toBe("rgb(150, 207, 211)");
  expect(usageHeatmapColor(10, 0, 10)).toBe("rgb(230, 88, 81)");
  expect(usageHeatmapColor(0, 0, 0)).toBe("rgb(48, 91, 132)");
  expect(usageHeatmapTextColor(0, 0, 10)).toBe("#ffffff");
  expect(usageHeatmapTextColor(5, 0, 10)).toBe("#24324d");
});

it("uses compact-calendar blues without changing the reset-risk colorbar", () => {
  expect(calendarHeatmapColor(0, 0, 10)).toBe("rgb(78, 102, 126)");
  expect(calendarHeatmapColor(2.5, 0, 10)).toBe("rgb(166, 198, 221)");
  expect(calendarHeatmapColor(5, 0, 10)).toBe("rgb(115, 157, 189)");
  expect(calendarHeatmapColor(10, 0, 10)).toBe("rgb(39, 80, 119)");
  expect(calendarHeatmapTextColor(2.5, 0, 10)).toBe("#24324d");
  expect(calendarHeatmapTextColor(10, 0, 10)).toBe("#ffffff");
  expect(usageHeatmapColor(10, 0, 10)).toBe("rgb(230, 88, 81)");
});

it("uses the Claude orange scale for heatmap cells and their legend", () => {
  const low = calendarHeatmapColor(0.01, 0, 10, "claude");
  const high = calendarHeatmapColor(10, 0, 10, "claude");
  expect(low).toBe("rgb(255, 231, 207)");
  expect(high).toBe("rgb(161, 70, 31)");
  expect(calendarHeatmapGradient("claude")).toContain(`${low} 0%`);
  expect(calendarHeatmapGradient("claude")).toContain(`${high} 100%`);
  expect(calendarHeatmapTextColor(5, 0, 10, "claude")).toBe("#1a0a02");
  expect(calendarHeatmapTextColor(10, 0, 10, "claude")).toBe("#ffffff");
});
