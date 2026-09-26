// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TaskUsageRow } from "./TaskUsageRow";
import type { AggregatedTaskUsage, TaskUsageDetail } from "../lib/tokeiUsage";

afterEach(cleanup);
const detail: TaskUsageDetail = { id: "self", name: "Task", relation: "root", models: [], inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 100, estimatedCostUsd: null, knownCostUsd: null };
const task: AggregatedTaskUsage = { ...detail, rawName: "Task", self: detail, children: [{ ...detail, id: "child", relation: "subagent" }], costIncomplete: true };

it("labels only remote tasks with their source machine", () => {
  const { rerender } = render(<TaskUsageRow task={{ ...task, sourceDevice: "Fruit-Windows" }} max={100} color="blue" zh metric="tokens" total={100} />);
  expect(screen.getByText("来自 Fruit-Windows")).toBeInTheDocument();
  rerender(<TaskUsageRow task={task} max={100} color="blue" zh metric="tokens" total={100} />);
  expect(screen.queryByText("来自 Fruit-Windows")).not.toBeInTheDocument();
});

it("shows recorded tokens for unpriced task, self and subagent subtotal without inventing money", () => {
  render(<TaskUsageRow task={task} max={1} color="blue" zh metric="cost" total={1} />);
  expect(screen.queryByText("暂无估算")).not.toBeInTheDocument();
  expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  expect(screen.getAllByText("已记录用量 · 计价资料不足")).toHaveLength(4);
});

it("labels a partial amount and does not claim a complete percentage", () => {
  render(<TaskUsageRow task={{ ...task, knownCostUsd: 2 }} max={10} color="blue" zh={false} metric="cost" total={10} />);
  expect(screen.getByText("$2.00")).toBeInTheDocument();
  expect(screen.getByText("Known amount only")).toBeInTheDocument();
  expect(screen.queryByText("20.0%")).not.toBeInTheDocument();
});
