// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UsageSyncPanel } from "./UsageSyncPanel";
import { getUsageSyncStatus, saveUsageSyncSettings, syncUsageNow, type UsageSyncStatus } from "../lib/usageSyncBridge";
import { getPreferences } from "../lib/bridge";
import { savePersonPlan, planDateKey } from "../lib/personPlanSync";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
vi.mock("../lib/bridge", () => ({ getPreferences: vi.fn() }));
vi.mock("../lib/personPlanSync", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/personPlanSync")>(), savePersonPlan: vi.fn(async () => undefined),
}));
vi.mock("../lib/usageSyncBridge", () => ({ getUsageSyncStatus: vi.fn(), saveUsageSyncSettings: vi.fn(), syncUsageNow: vi.fn() }));
const initial: UsageSyncStatus = { settings: { enabled: false, intervalSeconds: 300, deviceId: "Mac", remote: "git@gitee.com:example/usage.git", branch: "main" }, imported: true, phase: "idle", lastAttemptAt: null, lastSuccessAt: null, lastCollectedAt: null, lastError: null, lastCommit: null, collectorStatus: null };
beforeEach(() => {
  vi.mocked(savePersonPlan).mockClear();
  vi.mocked(getPreferences).mockReset().mockResolvedValue({ ...DEFAULT_WIDGET_PREFERENCES, dailyBudgetLocalDate: planDateKey(new Date()), dailyBudgetPercent: 23, resetRiskManualEnabled: false, resetRiskOverridePercent: 70 });
  vi.mocked(getUsageSyncStatus).mockReset().mockResolvedValue(initial);
  vi.mocked(saveUsageSyncSettings).mockReset().mockImplementation(async settings => ({ ...initial, settings, imported: false }));
  vi.mocked(syncUsageNow).mockReset().mockResolvedValue({ ...initial, imported: false, lastSuccessAt: "2026-09-10T07:00:00Z" });
});
afterEach(cleanup);
it("shares the current planning day without activating a dormant legacy risk", async () => {
  render(<UsageSyncPanel zh devices={[]} onSynced={vi.fn()} />);
  fireEvent.click(await screen.findByText("共享本机当前计划"));
  await waitFor(() => expect(syncUsageNow).toHaveBeenCalledOnce());
  expect(savePersonPlan).toHaveBeenNthCalledWith(1, planDateKey(new Date()), "dailyBudgetPercent", 23);
  expect(savePersonPlan).toHaveBeenNthCalledWith(2, planDateKey(new Date()), "resetRiskOverridePercent", null);
});
it("never imports or starts synchronization merely by opening the panel", async () => {
  render(<UsageSyncPanel zh devices={[]} onSynced={vi.fn()} />);
  await screen.findByText(/已发现现有配置/);
  expect(saveUsageSyncSettings).not.toHaveBeenCalled();
  expect(syncUsageNow).not.toHaveBeenCalled();
});
it("imports existing settings before manual sync and refreshes data", async () => {
  const refreshed = vi.fn();
  render(<UsageSyncPanel zh devices={[]} onSynced={refreshed} />);
  fireEvent.click(await screen.findByText("立即同步"));
  await waitFor(() => expect(syncUsageNow).toHaveBeenCalledOnce());
  expect(saveUsageSyncSettings).toHaveBeenCalledWith(initial.settings);
  await waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
});
it("can opt in to automatic synchronization independently of a manual run", async () => {
  render(<UsageSyncPanel zh devices={[]} onSynced={vi.fn()} />);
  fireEvent.click(await screen.findByLabelText("自动同步"));
  await waitFor(() => expect(saveUsageSyncSettings).toHaveBeenCalledWith({ ...initial.settings, enabled: true }));
  expect(syncUsageNow).not.toHaveBeenCalled();
});
it("shows a bounded safe error rather than backend stderr", async () => {
  vi.mocked(syncUsageNow).mockRejectedValue("git_auth_failed secret-token-should-not-render");
  render(<UsageSyncPanel zh devices={[]} onSynced={vi.fn()} />);
  fireEvent.click(await screen.findByText("立即同步"));
  expect(await screen.findByRole("status")).toHaveTextContent("检查网络及本机 Git / SSH");
  expect(screen.queryByText(/secret-token/)).not.toBeInTheDocument();
});
