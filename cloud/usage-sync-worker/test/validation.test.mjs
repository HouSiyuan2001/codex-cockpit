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
