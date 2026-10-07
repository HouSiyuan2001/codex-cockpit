import test from "node:test";
import assert from "node:assert/strict";
import { safeId, validateSnapshot } from "../src/index.js";

const fixture = { _device: "mac-mini", _ts: 1000, _ledger: { v: 1, tools: { codex: {} } }, codex: { ranges: {} }, _cockpit: { schemaVersion: 1 } };

test("accepts the aggregate snapshot contract", () => {
  assert.equal(validateSnapshot(fixture, "mac-mini", 1000), null);
});

test("rejects private fields and identity substitution", () => {
  assert.equal(validateSnapshot({ ...fixture, projectPath: "/private" }, "mac-mini", 1000), "snapshot_fields_rejected");
  assert.equal(validateSnapshot(fixture, "other-device", 1000), "snapshot_identity_mismatch");
});

test("bounds identities, feedback, and future timestamps", () => {
  assert.equal(safeId("../escape"), false);
  assert.equal(validateSnapshot({ ...fixture, _ts: 1400 }, "mac-mini", 1000), "snapshot_timestamp_invalid");
  assert.equal(validateSnapshot({ ...fixture, comfortFeedback: Array(4097) }, "mac-mini", 1000), "snapshot_feedback_invalid");
});

test("accepts native aggregates and rejects private fields at every nested boundary", () => {
  const p = { ...structuredClone(fixture),
    codex: { ranges: { today: { in: 12, cached: 2, out: 3, reason: 1, cost: null, models: [{ model_id: "openai/gpt-6.1-sol", name: "GPT-6.1", in: 12, cr: 2, out: 3, reason: 1, cost: null }] } } },
    _ledger: { v: 1, tools: { codex: { "2026-10-07": { in: 14, cached: 2, out: 3, reason: 1, cost: null, models: { "openai/gpt-6.1-sol": { in: 12, cr: 2, cw: 0, out: 3, reason: 1, cost: null, name: "GPT-6.1" } } } } } },
    _range_bounds: { today: { start: "2026-10-07", end: "2026-10-08" } },
    _cockpit: { schemaVersion: 1, collectedAt: "2026-10-07T00:00:00Z", status: "partial", retainedDays: 1, nativeDays: ["2026-10-07"] },
  };
  assert.equal(validateSnapshot(p, "mac-mini", 1000), null);
  const targets = [
    v => v.codex, v => v.codex.ranges.today, v => v.codex.ranges.today.models[0],
    v => v._ledger, v => v._ledger.tools, v => v._ledger.tools.codex["2026-10-07"],
    v => v._ledger.tools.codex["2026-10-07"].models["openai/gpt-6.1-sol"],
    v => v._range_bounds.today, v => v._cockpit,
  ];
  for (const target of targets) {
    const invalid = structuredClone(p); target(invalid).messages = "synthetic-private-data";
    assert.equal(validateSnapshot(invalid, "mac-mini", 1000), "snapshot_schema_invalid");
  }
  const invalid = structuredClone(p); invalid.codex.ranges.today.in = -1;
  assert.equal(validateSnapshot(invalid, "mac-mini", 1000), "snapshot_schema_invalid");
});

test("feedback and its optional projections are allowlisted recursively", () => {
  const tokens = { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1, totalTokens: 6 };
  const row = { localDate: "2026-10-07", observedAt: "2026-10-07T00:00:00Z", comfort: "comfortable",
    personId: "person-1", personName: "Example", observedUsedPercent: null, usageObservedAt: null,
    usageCoverage: "partial", usageSource: "local-history", curveVersion: "p014-t014-ordinal-map-v3",
    tokenSnapshot: { localDate: "2026-10-07", observedAt: "2026-10-07T00:00:00Z",
      metricVersion: "p020-person-calendar-token-v1", coverage: "partial", ...tokens,
      models: [{ id: "gpt-6.1-sol", name: "GPT-6.1", ...tokens }], deviceIds: ["mac-mini"], missingDeviceIds: [] },
    quotaAllocation: { localDate: "2026-10-07", observedAt: "2026-10-07T00:00:00Z",
      metricVersion: "cost-share-v1", coverage: "partial", totalUsedPercent: null, allocatedUsedPercent: null,
      personCostUsd: null, totalCostUsd: null, costShare: null, deviceIds: ["mac-mini"], missingDeviceIds: [] },
  };
  const p = { ...fixture, comfortFeedbackVersion: 1, comfortFeedback: [row] };
  assert.equal(validateSnapshot(p, "mac-mini", 1000), null);
  for (const target of [v => v.comfortFeedback[0], v => v.comfortFeedback[0].tokenSnapshot,
    v => v.comfortFeedback[0].tokenSnapshot.models[0], v => v.comfortFeedback[0].quotaAllocation]) {
    const invalid = structuredClone(p); target(invalid).auth = "synthetic-private-data";
    assert.equal(validateSnapshot(invalid, "mac-mini", 1000), "snapshot_feedback_invalid");
  }
  assert.equal(validateSnapshot({ ...fixture, comfortFeedback: [] }, "mac-mini", 1000), "snapshot_feedback_invalid");
});
