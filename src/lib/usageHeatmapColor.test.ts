import { expect, it } from "vitest";
import { calendarHeatmapColor, calendarHeatmapTextColor, usageHeatmapColor, usageHeatmapTextColor } from "./usageHeatmapColor";

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
