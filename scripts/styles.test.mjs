import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

describe("control-center surface isolation", () => {
  it("lets the control center replace the cockpit instead of revealing a second shell", () => {
    expect(stylesheet).toMatch(
      /\.codex-focus-card\.quota-card--overlay-open \.control-center--minimal\s*{[^}]*inset:\s*0;[^}]*border-radius:\s*inherit;/s,
    );
    expect(stylesheet).toMatch(
      /\.codex-focus-card\.quota-card--overlay-open\s*{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s,
    );
    expect(stylesheet).toMatch(
      /\.codex-focus-card\.quota-card--overlay-open::before,[\s\S]*> \.codex-focus-content\s*{[^}]*visibility:\s*hidden;[^}]*opacity:\s*0;/s,
    );
  });
});
