import { describe, expect, it } from "vitest";
import { CODEX_RESETS_URL, RESET_RISK_DASHBOARD_URL } from "./externalLinks";

describe("external links", () => {
  it("keeps Codex Resets and the reset-risk dashboard as distinct destinations", () => {
    expect(CODEX_RESETS_URL).toBe("https://codex-resets.com/");
    expect(RESET_RISK_DASHBOARD_URL).toBe("https://codex-reset-risk-dashboard.xr08255920.workers.dev/");
    expect(CODEX_RESETS_URL).not.toBe(RESET_RISK_DASHBOARD_URL);
  });
});
