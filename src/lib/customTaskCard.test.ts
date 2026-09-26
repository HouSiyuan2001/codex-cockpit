// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type AggregatedTaskUsage } from "./tokeiUsage";
import { copyCustomTaskCard, drawCustomTaskCard } from "./customTaskCard";

const row = (id: string, cost: number | null): AggregatedTaskUsage => {
  const metrics = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 120, estimatedCostUsd: cost };
  return { ...metrics, id, name: id, rawName: id, relation: "root", children: [], self: { ...metrics, id, name: id, relation: "root", models: [] } };
};
afterEach(() => vi.restoreAllMocks());

it("renders the selected tasks and incomplete-cost label into a high-resolution card", () => {
  const labels: string[] = [];
  const ctx = {
    scale: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
    fillText: (value: string) => labels.push(value), measureText: (value: string) => ({ width: value.length * 10 }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  const canvas = drawCustomTaskCard([row("Alpha", 2), row("Beta", null)], "近 7 天", true);
  expect(canvas.width).toBe(1440);
  expect(labels).toContain("任务账单");
  expect(labels).toContain("Alpha");
  expect(labels).toContain("Beta");
  expect(labels).toContain("$2.00");
  expect(labels).toContain("已知金额");
  expect(labels).toContain("暂无估算");
  expect(ctx.font).toContain("Smiley Sans");
});

it("writes a real image/png blob to the clipboard", async () => {
  const ctx = {
    scale: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
    fillText: vi.fn(), measureText: () => ({ width: 1 }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  const png = new Blob(["png"], { type: "image/png" });
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(png));
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
  const ClipboardItemMock = vi.fn(function (this: { data: Record<string, Promise<Blob>> }, data: Record<string, Promise<Blob>>) { this.data = data; });
  vi.stubGlobal("ClipboardItem", ClipboardItemMock);
  try {
    await copyCustomTaskCard([row("Alpha", 2)], "今日", true);
    const item = ClipboardItemMock.mock.calls[0][0] as { "image/png": Promise<Blob> };
    expect(await item["image/png"]).toBe(png);
    expect(write).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
