import test from "node:test";
import assert from "node:assert/strict";
import { createMobileDeviceHandler } from "../ios/backend/mobile-device-api.js";

// All identities, tokens and canonical provider records here are synthetic.
const deviceId = "00000000-0000-4000-8000-000000000001";
const taskId = "synthetic-kpl-only";
const start = Date.parse("2026-10-16T11:00:00+08:00") / 1000;
const event = start + 3600;
const key = (...values) => JSON.stringify(values);

class SyntheticStore {
  devices = new Map(); follows = new Map(); windows = new Map();
  ignoredWrite = false;
  async getDevice(owner, id) { return structuredClone(this.devices.get(key(owner, id))); }
  async listDevices(owner) { return [...this.devices.values()].filter(d => d.ownerId === owner).map(row => structuredClone(row)); }
  async compareAndSetDevice(owner, id, expected, row) {
    if ((this.devices.get(key(owner, id))?.revision || 0) !== expected) return false;
    if (!this.ignoredWrite) this.devices.set(key(owner, id), structuredClone(row));
    return true;
  }
  async revokeDevice(owner, id, now) {
    const row = this.devices.get(key(owner, id));
    Object.assign(row, { revoked: true, automaticCountdownEnabled: false, pushToStartTokenSealed: null, updatedAt: now, revision: row.revision + 1 });
    for (const [k, w] of this.windows) if (w.ownerId === owner && w.deviceId === id) this.windows.set(k, { ...w, closed: true, activityTokenSealed: null });
    for (const [k, f] of this.follows) if (f.ownerId === owner && f.deviceId === id) this.follows.delete(k);
  }
  async setFollow(owner, id, task, enabled) {
    if (enabled) this.follows.set(key(owner, id, task), { ownerId: owner, deviceId: id, taskId: task });
    else this.follows.delete(key(owner, id, task));
  }
  async isFollowed(owner, id, task) { return this.follows.has(key(owner, id, task)); }
  async listFollows(owner) { return [...this.follows.values()].filter(f => f.ownerId === owner); }
  windowKey(w) { return key(w.ownerId, w.deviceId, w.taskId, w.eventAt); }
  async claimWindow(w, claim) {
    const k = this.windowKey(w), device = this.devices.get(key(w.ownerId, w.deviceId));
    if (this.windows.has(k) || device.revoked || device.revision !== claim.deviceRevision) return false;
    this.windows.set(k, { ...w, ...claim, status: "claimed" }); return true;
  }
  async closeWindow(w, now) { this.windows.set(this.windowKey(w), { ...this.windows.get(this.windowKey(w)), ...w, closed: true, closedAt: now }); }
  async isWindowClosed(w) { return this.windows.get(this.windowKey(w))?.closed === true; }
  async recordWindowOutcome(w, outcome) { Object.assign(this.windows.get(this.windowKey(w)), outcome); }
  async setActivityToken(w, sealed, now) { this.windows.set(this.windowKey(w), { ...this.windows.get(this.windowKey(w)), ...w, activityTokenSealed: sealed, tokenAt: now }); }
  async activityTokenMatches(w, sealed) { return this.windows.get(this.windowKey(w))?.activityTokenSealed === sealed; }
  async listEndingWindows(owner, now) { return [...this.windows.values()].filter(w => w.ownerId === owner && w.activityTokenSealed && (w.eventAt <= now || w.closed)); }
  async claimEnd(w) { const row = this.windows.get(this.windowKey(w)); if (row.endClaimed) return false; row.endClaimed = true; return true; }
  async recordEndOutcome(w, outcome) { Object.assign(this.windows.get(this.windowKey(w)), { endOutcome: outcome }); }
}

function harness(overrides = {}) {
  const store = new SyntheticStore(), tokens = new Map(), sends = [], ends = [], reads = [];
  const state = { now: start, mode: "accepted", beforeSecondRead: null };
  const canonical = { task: { id: taskId, title: "模拟 KPL 抢票 · 非生产", date: "2026-10-16", status: "open" },
    schedule: { google_task_id: taskId, scheduled_date: "2026-10-16", scheduled_start: "12:00", timezone: "Asia/Shanghai", reminder_policy: "custom", reminders: [{ at: "2026-10-16T11:00" }] } };
  const tokenVault = {
    async seal(token) { const reference = `synthetic-vault-${tokens.size}`; tokens.set(reference, token); return reference; },
    async unseal(reference) { assert.ok(tokens.has(reference)); return tokens.get(reference); },
  };
  const handler = createMobileDeviceHandler({
    authenticateUser: async req => req.headers.get("Authorization") === "Bearer synthetic-user-a" ? { ownerId: "synthetic-owner-a" }
      : req.headers.get("Authorization") === "Bearer synthetic-user-b" ? { ownerId: "synthetic-owner-b" } : null,
    authenticateWorker: async req => req.headers.get("Authorization") === "Bearer synthetic-worker" ? { ownerId: "synthetic-owner-a" } : null,
    store, tokenVault,
    readCanonical: async (owner, id) => {
      reads.push({ owner, id });
      if (reads.length % 2 === 0 && state.beforeSecondRead) await state.beforeSecondRead();
      assert.equal(id, taskId); return structuredClone(canonical);
    },
    sendActivityStart: async input => { sends.push(input); if (state.mode === "throw") throw new Error("synthetic private provider exception"); return state.mode === "accepted" ? { accepted: true } : state.mode === "rejected" ? { rejected: true } : {}; },
    sendActivityEnd: async input => { ends.push(input); return { accepted: true }; },
    clock: () => state.now, ...overrides,
  });
  async function request(path, body, auth = "synthetic-user-a", method = "POST") {
    const result = await handler(new Request(`https://synthetic.invalid/${path}`, {
      method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: result.status, body: await result.json() };
  }
  function registration(extra = {}) {
    return { deviceId, bundleId: "com.example.synthetic.personalos", environment: "sandbox", iosVersion: "17.2",
      permissions: { notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: true, observedAt: state.now },
      automaticCountdownEnabled: true, expectedRevision: 0, pushToStartToken: "a".repeat(64), ...extra };
  }
  async function ready(extra = {}) {
    assert.equal((await request("devices", registration(extra))).status, 200);
    assert.equal((await request(`devices/${deviceId}/tasks/${taskId}/follow`, { enabled: true })).status, 200);
  }
  return { handler, request, registration, ready, state, store, canonical, tokens, sends, ends, reads };
}

test("device registration is owner-bound, token-sealed and receipt-redacted", async () => {
  const h = harness();
  const result = await h.request("devices", h.registration());
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 1);
  assert.equal(result.body.pushToStartTokenRegistered, true);
  assert.doesNotMatch(JSON.stringify(result.body), /synthetic-vault|a{64}|ownerId/);
  const row = await h.store.getDevice("synthetic-owner-a", deviceId);
  assert.ok(row.pushToStartTokenSealed.startsWith("synthetic-vault"));
  const listed = await h.request("devices", undefined, "synthetic-user-a", "GET");
  assert.equal(listed.body.devices.length, 1);
  assert.doesNotMatch(JSON.stringify(listed.body), /synthetic-vault|a{64}|ownerId/);
  assert.equal((await h.request("devices", { ...h.registration(), ownerId: "synthetic-owner-b" })).body.code, "UNEXPECTED_FIELD");
  assert.equal((await h.request(`devices/${deviceId}`, {}, "synthetic-user-b", "DELETE")).status, 404);
  assert.deepEqual((await h.request("devices", undefined, "synthetic-user-b", "GET")).body.devices, []);
});

test("registration refuses missing auth, vault, malformed and stale permission data", async () => {
  const h = harness({ tokenVault: undefined });
  assert.equal((await h.request("devices", h.registration(), "invalid")).status, 401);
  assert.equal((await h.request("devices", h.registration())).body.code, "TOKEN_VAULT_NOT_CONFIGURED");
  const good = harness();
  assert.equal((await good.request("devices", good.registration({ pushToStartToken: "not-a-token" }))).body.code, "INVALID_PUSH_TOKEN");
  const p = good.registration().permissions;
  assert.equal((await good.request("devices", good.registration({ permissions: { ...p, observedAt: start - 7 * 86400 - 1 } }))).body.code, "INVALID_PERMISSION_SNAPSHOT");
  assert.equal((await good.request("devices", good.registration({ deviceId: "../other" }))).body.code, "INVALID_DEVICE");
  assert.equal(good.store.devices.size, 0);
});

test("token rotation uses revision CAS and rejects ignored write receipts", async () => {
  const h = harness(); await h.ready();
  const rotated = await h.request("devices", h.registration({ expectedRevision: 1, pushToStartToken: "b".repeat(64) }));
  assert.equal(rotated.body.revision, 2);
  assert.equal((await h.request("devices", h.registration())).status, 409);
  h.store.ignoredWrite = true;
  assert.equal((await h.request("devices", h.registration({ expectedRevision: 2 }))).body.code, "DEVICE_WRITE_UNVERIFIED");
});

test("T−1h worker sends once at 11:00 from canonical instants and never claims delivery", async () => {
  const h = harness(); await h.ready();
  const results = await Promise.all([h.request("dispatch-due", {}, "synthetic-worker"), h.request("dispatch-due", {}, "synthetic-worker")]);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].request.body.aps["content-state"].eventEpoch, event);
  assert.equal(h.sends[0].request.body.aps["content-state"].startEpoch, start);
  assert.equal(h.sends[0].request.body.aps.timestamp, start);
  assert.ok(results.some(r => r.body.results[0].status === "APNS_ACCEPTED_DEVICE_UNVERIFIED"));
  assert.ok(results.every(r => r.body.deviceDeliveryVerified === false));
  assert.ok(h.reads.every(r => r.owner === "synthetic-owner-a"));
});

test("worker route never accepts ordinary user auth and missing sender consumes no claim", async () => {
  const h = harness({ sendActivityStart: undefined }); await h.ready();
  assert.equal((await h.request("dispatch-due", {})).status, 401);
  assert.equal((await h.request("dispatch-due", {}, "synthetic-worker")).body.code, "DELIVERY_NOT_CONFIGURED");
  assert.equal(h.store.windows.size, 0);
});

test("early and more-than-60s late dispatch do not send", async () => {
  for (const now of [start - 1, start + 61, event]) {
    const h = harness(); await h.ready(); h.state.now = now;
    await h.request("dispatch-due", {}, "synthetic-worker"); assert.equal(h.sends.length, 0);
  }
});

test("denied permissions, unsupported OS, absent token and explicit no-consent block starts", async () => {
  for (const option of [{ iosVersion: "17.1" }, { pushToStartToken: undefined }, { automaticCountdownEnabled: false },
    { permissions: { notificationAuthorization: "denied", alertsEnabled: false, soundEnabled: false, liveActivitiesEnabled: true, observedAt: start } },
    { permissions: { notificationAuthorization: "authorized", alertsEnabled: true, soundEnabled: true, liveActivitiesEnabled: false, observedAt: start } }]) {
    const h = harness(); await h.ready(option);
    await h.request("dispatch-due", {}, "synthetic-worker"); assert.equal(h.sends.length, 0);
  }
});

test("completed task, cleared reminders and rescheduled canonical anchor block the old window", async () => {
  for (const change of [h => h.canonical.task.status = "completed", h => h.canonical.schedule.reminder_policy = "none",
    h => { h.canonical.task.date = "2026-10-17"; h.canonical.schedule.scheduled_date = "2026-10-17"; h.canonical.schedule.reminders = [{ at: "2026-10-17T11:00" }]; }]) {
    const h = harness(); await h.ready(); change(h);
    await h.request("dispatch-due", {}, "synthetic-worker"); assert.equal(h.sends.length, 0);
  }
});

test("manual close before dispatch survives later workers and never restarts the window", async () => {
  const h = harness(); await h.ready();
  const result = await h.request(`devices/${deviceId}/tasks/${taskId}/close`, { eventAt: event });
  assert.equal(result.body.automaticRestartAllowed, false);
  await h.request("dispatch-due", {}, "synthetic-worker"); await h.request("dispatch-due", {}, "synthetic-worker");
  assert.equal(h.sends.length, 0);
});

test("close and reschedule racing a claimed window stop before the transport", async () => {
  for (const action of [async h => h.request(`devices/${deviceId}/tasks/${taskId}/close`, { eventAt: event }),
    async h => { h.canonical.schedule.reminder_policy = "none"; }]) {
    const h = harness(); await h.ready(); h.reads.length = 0;
    h.state.beforeSecondRead = () => action(h);
    const r = await h.request("dispatch-due", {}, "synthetic-worker");
    assert.equal(r.body.results[0].status, "STOPPED_BEFORE_SEND"); assert.equal(h.sends.length, 0);
  }
});

test("unknown, interrupted and rejected starts are durable and never automatically retried", async () => {
  for (const mode of ["throw", "unknown", "rejected"]) {
    const h = harness(); await h.ready(); h.state.mode = mode;
    const first = await h.request("dispatch-due", {}, "synthetic-worker");
    await h.request("dispatch-due", {}, "synthetic-worker");
    assert.equal(h.sends.length, 1);
    assert.doesNotMatch(JSON.stringify(first.body), /private provider|a{64}/);
    assert.equal(first.body.results[0].delivered, false);
  }
});

test("device revoke disables registration and every future send", async () => {
  const h = harness(); await h.ready();
  const r = await h.request(`devices/${deviceId}`, {}, "synthetic-user-a", "DELETE");
  assert.equal(r.body.revoked, true); assert.equal(r.body.pushToStartTokenRegistered, false);
  assert.equal((await h.request("devices", h.registration({ expectedRevision: r.body.revision }))).body.code, "DEVICE_REVOKED");
  await h.request("dispatch-due", {}, "synthetic-worker"); assert.equal(h.sends.length, 0);
});

test("activity token endpoint and explicit noon end use separate sealed instance token", async () => {
  const h = harness(); await h.ready();
  await h.request("dispatch-due", {}, "synthetic-worker");
  const r = await h.request(`devices/${deviceId}/tasks/${taskId}/activity-token`, { eventAt: event, activityToken: "c".repeat(64) });
  assert.equal(r.body.activityTokenRegistered, true); assert.doesNotMatch(JSON.stringify(r.body), /c{64}|synthetic-vault/);
  h.state.now = event;
  const ended = await h.request("dispatch-end", {}, "synthetic-worker");
  await h.request("dispatch-end", {}, "synthetic-worker");
  assert.equal(h.ends.length, 1); assert.equal(h.ends[0].token, "c".repeat(64));
  assert.equal(h.ends[0].request.body.aps.event, "end");
  assert.equal(ended.body.results[0].deviceEndedVerified, false);
});

test("body size and unknown owner fields reject before storage and expose no input", async () => {
  const h = harness();
  const r = await h.request("devices", { personalNotes: "synthetic".repeat(3000) });
  assert.equal(r.status, 413); assert.deepEqual(r.body, { success: false, code: "BODY_TOO_LARGE" });
  assert.equal(h.store.devices.size, 0);
});

test("a broken owner filter in an adapter is refused rather than returning foreign device data", async () => {
  const foreign = { ownerId: "synthetic-owner-b", deviceId, revision: 1 };
  const h = harness({ store: { getDevice: async () => foreign, listDevices: async () => [foreign] } });
  assert.equal((await h.request("devices", undefined, "synthetic-user-a", "GET")).body.code, "DEVICE_READ_UNVERIFIED");
  assert.equal((await h.request(`devices/${deviceId}`, {}, "synthetic-user-a", "DELETE")).status, 404);
});
