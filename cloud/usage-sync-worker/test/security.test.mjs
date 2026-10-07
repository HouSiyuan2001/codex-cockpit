import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { readBody } from "../src/request-body.js";

test("streaming JSON size cap works without Content-Length and counts UTF-8 bytes", async () => {
  const request = text => new Request("https://test.invalid", { method: "POST", body: text });
  assert.deepEqual(await readBody(request('{"ok":true}'), 20), { ok: true });
  await assert.rejects(readBody(request('{"x":"汉字"}'), 12), /body_too_large/);
  await assert.rejects(readBody(request("{"), 20), /invalid_json/);
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(30)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBody(new Request("https://test.invalid", { method: "POST", body: stream, duplex: "half" }), 20), /body_too_large/);
  assert.equal(cancelled, true);
});

test("missing/broken limit bindings fail closed, but health is not a sync readiness check", async () => {
  const env = { DB: { prepare() { assert.fail("must not access D1"); } } };
  assert.equal((await worker.fetch(new Request("https://test.invalid/health"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://test.invalid/v1/snapshots"), env)).status, 503);
  env.AUTH_RATE_LIMITER = { limit: async () => { throw new Error("synthetic-private-detail"); } };
  env.API_RATE_LIMITER = { limit: async () => ({ success: true }) };
  const result = await worker.fetch(new Request("https://test.invalid/v1/me"), env);
  assert.equal(result.status, 500);
  assert.equal((await result.text()).includes("synthetic-private-detail"), false);
});

test("unauthenticated limit blocks before database or body parsing with Retry-After", async () => {
  const keys = [];
  const env = { DB: { prepare() { assert.fail("must not access D1"); } },
    AUTH_RATE_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: false }; } },
    API_RATE_LIMITER: { limit: async () => { assert.fail("must not consume member limit"); } },
  };
  const result = await worker.fetch(new Request("https://test.invalid/v1/join", {
    method: "POST", headers: { "cf-connecting-ip": "192.0.2.1" }, body: "{",
  }), env);
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("retry-after"), "60");
  assert.deepEqual(keys, ["enroll:192.0.2.1"]);
});

test("async enrollment errors are safely mapped instead of escaping the fetch handler", async () => {
  const env = { BOOTSTRAP_SECRET: "synthetic-setup-secret",
    DB: { prepare() { assert.fail("must not access D1"); } },
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  const result = await worker.fetch(new Request("https://test.invalid/v1/spaces", {
    method: "POST", headers: { "x-bootstrap-secret": env.BOOTSTRAP_SECRET }, body: "{",
  }), env);
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { ok: false, error: "invalid_json" });
  const large = await worker.fetch(new Request("https://test.invalid/v1/join", {
    method: "POST", headers: { "content-length": String(2 * 1024 * 1024) }, body: "{}",
  }), env);
  assert.equal(large.status, 413);
});

test("authenticated rate keys use member identity, not the raw bearer credential", async () => {
  const token = "ccs_" + "a".repeat(43);
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ id: "member", space_id: "space" }) }) }) },
    AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    API_RATE_LIMITER: { limit: async ({ key }) => { assert.equal(key, "space:member"); assert.equal(key.includes(token), false); return { success: false }; } },
  };
  const result = await worker.fetch(new Request("https://test.invalid/v1/snapshots", { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(result.status, 429);
});

test("invalid historical snapshots are not returned and are not silently deleted", async () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = { _device: "peer", _ts: now, _ledger: { v: 1, tools: { codex: {} } }, codex: { ranges: {} } };
  let stored = { ...payload, codex: { ranges: {}, messages: "synthetic-private-data" } };
  const env = { DB: { prepare: sql => {
    assert.ok(sql.startsWith("SELECT"));
    return { bind: () => ({
      first: async () => ({ id: "member", space_id: "space" }),
      all: async () => ({ results: [{ device_id: "peer", display_name: "Example", payload_json: JSON.stringify(stored), updated_at: now }] }),
    }) };
  } }, AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  const request = () => new Request("https://test.invalid/v1/snapshots", { headers: { authorization: "Bearer ccs_" + "a".repeat(43) } });
  assert.deepEqual((await (await worker.fetch(request(), env)).json()).snapshots, []);
  stored = payload;
  assert.equal((await (await worker.fetch(request(), env)).json()).snapshots.length, 1);
});
