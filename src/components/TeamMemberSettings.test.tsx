// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_WIDGET_PREFERENCES } from "../lib/preferences";
import type { TokeiUsage } from "../lib/tokeiUsage";
import { TeamMemberSettings } from "./TeamMemberSettings";

const api = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), usage: vi.fn() }));
vi.mock("../lib/bridge", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke }));
vi.mock("../lib/tokeiBridge", () => ({ saveTokeiGroups: api.save, getTokeiUsage: api.usage }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("lets a joined device change assignments and shows a clear sync action", async () => {
  const usage: TokeiUsage = {
    fetchedAt: new Date().toISOString(), status: "ready", warnings: [], projectBreakdownAvailable: false,
    defaultGroupId: "alex", groups: [
      { id: "alex", name: "成员甲", deviceIds: ["mac"] },
      { id: "blair", name: "成员乙", deviceIds: ["windows"] },
    ], devices: [],
  };
  api.invoke.mockResolvedValue({ config: { role: "member" }, members: [{ deviceId: "mac" }, { deviceId: "windows" }] });
  api.save.mockImplementation(async (next) => next);
  render(<TeamMemberSettings usage={usage} loadingError={false} preferences={DEFAULT_WIDGET_PREFERENCES} zh onPreferences={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并同步" })).toBeEnabled());
  expect(screen.queryByText("默认打开的组员")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "设备归属: windows" }), { target: { value: "alex" } });
  fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ groups: [
    { id: "alex", name: "成员甲", deviceIds: ["mac", "windows"] },
    { id: "blair", name: "成员乙", deviceIds: [] },
  ] }), expect.objectContaining({ defaultGroupId: "alex" })));
});

it("explains a concurrent edit and reloads the newer assignments", async () => {
  const usage: TokeiUsage = {
    fetchedAt: new Date().toISOString(), status: "ready", warnings: [], projectBreakdownAvailable: false,
    defaultGroupId: "alex", groups: [
      { id: "alex", name: "成员甲", deviceIds: ["mac"] },
      { id: "blair", name: "成员乙", deviceIds: ["windows"] },
    ], devices: [],
  };
  api.invoke.mockResolvedValue({ config: { role: "member" }, members: [] });
  api.save.mockRejectedValue("cloud_groups_conflict_reload");
  api.usage.mockResolvedValue({ ...usage, groups: [
    { id: "alex", name: "成员甲", deviceIds: ["mac", "windows"] },
    { id: "blair", name: "成员乙", deviceIds: [] },
  ] });
  render(<TeamMemberSettings usage={usage} loadingError={false} preferences={DEFAULT_WIDGET_PREFERENCES} zh onPreferences={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "保存并同步" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存并同步" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("另一台设备刚修改了分配");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "设备归属: windows" })).toHaveValue("alex"));
});
