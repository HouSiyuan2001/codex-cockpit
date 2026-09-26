import test from "node:test";
import assert from "node:assert/strict";
import { validTaskUsage } from "../src/index.js";

test("task summary allowlist rejects paths, bodies, invalid counts and duplicate identities", () => {
  const day = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 10, estimatedCostUsd: null, models: [], start: null, end: null };
  const value = { version: 1, partial: false, tasks: [{ id: "task-1", name: "研究任务", relation: "root", daily: { "2026-09-15": day } }] };
  assert.equal(validTaskUsage(value), true);
  for (const key of ["path", "projectName", "messages", "auth"]) {
    const invalid = structuredClone(value); invalid.tasks[0][key] = "private";
    assert.equal(validTaskUsage(invalid), false);
  }
  const invalid = structuredClone(value); invalid.tasks[0].daily["2026-09-15"].totalTokens = -1;
  assert.equal(validTaskUsage(invalid), false);
  assert.equal(validTaskUsage({ ...value, tasks: [value.tasks[0], value.tasks[0]] }), false);
  assert.equal(validTaskUsage({ ...value, tasks: [{ ...value.tasks[0], daily: { "2026-99-99": day } }] }), false);
});
