import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const css = readFileSync(new URL("../src/components/DailyUsageTrend.theme.css", import.meta.url), "utf8");
function luminance(hex) {
  const linear = hex.match(/[0-9a-f]{2}/gi).map(part => { const c = parseInt(part, 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
describe("daily trend tooltip theme contrast", () => {
  for (const [theme, selector] of [["dark", ".daily-usage-trend"], ["light", ".quota-card--theme-light .daily-usage-trend"]]) {
    it(`${theme} keeps text readable against its own opaque background`, () => {
      const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
      const color = name => block.match(new RegExp(`--trend-${name}: (#[0-9a-f]{6});`))[1];
      expect(contrast(color("tooltip-ink"), color("tooltip-bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color("tooltip-muted"), color("tooltip-bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color("line"), color("tooltip-bg"))).toBeGreaterThanOrEqual(3);
      expect(contrast(color("partial"), color("tooltip-bg"))).toBeGreaterThanOrEqual(3);
    });
  }
  it("uses paired theme colors for both tooltip text and background", () => {
    expect(css).toContain("fill: var(--trend-tooltip-bg)");
    expect(css).toContain("fill: var(--trend-tooltip-muted) !important");
    expect(css).toContain("fill: var(--trend-tooltip-ink) !important");
    expect(css).not.toContain("fill: var(--glass-");
  });
});
