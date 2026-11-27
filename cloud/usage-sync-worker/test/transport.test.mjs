import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

function database() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_initial.sql", "0002_group_settings.sql", "0003_shared_contract.sql", "0004_daily_plans.sql", "0005_claude_quota.sql", "0006_gemini_quota.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const prepare = sql => ({ bind: (...args) => ({
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: db.prepare(sql).run(...args) }),
  }) });
  return { prepare, batch: async statements => {
    db.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); db.exec("COMMIT"); return result; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  } };
}

test("space isolation, device binding, one-use invites, shared groups and stale replay", async () => {
  const env = { DB: database(), BOOTSTRAP_SECRET: "test-only-bootstrap", AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  async function api(route, token, body, bootstrap = false) {
    const response = await worker.fetch(new Request(`https://test.invalid${route}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(bootstrap ? { "x-bootstrap-secret": env.BOOTSTRAP_SECRET } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: response.status, ...await response.json() };
  }
  const owner = await api("/v1/spaces", null, { name: "Team", displayName: "Owner", deviceId: "mac" }, true);
  assert.equal(owner.status, 201);
  const invitation = await api("/v1/invites", owner.token, { maxUses: 1 });
  const member = await api("/v1/join", null, { inviteCode: invitation.inviteCode, displayName: "Member", deviceId: "windows" });
  assert.equal(member.status, 201);
  assert.equal((await api("/v1/join", null, { inviteCode: invitation.inviteCode, displayName: "Other", deviceId: "other" })).status, 403);
  assert.equal((await api("/v1/invites", member.token, {})).status, 403);
  const now = Math.floor(Date.now() / 1000);
  const payload = { _device: "mac", _ts: now, _ledger: { tools: { codex: {} } }, codex: { ranges: {} } };
  payload._ledger.tools.codex["2026-11-26"] = { in: 1, out: 1, models: {} };
  payload._cockpit = { schemaVersion: 1, timeZone: "Asia/Shanghai", protocolVersion: 2, appVersion: "0.3.8", settingsRevision: 0, pricingSource: "bundled-catalog" };
  payload.taskUsage = {version:1,partial:false,tasks:[{id:"root",name:"Shared task",relation:"root",daily:{}}]};
  const model = { id: "gemini-4-carbon", name: "Gemini 4 Carbon", requests: 1, inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 500, outputTokens: 100, costUsd: 0.00305 };
  const provider = { observedAt: new Date().toISOString(), latestActivityAt: null, days: [{
    localDate: "2026-11-26", requests: 1, inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 500, outputTokens: 100, costUsd: 0.00305, unpricedRequests: 0, models: [model],
  }] };
  payload.providerUsage = { gemini: provider, claude: { ...provider, days: [{ ...provider.days[0], models: [], costUsd: 0, unpricedRequests: 1 }] } };
  const privateUsage = { ...provider, days: [{ ...provider.days[0], tasks: [{ name: "local task" }] }] };
  assert.equal((await api("/v1/sync", owner.token, { deviceId: "mac", payload: { ...payload, providerUsage: { gemini: privateUsage } } })).status, 400);
  const groups = { groups: [{ id: "person-1", name: "Owner", deviceIds: ["mac"] }], defaultGroupId: "person-1" };
  assert.equal((await api("/v1/sync", owner.token, { deviceId: "mac", payload, groupSettings: groups })).status, 200);
  assert.equal((await api("/v1/sync", member.token, { deviceId: "mac", payload })).status, 403);
  assert.deepEqual((await api("/v1/snapshots", member.token)).snapshots[0].payload.taskUsage, payload.taskUsage);
  const sharedHistory = await api("/v1/snapshots?providerUsageVersion=1", member.token);
  assert.equal(sharedHistory.providerUsageVersion, 1);
  assert.deepEqual(sharedHistory.snapshots[0].payload.providerUsage, payload.providerUsage);
  assert.equal((await api("/v1/snapshots", member.token)).snapshots[0].payload.providerUsage, undefined);
  const providerOnly = { ...payload, _device: "windows", _ledger: { tools: { codex: {} } } };
  assert.equal((await api("/v1/sync?providerUsageVersion=1", member.token, { deviceId: "windows", payload: providerOnly })).status, 200);
  assert.equal((await api("/v1/snapshots", owner.token)).snapshots.some(row => row.deviceId === "windows"), false);
  assert.equal((await api("/v1/snapshots?providerUsageVersion=1", owner.token)).snapshots.some(row => row.deviceId === "windows"), true);
  const stale = await api("/v1/sync", owner.token, { deviceId: "mac", payload: { ...payload, _ts: now - 100 } });
  assert.equal(stale.snapshots[0].payload._ts, now);
  const me = await api("/v1/me", member.token);
  assert.deepEqual(me.groupSettings, groups);
  assert.equal(me.members.length, 2);
  assert.equal(JSON.stringify(me).includes(owner.token), false);
  const shared = { schemaVersion: 2, groups, pricing: {models: {"gpt-test": {in: 2, out: 4, cache_read: 1}}, aliases: {}}, costPolicy: "event-context-v1" };
  assert.equal((await api("/v2/settings", member.token, {expectedRevision:0,value:shared})).status, 403);
  const settings = await api("/v2/settings", owner.token, {expectedRevision:0,value:shared});
  assert.equal(settings.sharedSettings.revision, 1);
  assert.deepEqual((await api("/v2/settings", member.token)).sharedSettings.value, shared);
  assert.equal((await api("/v2/settings", owner.token, {expectedRevision:0,value:shared})).status, 409);
  assert.equal((await api("/v2/settings", owner.token, {expectedRevision:1,value:{...shared,pricing:{models:{bad:{in:-1,out:1,cache_read:1}}}}})).status, 400);
  const oldGroups = {groups:[],defaultGroupId:null};
  await api("/v1/sync", owner.token, {deviceId:"mac",payload:{...payload,_ts:now+1},groupSettings:oldGroups});
  assert.deepEqual((await api("/v1/me", member.token)).groupSettings, groups);
  await api("/v1/sync", member.token, {deviceId:"windows",payload:{...payload,_ts:now+2,_device:"windows"},clientInfo:{protocolVersion:2,appVersion:"0.2.18-p020.33",settingsRevision:1}});
  assert.equal((await api("/v1/me", owner.token)).members.find(m=>m.deviceId==="windows").syncInfo.settingsRevision,1);
  const outsider = await api("/v1/spaces", null, { name: "Other team", displayName: "Other", deviceId: "elsewhere" }, true);
  assert.deepEqual((await api("/v1/snapshots", outsider.token)).snapshots, []);
  assert.equal((await api("/v1/snapshots", "ccs_invalid")).status, 401);
  const basis={localDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),anchorAt:new Date().toISOString(),remainingPercent:80,resetsAt:new Date(Date.now()+4*86400000).toISOString()};
  const twoPeople={...groups,groups:[...groups.groups,{id:"person-2",name:"Member",deviceIds:["windows"]}]};
  assert.equal((await api("/v2/settings",owner.token,{expectedRevision:1,value:{...shared,groups:twoPeople}})).status,200);
  const seed=await api("/v2/daily-plan",owner.token,{basis});
  assert.equal(seed.status,200);
  assert.deepEqual((await api("/v2/daily-plan",member.token,{basis:{...basis,remainingPercent:60}})).plan.basis,seed.plan.basis);
  const edit=await api("/v2/daily-plan",owner.token,{basis,change:{kind:"person",personId:"person-1",value:12,expectedRevision:0}});
  assert.deepEqual(edit.plan.people["person-1"],{value:12,revision:1});
  assert.equal((await api("/v2/daily-plan",member.token,{basis,change:{kind:"person",personId:"person-1",value:8,expectedRevision:1}})).status,403);
  assert.equal((await api("/v2/daily-plan",owner.token,{basis,change:{kind:"person",personId:"person-1",value:8,expectedRevision:0}})).status,409);
  const second=await api("/v2/daily-plan",member.token,{basis,change:{kind:"person",personId:"person-2",value:10,expectedRevision:0}});
  assert.equal(second.status,200);
  assert.deepEqual(second.plan.people["person-1"],edit.plan.people["person-1"]);
  const risk=await api("/v2/daily-plan",member.token,{basis,change:{kind:"risk",value:20,expectedRevision:0}});
  assert.deepEqual(risk.plan.people,second.plan.people);
  assert.equal(risk.plan.risk.value,20);
  assert.deepEqual((await api("/v2/daily-plan",owner.token,{basis})).plan,risk.plan);
  const restored=await api("/v2/daily-plan",owner.token,{basis,change:{kind:"risk",value:null,expectedRevision:1}});
  assert.equal(restored.plan.risk.value,null);
  assert.deepEqual((await api("/v2/daily-plan",outsider.token,{basis})).plan.people,{});
  assert.equal((await api("/v2/daily-plan",owner.token,{basis:{...basis,localDate:"2020-01-01"}})).status,400);
  assert.equal((await api("/v1/devices/revoke",member.token,{deviceId:"mac"})).status,403);
  assert.equal((await api("/v1/devices/revoke",outsider.token,{deviceId:"windows"})).status,404);
  assert.equal((await api("/v1/devices/revoke",owner.token,{deviceId:"mac"})).status,400);
  assert.equal((await api("/v1/devices/revoke",owner.token,{deviceId:"windows"})).status,200);
  assert.equal((await api("/v1/snapshots",member.token)).status,401);
  assert.equal((await api("/v1/sync",member.token,{deviceId:"windows",payload:{...payload,_device:"windows"}})).status,401);
  assert.equal((await api("/v1/me",owner.token)).members.some(m=>m.deviceId==="windows"),false);
  assert.equal((await api("/v1/devices/revoke",owner.token,{deviceId:"windows"})).status,404);
});

test("every joined device may edit groups without changing pricing or overwriting a newer edit", async () => {
  const env = { DB: database(), BOOTSTRAP_SECRET: "test-only-bootstrap", AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) }, API_RATE_LIMITER: { limit: async () => ({ success: true }) } };
  async function api(route, token, body, bootstrap = false) {
    const result = await worker.fetch(new Request(`https://test.invalid${route}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(bootstrap ? { "x-bootstrap-secret": env.BOOTSTRAP_SECRET } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: result.status, ...await result.json() };
  }
  const owner = await api("/v1/spaces", null, { name: "Team", displayName: "Owner", deviceId: "mac" }, true);
  const invite = await api("/v1/invites", owner.token, { maxUses: 2 });
  const member = await api("/v1/join", null, { inviteCode: invite.inviteCode, displayName: "Member", deviceId: "windows" });
  const originalGroups = { groups: [{ id: "alex", name: "成员甲", deviceIds: ["mac"] }], defaultGroupId: "alex" };
  const pricing = { models: { "gpt-test": { in: 2, out: 4, cache_read: 1 } }, aliases: {} };
  const seed = await api("/v2/settings", owner.token, { expectedRevision: 0, value: { schemaVersion: 2, groups: originalGroups, pricing, costPolicy: "event-context-v1" } });
  assert.equal(seed.sharedSettings.revision, 1);
  const changedGroups = { groups: [...originalGroups.groups, { id: "blair", name: "成员乙", deviceIds: ["windows"] }], defaultGroupId: "alex" };
  const edit = await api("/v2/groups", member.token, { expectedRevision: 1, groups: changedGroups });
  assert.equal(edit.status, 200);
  assert.equal(edit.sharedSettings.revision, 2);
  assert.deepEqual(edit.sharedSettings.value.groups, changedGroups);
  assert.deepEqual(edit.sharedSettings.value.pricing, pricing);
  assert.equal((await api("/v2/groups", owner.token, { expectedRevision: 1, groups: originalGroups })).status, 409);
  assert.equal((await api("/v2/groups", member.token, { expectedRevision: 2, groups: { ...changedGroups, defaultGroupId: "missing" } })).status, 400);
  assert.equal((await api("/v2/settings", member.token, { expectedRevision: 2, value: { ...edit.sharedSettings.value, pricing: { models: {}, aliases: {} } } })).status, 403);
  assert.deepEqual((await api("/v1/me", owner.token)).groupSettings, changedGroups);
});

test("Claude quota snapshots are latest-only, device-bound and confined to the same person", async () => {
  const allow = { limit: async () => ({ success: true }) };
  const env = { DB: database(), BOOTSTRAP_SECRET: "bootstrap", AUTH_RATE_LIMITER: allow, API_RATE_LIMITER: allow };
  async function api(route, token, body) {
    const result = await worker.fetch(new Request(`https://test.invalid${route}`, {
      method: body ? "POST" : "GET",
      headers: token ? { authorization: `Bearer ${token}` } : { "x-bootstrap-secret": "bootstrap" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
    return { status: result.status, ...await result.json() };
  }
  const owner = await api("/v1/spaces", null, { name: "Space", displayName: "Mac", deviceId: "mac" });
  const invite = await api("/v1/invites", owner.token, { maxUses: 2 });
  const peer = await api("/v1/join", null, { inviteCode: invite.inviteCode, displayName: "PC", deviceId: "pc" });
  const teammate = await api("/v1/join", null, { inviteCode: invite.inviteCode, displayName: "Teammate", deviceId: "other" });
  const groups = { groups: [{ id: "person", name: "Person", deviceIds: ["mac", "pc"] }], defaultGroupId: "person" };
  const settings = { schemaVersion: 2, groups, pricing: { models: { "gpt-test": { in: 1, out: 1, cache_read: 1 } }, aliases: {} } };
  assert.equal((await api("/v2/settings", owner.token, { expectedRevision: 0, value: settings })).status, 200);
  const route = "/v2/claude-quota";
  const quota = { observedAt: new Date().toISOString(), fiveHour: { usedPercent: 28, resetsAt: null }, sevenDay: { usedPercent: 42, resetsAt: null } };
  assert.equal((await api(route, owner.token, { ...quota, deviceId: "pc" })).status, 400);
  assert.equal((await api(route, owner.token, { ...quota, fiveHour: { ...quota.fiveHour, token: "fixture" } })).status, 400);
  assert.equal((await api(route, owner.token, quota)).status, 200);
  await api(route, owner.token, { ...quota, observedAt: new Date(Date.now() - 10_000).toISOString(), sevenDay: null });
  assert.deepEqual((await api(route, peer.token)).snapshots, [{ deviceId: "mac", deviceName: "Mac", quota }]);
  assert.deepEqual((await api(route, owner.token)).snapshots, []);
  const geminiRoute = "/v2/gemini-quota";
  const geminiQuota = {
    observedAt: quota.observedAt,
    gemini: { fiveHour: { remainingPercent: 72, resetsAt: null }, weekly: null },
    claudeGpt: { fiveHour: null, weekly: { remainingPercent: 91, resetsAt: null } },
  };
  assert.equal((await api(geminiRoute, owner.token, { ...geminiQuota, plan: "private" })).status, 400);
  assert.equal((await api(geminiRoute, owner.token, geminiQuota)).status, 200);
  assert.deepEqual((await api(geminiRoute, peer.token)).snapshots, [{ deviceId: "mac", deviceName: "Mac", quota: geminiQuota }]);
  assert.deepEqual((await api(geminiRoute, teammate.token)).snapshots, []);
  assert.deepEqual((await api(route, teammate.token)).snapshots, []);
  assert.deepEqual((await api("/v1/snapshots", peer.token)).snapshots, []);
  const selfAdded = { ...groups, groups: [{ ...groups.groups[0], deviceIds: ["mac", "pc", "other"] }] };
  assert.equal((await api("/v2/groups", teammate.token, { expectedRevision: 1, groups: selfAdded })).status, 200);
  assert.deepEqual((await api(route, teammate.token)).snapshots, []);
  assert.deepEqual((await api(route, peer.token)).snapshots, [{ deviceId: "mac", deviceName: "Mac", quota }]);
  const reassigned = { groups: [{ id: "person", name: "Person", deviceIds: ["pc"] }, { id: "other", name: "Other", deviceIds: ["mac", "other"] }], defaultGroupId: "person" };
  assert.equal((await api("/v2/settings", owner.token, { expectedRevision: 2, value: { ...settings, groups: reassigned } })).status, 200);
  assert.deepEqual((await api(route, peer.token)).snapshots, []);
  assert.deepEqual((await api(route, teammate.token)).snapshots, []);
  assert.deepEqual((await api(geminiRoute, peer.token)).snapshots, []);
});
