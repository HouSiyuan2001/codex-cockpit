// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateGroupUsage, createUsagePreview } from "../lib/tokeiUsage";
import { getProjectUsage, getTokeiUsage, saveTokeiGroups } from "../lib/tokeiBridge";
import { CodexUsagePanel } from "./CodexUsagePanel";

vi.mock("../lib/tokeiBridge", () => ({ getProjectUsage: vi.fn(), getTokeiUsage: vi.fn(), saveTokeiGroups: vi.fn() }));

beforeEach(() => {
  vi.mocked(getTokeiUsage).mockReset().mockResolvedValue(createUsagePreview());
  vi.mocked(saveTokeiGroups).mockReset().mockImplementation(async (settings) => settings);
  const preview = createUsagePreview();
  const date = Object.keys(preview.devices[0].daily)[0];
  const taskDay = (id: string, name: string, inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningTokens: number, estimatedCostUsd: number) => {
    const totalTokens = inputTokens + cachedInputTokens + outputTokens;
    return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens, estimatedCostUsd, models: [{ id, name, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens, estimatedCostUsd }] };
  };
  vi.mocked(getProjectUsage).mockReset().mockResolvedValue({
    deviceId: "Demo Mac", updatedAt: preview.fetchedAt, status: "partial", coverage: "local", scannedFiles: 3, pricingSource: "local-catalog", pricingUpdatedAt: null, taskMetadataCoverage: "complete", warnings: [],
    projects: [{ id: "p", name: "Local project", daily: preview.devices[0].daily }],
    tasks: [
      { id: "task-root-11111111", name: "Local task", projectName: "P020", relation: "root", daily: { [date]: taskDay("demo-a", "Model A", 165_000, 975_000, 60_000, 18_750, 1.8) } },
      { id: "task-child-22222222", name: "Usage worker", projectName: "P020", parentId: "task-root-11111111", rootId: "task-root-11111111", relation: "subagent", agentNickname: "Agent A", agentRole: "worker", daily: { [date]: taskDay("demo-a", "Model A", 55_000, 325_000, 20_000, 6_250, 0.6) } },
      { id: "task-fork-33333333", name: "Normal fork", projectName: "P020", parentId: "task-root-11111111", rootId: "task-root-11111111", relation: "fork", daily: { [date]: taskDay("demo-b", "Model B", 80_000, 290_000, 30_000, 9_000, 0.3) } },
    ],
  });
});
afterEach(cleanup);

describe("quiet Codex usage view", () => {
  it.each([true, false])("explains aggregate-only peers without reporting zero tasks, zh=%s", async zh => {
    const data = createUsagePreview();
    const source = await getProjectUsage();
    data.groups[0].deviceIds.push("Peer Mac");
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{ deviceId: "Peer Mac", updatedAt: source.updatedAt, partial: true, taskDetailsStatus: "not-provided", tasks: [] }] });
    render(<CodexUsagePanel zh={zh} />);
    const notice = await screen.findByRole("region", { name: zh ? "跨设备任务状态" : "Peer task status" });
    expect(notice.closest(".usage-ranking")).not.toBeNull();
    const toggle = within(notice).getByRole("button", { name: zh ? "展开跨设备任务提示" : "Show peer task tips" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(notice).getByText("Peer Mac")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(notice).getByText("Peer Mac")).toBeVisible();
    expect(notice).toHaveTextContent(zh ? "1 台明细未就绪" : "1 awaiting details");
    expect(notice).toHaveTextContent(zh ? "对方快照未提供任务明细" : "The peer snapshot has no task details");
    expect(notice).toHaveTextContent(zh ? "不能据此认为没有用量" : "this does not mean zero usage");
    expect(notice).not.toHaveTextContent(zh ? "当前范围 0 项" : "0 in this period");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(notice).getByText("Peer Mac")).not.toBeVisible();
  });
  it("reveals synced historical peer tasks without changing the member or combining date ledgers", async () => {
    const data = createUsagePreview();
    const source = await getProjectUsage();
    data.groups[0].deviceIds.push("Peer Mac");
    const task = source.tasks![0], day = Object.values(task.daily)[0];
    const past = new Date(); past.setDate(past.getDate() - 2);
    const date = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{ deviceId: "Peer Mac", updatedAt: source.updatedAt, partial: false, taskDetailsStatus: "available", tasks: [{ ...task, name: "Historical peer task", daily: { [date]: day } }] }] });
    render(<CodexUsagePanel zh />);
    fireEvent.click(await screen.findByRole("button", { name: "展开跨设备任务提示" }));
    const showHistory = await screen.findByRole("button", { name: "查看历史任务" });
    expect(screen.queryByText("Historical peer task")).not.toBeInTheDocument();
    fireEvent.click(showHistory);
    expect(await screen.findByText("来自 Peer Mac")).toBeInTheDocument();
    expect(screen.getByText("Historical peer task")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "统计时间" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue("group:demo");
  });
  it("offers other members' tasks explicitly and keeps the task view when selecting all members", async () => {
    const data = createUsagePreview();
    const source = await getProjectUsage();
    data.groups.push({ id: "other", name: "Other member", deviceIds: ["Other PC"] });
    data.devices.push({ ...data.devices[0], id: "Other PC" });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{ deviceId: "Other PC", updatedAt: source.updatedAt, partial: false, tasks: [{ ...source.tasks![0], name: "Other member task" }] }] });
    render(<CodexUsagePanel zh />);
    fireEvent.click(await screen.findByRole("button", { name: "展开跨设备任务提示" }));
    const allMembers = await screen.findByRole("button", { name: "查看全部组员任务（另 1 台设备）" });
    expect(screen.queryByText("Other member task")).not.toBeInTheDocument();
    fireEvent.click(allMembers);
    expect(await screen.findByText("Other member task")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue("global");
    expect(screen.getByRole("combobox", { name: "查看方式" })).toHaveValue("tasks");
    expect(saveTokeiGroups).not.toHaveBeenCalled();
  });
  it("refreshes a peer from missing details to shared tasks on a subsequent native read", async () => {
    const data = createUsagePreview();
    const source = await getProjectUsage();
    data.groups[0].deviceIds.push("Peer Mac");
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{ deviceId: "Peer Mac", updatedAt: null, partial: true, taskDetailsStatus: "not-received", tasks: [] }] });
    render(<CodexUsagePanel zh />);
    await screen.findByRole("region", { name: "跨设备任务状态" });
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{ deviceId: "Peer Mac", updatedAt: source.updatedAt, partial: false, taskDetailsStatus: "available", tasks: [{ ...source.tasks![0], name: "Newly shared peer task" }] }] });
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "7d" } });
    expect(await screen.findByText("Newly shared peer task")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "跨设备任务状态" })).not.toHaveTextContent("明细未就绪");
  });
  it.each(["codex_directory_missing", "source_permission_denied", "no_usage_records"])("explains %s without discarding an existing usage cache", async (warning) => {
    const source = await getProjectUsage();
    Object.assign(source, { status: "unavailable", scannedFiles: 0, projects: [], tasks: [], warnings: [warning] });
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    const onOpenSettings = vi.fn();
    render(<CodexUsagePanel zh onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/上次缓存/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    expect(screen.getByText("Model A")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).toHaveTextContent("200万");
    fireEvent.click(screen.getByRole("button", { name: "检查 Codex 数据目录" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
  it("explains a rejected local read in English while preserving cached models", async () => {
    vi.mocked(getProjectUsage).mockRejectedValue(new Error("local_settings_corrupt"));
    const onOpenSettings = vi.fn();
    render(<CodexUsagePanel zh={false} onOpenSettings={onOpenSettings} />);
    expect(await screen.findByText(/Local records could not be refreshed; showing the last cached usage/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Usage view" }), { target: { value: "models" } });
    expect(screen.getByText("Model A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check Codex data folder" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/local_settings_corrupt/)).not.toBeInTheDocument();
  });
  it.each([true, false])("shows first-install tasks and models with local member configured=%s", async (hasMember) => {
    const data = createUsagePreview();
    const source = await getProjectUsage();
    source.deviceId = "local-synthetic-device";
    source.status = "ready";
    Object.assign(data, {
      devices: [], groups: hasMember ? [{ id: "mine", name: "我", deviceIds: [source.deviceId] }] : [],
      defaultGroupId: hasMember ? "mine" : null, localGroupId: hasMember ? "mine" : null,
      status: "unavailable", warnings: ["config_unavailable", "sync_unavailable"],
    });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue(hasMember ? "group:mine" : "global");
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    expect(screen.getByText("Model A")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).toHaveTextContent("200万");
  });
  it("explains built-in pricing without asking new users to configure cloud sync", async () => {
    const source = await getProjectUsage();
    source.pricingSource = "bundled-catalog";
    source.pricingUpdatedAt = "2026-10-12";
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    render(<CodexUsagePanel zh />);
    await screen.findByText(/^使用 App 自带的参考价格/);
    fireEvent.click(screen.getByText("统计说明"));
    expect(screen.getByText(/价格核对日期/)).toHaveTextContent("2026-10-12");
    expect(screen.getByText(/^使用 App 自带的参考价格/)).toHaveTextContent("不是订阅扣费");
  });

  it.each([
    ["missing_model_price", "部分模型没有可确认的价格"],
    ["cost_context_unavailable", "部分历史记录缺少可核对的单次用量"],
  ])("explains %s while preserving unavailable amounts and recorded tokens", async (warning, explanation) => {
    const data = createUsagePreview();
    for (const device of data.devices) {
      for (const day of Object.values(device.daily)) {
        day.estimatedCostUsd = null;
        day.models.forEach(model => { model.estimatedCostUsd = null; });
      }
    }
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    const source = await getProjectUsage();
    source.projects = [];
    source.tasks = [];
    source.warnings = [warning];
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText(new RegExp(explanation));
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    const total = container.querySelector(".usage-total");
    expect(total?.querySelector("small")).toHaveTextContent("暂无估算");
    expect(total?.querySelector("small")).toHaveTextContent("Tokens");
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).not.toHaveTextContent("$0.00");
  });

  it("does not draw a zero ring when a fresh install has no usage records", async () => {
    const empty = createUsagePreview();
    empty.devices = [];
    empty.status = "unavailable";
    vi.mocked(getTokeiUsage).mockResolvedValue(empty);
    vi.mocked(getProjectUsage).mockResolvedValue({ deviceId: "Demo Mac", updatedAt: empty.fetchedAt, status: "unavailable", coverage: "local", scannedFiles: 0, pricingSource: "none", pricingUpdatedAt: null, warnings: ["no_usage_records"], projects: [], tasks: [] });
    render(<CodexUsagePanel zh />);
    await screen.findByText(/目录可读取，但还没有可统计/);
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    expect(screen.queryByRole("img", { name: "模型用量占比" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    expect(screen.queryByText("0 Tokens")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更改目录" })).toBeInTheDocument();
  });
  it("shows the previous aggregate immediately while a fresh read is pending", () => {
    const cached = createUsagePreview();
    vi.mocked(getTokeiUsage).mockReturnValue(new Promise(() => undefined));
    render(<CodexUsagePanel zh initialUsage={cached} />);
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    const expected = aggregateGroupUsage(cached, cached.defaultGroupId, "today").estimatedCostUsd;
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).toHaveTextContent(`$${expected?.toFixed(2)}`);
  });
  it("opens this device's member rather than another device's shared default", async () => {
    const data = createUsagePreview();
    data.groups.push({ id: "other", name: "Other member", deviceIds: ["Other PC"] });
    data.defaultGroupId = "other";
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue("group:demo"));
    fireEvent.change(screen.getByRole("combobox", { name: "用量分组" }), { target: { value: "group:other" } });
    expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue("group:other");
  });
  it("shows the previous aggregate immediately while a fresh read is still pending", () => {
    const cached = createUsagePreview();
    vi.mocked(getTokeiUsage).mockReturnValue(new Promise(() => undefined));
    render(<CodexUsagePanel zh initialUsage={cached} />);
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    const expected = aggregateGroupUsage(cached, cached.defaultGroupId, "today").estimatedCostUsd;
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).toHaveTextContent(`$${expected?.toFixed(2)}`);
  });
  it("shows the same fresh local cost by task and by model when sync is older", async () => {
    const data = createUsagePreview();
    data.devices[0].updatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    const source = await getProjectUsage();
    const date = Object.keys(data.devices[0].daily)[0];
    const freshDay = structuredClone(data.devices[0].daily[date]);
    freshDay.estimatedCostUsd = 138.83;
    freshDay.models[0].estimatedCostUsd = 100;
    freshDay.models[1].estimatedCostUsd = 38.83;
    source.updatedAt = new Date().toISOString();
    source.projects = [{ id: "p", name: "Project", daily: { [date]: freshDay } }];
    source.tasks = [{ id: "task", name: "Fresh task", relation: "root", daily: { [date]: freshDay } }];
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    render(<CodexUsagePanel zh />);
    await screen.findByText("Fresh task");
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("$138.83");
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    expect(screen.getByRole("img", { name: "模型用量占比" }).parentElement).toHaveTextContent("$138.83");
  });
  it("keeps an unavailable cost as a quiet hint rather than an oversized headline", async () => {
    const data = createUsagePreview();
    const day = Object.values(data.devices[0].daily)[0];
    day.estimatedCostUsd = null;
    day.models.forEach(model => { model.estimatedCostUsd = null; });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "30d" } });
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.click(screen.getByRole("button", { name: "看成本" }));
    const total = container.querySelector(".usage-total");
    expect(total?.querySelector("strong")).toHaveTextContent("—");
    expect(total?.querySelector("small")).toHaveTextContent("暂无估算");
    expect(total?.querySelector("small")).toHaveTextContent("Tokens");
  });

  it("anchors the trend to the calendar without discarding the underlying historical ledger", async () => {
    const data = createUsagePreview();
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 12);
    const older = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 3, 12);
    const key = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    const day = Object.values(data.devices[0].daily)[0];
    data.devices[0].daily[key(older)] = day;
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    expect(container.querySelector(".usage-toolbar .usage-calendar-trigger")).toBe(screen.getByRole("button", { name: "日历" }));
    fireEvent.click(screen.getByRole("button", { name: "日历" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${key(yesterday)} ·`) }));
    expect(screen.getByRole("button", { name: "日历" })).toHaveClass("is-active");
    expect(container.querySelector(".daily-trend-navigation strong")).toHaveAttribute("title", expect.stringContaining(key(yesterday)));
    expect(container.querySelector(`.daily-trend-hit[aria-label^="${key(older)}"]`)).not.toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "today" } });
    expect(container.querySelector(".daily-trend-navigation strong")).toHaveAttribute("title", expect.stringContaining(key(today)));
  });

  it("selects task costs once including subagents and resets selections with scope changes", async () => {
    render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    const open = () => {
      fireEvent.click(screen.getByRole("button", { name: /自定义统计/ }));
      return within(screen.getByRole("region", { name: "自定义任务统计" }));
    };
    let panel = open();
    expect(panel.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(panel.getByRole("checkbox", { name: /Local task/ }));
    expect(panel.getByRole("status")).toHaveTextContent("$2.40");
    fireEvent.click(panel.getByRole("button", { name: "全选" }));
    expect(panel.getByRole("status")).toHaveTextContent("已选 2 项$2.70");
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "7d" } });
    panel = open();
    expect(panel.getByRole("status")).toHaveTextContent("已选 0 项$0.00");
    fireEvent.click(panel.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "切换为成本" }));
    panel = open();
    expect(panel.getByRole("status")).toHaveTextContent("已选 0 项");
    fireEvent.click(panel.getByRole("button", { name: "全选" }));
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    panel = open();
    expect(panel.getByRole("status")).toHaveTextContent("已选 0 项");
    expect(panel.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(panel.getByRole("button", { name: "全选" }));
    fireEvent.change(screen.getByRole("combobox", { name: "用量分组" }), { target: { value: "global" } });
    panel = open();
    expect(panel.getByRole("status")).toHaveTextContent("已选 0 项");
  });

  it("filters task totals by a calendar date and returns to rolling periods", async () => {
    const source = await getProjectUsage();
    const previous = new Date(); previous.setDate(previous.getDate() - 1);
    const date = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-${String(previous.getDate()).padStart(2, "0")}`;
    source.tasks!.push({ id: "older", name: "Yesterday calendar task", relation: "root", daily: { [date]: Object.values(source.tasks![0].daily)[0] } });
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    fireEvent.click(screen.getByRole("button", { name: "日历" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${date} ·`) }));
    expect(await screen.findByText("Yesterday calendar task")).toBeInTheDocument();
    expect(screen.queryByText("Local task")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("120万");
    fireEvent.click(screen.getByRole("button", { name: /自定义统计/ }));
    const custom = within(screen.getByRole("region", { name: "自定义任务统计" }));
    expect(custom.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(custom.getByRole("checkbox", { name: /Yesterday calendar task/ }));
    expect(custom.getByRole("status")).toHaveTextContent("$1.80");
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "today" } });
    expect(screen.queryByRole("region", { name: "自定义任务统计" })).not.toBeInTheDocument();
    expect(await screen.findByText("Local task")).toBeInTheDocument();
    expect(screen.queryByText("Yesterday calendar task")).not.toBeInTheDocument();
  });
  it("renders a peer-only group with machine provenance and the same donut total", async () => {
    const source = await getProjectUsage();
    const usage = createUsagePreview();
    usage.groups[0].deviceIds = ["Fruit-Windows"];
    vi.mocked(getTokeiUsage).mockResolvedValue(usage);
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, peerTasks: [{
      deviceId: "Fruit-Windows", updatedAt: source.updatedAt, partial: false,
      tasks: [{ ...source.tasks![0], name: "Remote task", projectName: undefined }],
    }] });
    render(<CodexUsagePanel zh />);
    expect(await screen.findByText("来自 Fruit-Windows")).toBeInTheDocument();
    expect(screen.queryByText("Local task")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("120万");
    fireEvent.click(screen.getByRole("button", { name: "切换为成本" }));
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("$1.80");
  });
  it("ranks partial known costs and includes them in the known-cost donut", async () => {
    const source = await getProjectUsage();
    const seed = source.tasks![0];
    const date = Object.keys(seed.daily)[0];
    const day = seed.daily[date];
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, tasks: [
      { ...seed, id: "partial", name: "Partial task", daily: { [date]: { ...day, estimatedCostUsd: null, models: [{ ...day.models[0], estimatedCostUsd: 8 }] } } },
      { ...seed, id: "complete", name: "Complete task", daily: { [date]: { ...day, estimatedCostUsd: 2 } } },
    ] });
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText("Partial task");
    fireEvent.click(screen.getByRole("button", { name: "切换为成本" }));
    const rows = container.querySelectorAll(".task-usage-row > summary");
    expect(rows[0]).toHaveTextContent("Partial task");
    expect(rows[0]).toHaveTextContent("$8.00");
    expect(rows[0]).toHaveTextContent("仅已知金额");
    const donut = screen.getByRole("img", { name: "任务用量占比" });
    expect(donut.parentElement).toHaveTextContent("$10.00");
    expect(donut.parentElement).toHaveTextContent("已知成本");
    expect(donut.querySelectorAll("circle[stroke-dasharray]")[0]).toHaveAttribute("stroke-dasharray", "80 20");
  });
  it("offers rolling periods instead of calendar week and month", async () => {
    render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    const select = screen.getByRole("combobox", { name: "统计时间" });
    expect([...select.querySelectorAll("option")].map(option => [option.value, option.textContent])).toEqual([
      ["today", "今日"], ["7d", "近 7 天"], ["30d", "近 30 天"], ["all", "全部时间"],
    ]);
    fireEvent.change(select, { target: { value: "30d" } });
    expect(select).toHaveValue("30d");
  });
  it("redistributes colors over visible tasks when expanding and collapsing", async () => {
    const source = await getProjectUsage();
    const seed = source.tasks![0];
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, tasks: Array.from({ length: 7 }, (_, index) => ({ ...seed, id: `task-${index}`, name: `Task ${index}` })) });
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText("Task 0");
    const keys = () => container.querySelectorAll(".usage-ranking .usage-color-key");
    const marks = () => container.querySelectorAll('svg[aria-label="任务用量占比"] circle[stroke-dasharray]');
    expect(keys()).toHaveLength(5);
    expect(keys()[4]).toHaveStyle({ background: "#1e466e" });
    expect(marks()[4]).toHaveAttribute("stroke", "#1e466e");
    fireEvent.click(screen.getByRole("button", { name: "其余 2 项" }));
    expect(keys()).toHaveLength(7);
    expect(keys()[4]).toHaveStyle({ background: "#72bcd5" });
    expect(keys()[6]).toHaveStyle({ background: "#1e466e" });
    expect(marks()[4]).toHaveAttribute("stroke", "#72bcd5");
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(keys()).toHaveLength(5);
    expect(keys()[4]).toHaveStyle({ background: "#1e466e" });
  });

  it("shares evenly distributed task colors with the donut across history refreshes", async () => {
    const { container } = render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    const layout = container.querySelector(".usage-model-today");
    expect(layout?.children).toHaveLength(2);
    expect(layout?.children[0]).toHaveClass("usage-donut");
    expect(layout?.children[1]).toHaveClass("usage-ranking");
    const assertRanks = () => {
      const marks = container.querySelectorAll('svg[aria-label="任务用量占比"] circle[stroke-dasharray]');
      expect(marks).toHaveLength(2);
      expect(marks[0]).toHaveAttribute("stroke", "#e76254");
      expect(marks[1]).toHaveAttribute("stroke", "#1e466e");
      expect(marks[0]).toHaveAttribute("stroke-dasharray", "80 20");
      expect(container.querySelectorAll(".usage-ranking .usage-color-key")[0]).toHaveStyle({ background: "#e76254" });
      expect(container.querySelectorAll(".usage-ranking .usage-color-key")[1]).toHaveStyle({ background: "#1e466e" });
    };
    assertRanks();
    const source = await getProjectUsage();
    vi.mocked(getProjectUsage).mockResolvedValue({ ...source, tasks: [...source.tasks!, { id: "aaa-new-empty-task", name: "Empty task", relation: "root", daily: {} }] });
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "7d" } });
    await waitFor(assertRanks);
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("200万");
    fireEvent.click(screen.getByRole("button", { name: "切换为成本" }));
    expect(screen.getByRole("img", { name: "任务用量占比" }).parentElement).toHaveTextContent("$2.70");
  });
  it("refreshes history and filters older tasks when the date range changes", async () => {
    const source = await getProjectUsage();
    vi.mocked(getProjectUsage).mockClear();
    const previous = new Date(); previous.setDate(previous.getDate() - 1);
    const date = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}-${String(previous.getDate()).padStart(2, "0")}`;
    source.tasks!.push({ id: "older", name: "Yesterday only", relation: "root", daily: { [date]: Object.values(source.tasks![0].daily)[0] } });
    vi.mocked(getProjectUsage).mockResolvedValue(source);
    render(<CodexUsagePanel zh />);
    await screen.findByText("Local task");
    expect(screen.queryByText("Yesterday only")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "7d" } });
    expect(await screen.findByText("Yesterday only")).toBeInTheDocument();
    await waitFor(() => expect(getProjectUsage).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "today" } });
    expect(screen.queryByText("Yesterday only")).not.toBeInTheDocument();
  });
  it("continues bounded history scans without waiting a minute", async () => {
    const source = await getProjectUsage();
    vi.mocked(getProjectUsage).mockClear().mockResolvedValueOnce({ ...source, warnings: ["scan_limit"] }).mockResolvedValue({ ...source, warnings: [], scannedFiles: 4 });
    render(<CodexUsagePanel zh />);
    await screen.findByText(/正在补全历史/);
    await waitFor(() => expect(getProjectUsage).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await waitFor(() => expect(screen.queryByText(/正在补全历史/)).not.toBeInTheDocument());
  });
  it("displays exact rolling ranges without treating thirty days as seven days", async () => {
    const data = createUsagePreview();
    const day = Object.values(data.devices[0].daily)[0];
    const now = new Date();
    const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    data.devices[0].daily = {};
    data.devices[0].ranges = { "30d": { ...day, start: dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)), end: dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) } };
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    const select = await screen.findByRole("combobox", { name: "统计时间" });
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.change(select, { target: { value: "30d" } });
    expect(screen.getByText("200万")).toBeInTheDocument();
    expect(screen.queryByText("含时段汇总 · 不拆分日用量")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "用量趋势" })).not.toBeInTheDocument();
    fireEvent.change(select, { target: { value: "7d" } });
    expect(screen.getByText("部分设备没有近 7 天数据。")).toBeInTheDocument();
    expect(screen.queryByText("200万")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "本周" })).not.toBeInTheDocument();
  });
  it("switches the ring and rows to costs, and global defaults to user cost shares", async () => {
    const data = createUsagePreview();
    data.groups.push({ id: "second", name: "Second user", deviceIds: ["Second Mac"] });
    data.devices.push({ ...data.devices[0], id: "Second Mac" });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    fireEvent.change(await screen.findByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    fireEvent.click(await screen.findByRole("button", { name: "切换为成本" }));
    expect(screen.getByText("$2.70")).toBeInTheDocument();
    expect(screen.getByText("88.9%")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "用量分组" }), { target: { value: "global" } });
    expect(screen.getByRole("combobox", { name: "查看方式" })).toHaveValue("users");
    expect(screen.getByText("$5.40")).toBeInTheDocument();
    expect(screen.getAllByText("50.0%")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "统计时间" }), { target: { value: "7d" } });
    expect(screen.getByRole("button", { name: "切换为Token" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "切换为Token" }));
    expect(screen.getByText("400万")).toBeInTheDocument();
    expect(saveTokeiGroups).not.toHaveBeenCalled();
  });
  it("shows unknown users explicitly and labels the known-cost denominator", async () => {
    const data = createUsagePreview();
    data.groups.push({ id: "unknown", name: "Unknown user", deviceIds: ["Missing"] });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    fireEvent.change(await screen.findByRole("combobox", { name: "用量分组" }), { target: { value: "global" } });
    expect(screen.getByText("成本不完整 · 占比仅计已知金额")).toBeInTheDocument();
    expect(screen.getByText("已知成本")).toBeInTheDocument();
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
  });
  it("keeps a user's known cost visible when another device has no current day", async () => {
    const data = createUsagePreview();
    data.groups[0].deviceIds.push("Offline");
    data.devices.push({ id: "Offline", stale: true, updatedAt: "2026-08-01T00:00:00Z", daily: {}, ranges: {} });
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    fireEvent.change(await screen.findByRole("combobox", { name: "用量分组" }), { target: { value: "global" } });
    expect(screen.getAllByText("$2.70").length).toBeGreaterThan(0);
    expect(screen.getByText("仅已知金额")).toBeInTheDocument();
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(screen.getByText("成本不完整 · 占比仅计已知金额")).toBeInTheDocument();
  });
  it("starts in task view, folds child details, and removes project view", async () => {
    render(<CodexUsagePanel zh />);
    expect(await screen.findByText("Local task")).toBeInTheDocument();
    expect(getProjectUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "查看方式" })).toHaveValue("tasks");
    expect(screen.getByText("Normal fork")).toBeInTheDocument();
    expect(screen.getByText("P020 · 11111111 · 含 1 个子 Agent")).toBeInTheDocument();
    expect(screen.getByText("本机未归属 0 · 其他设备 0")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Local task"));
    expect(screen.getByText("子 Agent 合计")).toBeInTheDocument();
    expect(screen.getByText("Usage worker")).toBeInTheDocument();
    expect(screen.getByText("Agent A · worker")).toBeInTheDocument();
    expect(screen.getByText(/Model A 40万/)).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "按项目" })).not.toBeInTheDocument();
    expect(screen.getByText(/今日 · 跨设备任务 2 项/)).toBeInTheDocument();
    expect(screen.getByText(/今日 · 跨设备任务 2 项/).closest("details")).toHaveClass("usage-explanation");
    expect(screen.getByText("本机未归属 0 · 其他设备 0").closest("details")).toHaveClass("usage-explanation");
  });
  it("never displays local projects for a group excluding the local device", async () => {
    const data = createUsagePreview();
    data.groups[0].deviceIds = ["Other device"];
    vi.mocked(getTokeiUsage).mockResolvedValue(data);
    render(<CodexUsagePanel zh />);
    await screen.findByRole("combobox", { name: "查看方式" });
    expect(await screen.findByText("这段时间暂无可归属的任务记录。")).toBeInTheDocument();
    expect(screen.queryByText("Local project")).not.toBeInTheDocument();
  });
  it("keeps the existing model totals available and hides management until requested", async () => {
    render(<CodexUsagePanel zh />);
    expect(await screen.findByText("200万")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "统计时间" })).toHaveValue("today");
    expect(screen.getByRole("combobox", { name: "查看方式" })).toHaveValue("tasks");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "查看方式" }), { target: { value: "models" } });
    expect(screen.getByText("Model A")).toBeInTheDocument();
    expect(screen.queryByText("思思")).not.toBeInTheDocument();
    expect(screen.queryByText("果冻")).not.toBeInTheDocument();
  });
  it("routes member management to the control center settings page", async () => {
    const onOpenSettings = vi.fn();
    render(<CodexUsagePanel zh onOpenSettings={onOpenSettings} />);
    await screen.findByText("200万");
    fireEvent.click(screen.getByRole("button", { name: "打开组员设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(saveTokeiGroups).not.toHaveBeenCalled();
  });
  it("shows global usage for an unassigned device instead of the shared default", async () => {
    vi.mocked(getTokeiUsage).mockResolvedValue({ ...createUsagePreview(), localGroupId: null });
    render(<CodexUsagePanel zh />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "用量分组" })).toHaveValue("global"));
    expect(screen.queryByText("选择一名组员，或到设置中分配设备。")).not.toBeInTheDocument();
  });
});
