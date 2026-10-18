import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { wallClockEpoch, devicePlan, makeDeviceSnapshot, countdownPhase } from "../src/mobile-reminders-core.js";
import { activityKitStartRequest, activityKitEndRequest } from "../src/activitykit-push-contract.js";

const now = Date.parse("2026-10-13T14:09:00+08:00") / 1000;
const task = { id: "synthetic-kpl-only", title: "模拟 KPL 抢票（不是生产任务）", status: "open", date: "2026-10-16" };
const schedule = { google_task_id: task.id, scheduled_date: "2026-10-16", scheduled_start: "12:00", timezone: "Asia/Shanghai",
  scheduling_status: "scheduled", reminder_policy: "custom", reminders: [{ at: "2026-10-16T11:00", offset_minutes: 60 }] };

test("KPL synthetic contract preserves configured noon and 11:00 without changing source", async () => {
  const originals = structuredClone([task, schedule]);
  const snapshot = makeDeviceSnapshot([task], [schedule], now);
  assert.deepEqual([task, schedule], originals);
  assert.deepEqual(snapshot, JSON.parse(await readFile(new URL("fixtures/mobile-kpl-synthetic.json", import.meta.url), "utf8")));
  assert.equal(snapshot.plans[0].eventAt, Date.parse("2026-10-16T04:00:00Z") / 1000);
  assert.deepEqual(snapshot.plans[0].reminderAt, [Date.parse("2026-10-16T03:00:00Z") / 1000]);
  assert.equal(snapshot.plans[0].liveActivityStartAt, snapshot.plans[0].reminderAt[0]);
});

test("countdown starts at the one-hour boundary and stops at the start instant", () => {
  const p = devicePlan(task, schedule, now);
  assert.equal(countdownPhase(p, p.liveActivityStartAt - 1), "waiting");
  assert.equal(countdownPhase(p, p.liveActivityStartAt), "active");
  assert.equal(countdownPhase(p, p.eventAt - 1), "active");
  assert.equal(countdownPhase(p, p.eventAt), "elapsed");
  assert.equal(countdownPhase({ ...p, enabled: false }, p.liveActivityStartAt), "disabled");
});

test("wall clock conversion is independent of phone/browser timezone", () => {
  for (const TZ of ["Etc/UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
    const source = "import {wallClockEpoch} from './src/mobile-reminders-core.js'; console.log(wallClockEpoch('2026-10-16T11:00','Asia/Shanghai'));";
    const result = execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: new URL("../", import.meta.url), env: { ...process.env, TZ } }).toString().trim();
    assert.equal(Number(result), 1792119600);
  }
  assert.equal(wallClockEpoch("2026-10-16T03:00Z", "Asia/Shanghai"), 1792119600);
  assert.equal(wallClockEpoch("2026-10-16T11:00:00+08:00", "Etc/UTC"), 1792119600);
});

test("DST gap, DST fold, impossible date and malformed time never guess an instant", () => {
  for (const value of ["2026-03-08T02:30", "2026-11-01T01:30"]) assert.throws(() => wallClockEpoch(value, "America/New_York"));
  for (const value of ["2026-02-30T11:00", "2026-10-16T24:00", "2026-10-16", "2026-10-16T11:99"]) assert.throws(() => wallClockEpoch(value, "Asia/Shanghai"));
  assert.throws(() => wallClockEpoch("2026-10-16T11:00", "Invalid/Timezone"));
});

test("explicit none, terminal Task and cancelled Schedule export removal rather than stale reminders", () => {
  for (const [t, s] of [
    [{ ...task, done: true }, schedule], [{ ...task, status: "cancelled" }, schedule],
    [task, { ...schedule, scheduling_status: "cancelled" }], [task, { ...schedule, reminder_policy: "none" }],
    [task, { ...schedule, notification_status: "disabled" }], [task, undefined],
  ]) assert.deepEqual(devicePlan(t, s, now), { taskId: task.id, title: task.title, timezone: "Asia/Shanghai", enabled: false, eventAt: null, liveActivityStartAt: null, reminderAt: [] });
});

test("mismatched identities, stale dates and absent reminder configuration are blocked", () => {
  assert.throws(() => devicePlan(task, { ...schedule, google_task_id: "other" }, now));
  assert.throws(() => devicePlan({ ...task, date: "2026-10-15" }, schedule, now));
  assert.throws(() => devicePlan(task, { ...schedule, reminders: [] }, now));
  assert.throws(() => devicePlan(task, schedule, Date.parse("2026-10-16T12:00+08:00") / 1000));
  assert.throws(() => makeDeviceSnapshot([task], [schedule, schedule], now));
  assert.throws(() => makeDeviceSnapshot([task, task], [schedule], now));
});

test("reschedule keeps task identity and changes only the derived device instants", () => {
  const p = devicePlan(task, schedule, now);
  const moved = devicePlan({ ...task, date: "2026-10-17" }, { ...schedule, scheduled_date: "2026-10-17", reminders: [{ at: "2026-10-17T11:00" }] }, now);
  assert.equal(p.taskId, moved.taskId);
  assert.equal(moved.eventAt - p.eventAt, 86400);
  assert.equal(moved.reminderAt[0] - p.reminderAt[0], 86400);
});

test("stored reminder instants are preserved, deduplicated and never inferred from title", () => {
  const p = devicePlan(task, { ...schedule, reminders: [{ at: "2026-10-16T10:30" }, { at: "2026-10-16T11:00" }, { at: "2026-10-16T11:00" }] }, now);
  assert.equal(p.reminderAt.length, 2);
  assert.equal(p.reminderAt[0], p.eventAt - 5400);
  assert.equal(p.liveActivityStartAt, p.eventAt - 3600);
  assert.throws(() => devicePlan(task, { ...schedule, reminders: [{ at: "2026-10-16T12:01" }] }, now));
});

test("offline ActivityKit request maps exactly to Swift Unix epoch state and no credentials", () => {
  const p = devicePlan(task, schedule, now);
  const request = activityKitStartRequest(p, "com.example.personalos.companion", p.liveActivityStartAt);
  assert.equal(request.headers["apns-push-type"], "liveactivity");
  assert.equal(request.headers["apns-topic"], "com.example.personalos.companion.push-type.liveactivity");
  assert.equal(request.headers["apns-expiration"], String(p.eventAt));
  assert.equal(request.body.aps.event, "start");
  assert.equal(request.body.aps["attributes-type"], "CountdownAttributes");
  assert.deepEqual(request.body.aps.attributes, { taskId: p.taskId, title: p.title });
  assert.deepEqual(request.body.aps["content-state"], { startEpoch: p.liveActivityStartAt, eventEpoch: p.eventAt });
  assert.ok(Buffer.byteLength(JSON.stringify(request.body)) < 4096);
  assert.doesNotMatch(JSON.stringify(request), /authorization|deviceToken|privateKey|endpoint/i);
  assert.equal(activityKitEndRequest(p, "com.example.personalos.companion", p.eventAt).body.aps["dismissal-date"], p.eventAt);
});

test("push start contract refuses early, expired, disabled and invalid plans", () => {
  const p = devicePlan(task, schedule, now);
  for (const at of [p.liveActivityStartAt - 1, p.eventAt]) assert.throws(() => activityKitStartRequest(p, "com.example.app", at));
  assert.throws(() => activityKitStartRequest({ ...p, enabled: false }, "com.example.app", p.liveActivityStartAt));
  assert.throws(() => activityKitStartRequest(p, "invalid/path", p.liveActivityStartAt));
  assert.throws(() => activityKitStartRequest({ ...p, liveActivityStartAt: p.eventAt - 1800 }, "com.example.app", p.eventAt - 1));
});

test("offline CLI prints sent:false and never sends a notification", () => {
  const output = execFileSync(process.execPath, ["scripts/preview-activitykit-push.mjs", "test/fixtures/mobile-kpl-synthetic.json", "com.example.personalos.companion", "2026-10-16T03:00:00Z"], { cwd: new URL("../", import.meta.url) }).toString();
  const result = JSON.parse(output);
  assert.equal(result.mode, "offline_simulation");
  assert.equal(result.sent, false);
  assert.equal(result.requests[0].body.aps.timestamp, 1792119600);
});
