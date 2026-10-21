// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalUsageSourceSettings } from "./LocalUsageSourceSettings";
const api = vi.hoisted(() => ({ get: vi.fn(), choose: vi.fn(), save: vi.fn() }));
vi.mock("../lib/bridge", () => ({ isTauri: () => true }));
vi.mock("../lib/localUsageBridge", async original => ({ ...await original<typeof import("../lib/localUsageBridge")>(), getLocalUsageSource: api.get, chooseCodexDirectory: api.choose, saveLocalUsageSource: api.save }));
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ deviceId: "local-test", directory: "/synthetic/.codex", selection: "automatic", state: "missing" });
  api.choose.mockReset().mockResolvedValue("/synthetic/custom-codex");
  api.save.mockReset().mockResolvedValue({ deviceId: "local-test", directory: "/synthetic/custom-codex", selection: "manual", state: "ready" });
});
afterEach(cleanup);
it("keeps healthy local data concise and details collapsed", async () => {
  api.get.mockResolvedValue({ directory: "/synthetic/.codex", selection: "manual", state: "ready" });
  render(<LocalUsageSourceSettings zh />);
  expect(await screen.findByText("/synthetic/.codex")).toBeVisible();
  expect(screen.getByText("只读统计，不上传聊天正文。")).toBeVisible();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  const details = screen.getByText("读取详情").closest("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(screen.getByText("恢复自动查找")).not.toBeVisible();
  details.open = true;
  expect(screen.getByText("恢复自动查找")).toBeVisible();
});
it("explains missing data without reporting zero or requesting cloud enrollment", async () => {
  render(<LocalUsageSourceSettings zh compact />);
  expect(await screen.findByText(/没有找到 Codex 数据目录，这不是用量为 0/)).toBeInTheDocument();
  expect(api.save).not.toHaveBeenCalled();
  expect(screen.getByText(/选择目录不会开启云同步/)).toBeInTheDocument();
});
it("does not save or start reading until the user explicitly confirms", async () => {
  const onSaved = vi.fn();
  render(<LocalUsageSourceSettings zh onSaved={onSaved} />);
  await screen.findByText("/synthetic/.codex");
  fireEvent.click(screen.getByRole("button", { name: "更改目录" }));
  await screen.findByRole("button", { name: "允许读取并开始统计" });
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "允许读取并开始统计" }));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith("/synthetic/custom-codex"));
  expect(onSaved).toHaveBeenCalledTimes(1);
});
it("canceling the confirmation does not change the source", async () => {
  render(<LocalUsageSourceSettings zh />);
  fireEvent.click(screen.getByRole("button", { name: "更改目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "取消" }));
  expect(api.save).not.toHaveBeenCalled();
});
it("shows an empty readable folder separately from a missing folder", async () => {
  api.get.mockResolvedValue({ deviceId: "test", directory: "/synthetic/.codex", selection: "automatic", state: "ready" });
  render(<LocalUsageSourceSettings zh noRecords />);
  expect(await screen.findByText(/目录可读取，但还没有可统计的用量记录/)).toBeInTheDocument();
});
it("uses a safe actionable error instead of exposing native details", async () => {
  api.save.mockRejectedValue("permission denied private token example");
  render(<LocalUsageSourceSettings zh />);
  fireEvent.click(screen.getByRole("button", { name: "更改目录" }));
  fireEvent.click(await screen.findByRole("button", { name: "允许读取并开始统计" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请检查系统权限");
  expect(screen.queryByText(/private token/)).not.toBeInTheDocument();
});
