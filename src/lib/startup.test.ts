import { describe, expect, it } from "vitest";
import { EMPTY_RUNTIME_STATE } from "./activity";
import { DEFAULT_WIDGET_PREFERENCES } from "./preferences";
import { loadStartupState } from "./startup";

describe("startup state isolation", () => {
  it("preserves core saved state when optional checks fail", async () => {
    const result = await loadStartupState({
      getPreferences: async () => ({ ...DEFAULT_WIDGET_PREFERENCES, alertThreshold: 9 }),
      getRuntimeState: async () => ({ ...EMPTY_RUNTIME_STATE, lastNotifications: { test: "2026-07-19T00:00:00Z" } }),
      getDiagnostics: async () => { throw new Error("diagnostics unavailable"); },
      getAutostartEnabled: async () => { throw new Error("registry unavailable"); },
    });
    expect(result.preferences?.alertThreshold).toBe(9);
    expect(result.runtimeState?.lastNotifications.test).toBe("2026-07-19T00:00:00Z");
    expect(result.diagnostics).toBeNull();
    expect(result.autostartEnabled).toBeNull();
    expect(result.failures).toEqual(["diagnostics", "autostart"]);
  });

  it("returns every fulfilled startup value without warnings", async () => {
    const diagnostics = { appVersion: "0.2.0", platform: "windows", configDirectory: "config", preferencesBackupAvailable: true, runtimeBackupAvailable: true };
    const result = await loadStartupState({
      getPreferences: async () => DEFAULT_WIDGET_PREFERENCES,
      getRuntimeState: async () => EMPTY_RUNTIME_STATE,
      getDiagnostics: async () => diagnostics,
      getAutostartEnabled: async () => true,
    });
    expect(result).toMatchObject({ diagnostics, autostartEnabled: true, failures: [] });
  });
});
