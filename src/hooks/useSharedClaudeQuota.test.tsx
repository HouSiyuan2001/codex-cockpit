// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { fetchSharedClaudeQuota } from "../lib/bridge";
import { useSharedClaudeQuota } from "./useClaudeUsage";

vi.mock("../lib/bridge", () => ({ fetchSharedClaudeQuota: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("automatically reads the newest snapshot once the local quota is unavailable", async () => {
  const mac = { deviceId: "mac", deviceName: "Work Mac", quota: { observedAt: "2026-11-26T06:00:00Z", fiveHour: { usedPercent: 28, resetsAt: null }, sevenDay: { usedPercent: 42, resetsAt: null } } };
  const pc = { deviceId: "pc", deviceName: "Windows", quota: { observedAt: "2026-11-25T12:00:00Z", fiveHour: null, sevenDay: { usedPercent: 31, resetsAt: null } } };
  vi.mocked(fetchSharedClaudeQuota).mockResolvedValueOnce([pc, mac]);

  const { result, rerender } = renderHook(({ enabled }) => useSharedClaudeQuota(enabled), { initialProps: { enabled: false } });
  expect(fetchSharedClaudeQuota).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.snapshot).toEqual(mac));
  expect(fetchSharedClaudeQuota).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  expect(result.current.snapshot).toBeNull();
});

it("shows an unavailable source when the sync space has been disconnected", async () => {
  vi.mocked(fetchSharedClaudeQuota).mockRejectedValueOnce("cloud_not_connected");
  const { result } = renderHook(() => useSharedClaudeQuota(true));
  await waitFor(() => expect(result.current.status).toBe("disconnected"));
  expect(result.current.snapshot).toBeNull();
});
