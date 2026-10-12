import {readFile} from "node:fs/promises";
import {stripTypeScriptTypes} from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIntake } from "../supabase/functions/_shared/personal-os-intake.js";

let importNumber = 0;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function loadIntakeHandler({ taskResult, readTask, context, failPreference = false, unknownCreateOnce = false, contextAuthFailureOnce = false, accountFailureOnCall = 0, projectionFailureOnce = false, projectionReceiptStatus = "disabled", createReceiptStatus = "disabled", reconciliationResult = null, contextGate = null, lostReservationResponse = false, contextRefusalCode = null } = {}) {
  const previousDeno = globalThis.Deno;
  const previousFetch = globalThis.fetch;
  const writes = [];
  const token = `unit-${"x".repeat(32)}`;
  const environment = {
    SUPABASE_URL: "https://personal-os.test",
    SUPABASE_SERVICE_ROLE_KEY: `unit-${"s".repeat(32)}`,
    OWNER_USER_ID: "11111111-1111-4111-8111-111111111111",
    AUTOMATION_WRITE_TOKEN: token,
  };
  let handler;
  let goalPlanReads = 0;
  let lastTask = null;
  let lastSchedule = null;
  let createAttempts = 0;
  let contextAttempts = 0;
  let accountAttempts = 0;
  let projectionAttempts = 0;
  let audit = null;

  globalThis.Deno = {
    env: { get: (name) => environment[name] },
    serve: (nextHandler) => { handler = nextHandler; },
  };
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    writes.push({ path: `${requestUrl.pathname}${requestUrl.search}`, method: init.method || "GET", body });

    if (requestUrl.pathname.endsWith("/functions/v1/task-status")) {
      if (body.action === "autonomy_context") {
        contextAttempts += 1;
        if (contextGate) await contextGate;
        if (contextRefusalCode && contextAttempts === 1) return json({error:"Explicit context refusal",code:contextRefusalCode},409);
        if (contextAuthFailureOnce && contextAttempts === 1) return json({ error: "Original Google credential expired", code: "GOOGLE_REAUTH_REQUIRED" }, 401);
        return json(context || { current_task: null, calendar_events: [], context_warnings: [] });
      }
      if (body.action === "account_context") {
        accountAttempts += 1;
        if (accountAttempts === accountFailureOnCall) return json({ error: "Google authorization expired", code: "GOOGLE_REAUTH_REQUIRED" }, 401);
        return json({ account_subject: "account-one" });
      }
      if (body.action === "read_task") return json(readTask || { task: lastTask, schedule: lastSchedule });
      if (body.action === "reconcile_intake") return json(reconciliationResult || { outcome: lastTask ? "verified" : "unknown", task: lastTask, schedule: lastSchedule });
      if (body.action === "retry_projection") {
        projectionAttempts += 1;
        if (projectionFailureOnce && projectionAttempts === 1) return json({ error: "Calendar temporarily unavailable", code: "GOOGLE_PROVIDER_TRANSIENT" }, 503);
        return json({ receipt: { task_save_status: "verified", reminder_projection_status: projectionReceiptStatus } });
      }
      if (body.action === "update_task") {
        lastTask = taskResult?.task || {
          id: body.task_id, title: "下午四点开会", notes: "", dueDate: null,
        };
        return json(taskResult || {
          write_success: true,
          task: lastTask,
          resolution: { decision: "UPDATE" },
        });
      }
      lastTask = taskResult?.task || {
        id: "task-hotel", title: body.title, notes: body.notes, dueDate: body.dueDate,
      };
      lastSchedule = body.schedule || null;
      createAttempts += 1;
      if (unknownCreateOnce && createAttempts === 1) throw new DOMException("simulated connection timeout", "TimeoutError");
      return json(taskResult || {
        write_success: true,
        task: lastTask,
        receipt: { task_save_status: "verified", reminder_projection_status: createReceiptStatus },
      });
    }

    if (requestUrl.pathname.endsWith("/rest/v1/personal_os_intake_audit")) {
      const stageFilter = requestUrl.searchParams.get("stage");
      if (stageFilter?.startsWith("in.(") && audit && !stageFilter.includes(audit.stage)) return json([]);
      if ((init.method || "GET") === "POST") {
        if (audit) return json([]);
        audit = { id: "11111111-1111-4111-8111-111111111111", recovery_version: 0, retry_count: 0, ...body };
        if (lostReservationResponse) throw new DOMException("reservation response lost", "TimeoutError");
        return json([audit]);
      }
      if ((init.method || "GET") === "PATCH") {
        const expectedOwner = requestUrl.searchParams.get("lease_owner");
        if (expectedOwner && expectedOwner !== `eq.${audit?.lease_owner}`) return json([]);
        audit = { ...audit, ...body };
        return json([audit]);
      }
      const exactKey = requestUrl.searchParams.get("idempotency_key");
      return json(audit && (!exactKey || exactKey === `eq.${audit.idempotency_key}`) ? [audit] : []);
    }
    if (requestUrl.pathname.endsWith("/rest/v1/goals_plans")) {
      goalPlanReads += 1;
      if (failPreference && (init.method || "GET") === "POST") return json({ message: "plan write unavailable" }, 503);
      return json([]);
    }
    throw new Error(`Unexpected request: ${requestUrl.pathname}`);
  };

  try {
    await import(new URL(`../supabase/functions/personal-os-intake/index.ts?integration=${importNumber += 1}`, import.meta.url));
    assert.equal(typeof handler, "function");
    return {
      writes,
      token,
      goalPlanReads: () => goalPlanReads,
      createAttempts: () => createAttempts,
      accountAttempts: () => accountAttempts,
      mutateAudit: (changes) => { audit = { ...audit, ...changes }; },
      getAudit: () => audit,
      mutateTask: (changes) => Object.assign(lastTask, changes),
      list: async (params = "") => handler(new Request(`https://personal-os.test/intake${params}`, {
        method: "GET", headers: { authorization: `Bearer ${token}` },
      })),
      malformed: async () => handler(new Request("https://personal-os.test/intake", {method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json","idempotency-key":"integration-key-1"},body:"{invalid"})),
      request: async (body) => handler(new Request("https://personal-os.test/intake", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "integration-key-1" },
        body: JSON.stringify(body),
      })),
      restore: () => {
        globalThis.Deno = previousDeno;
        globalThis.fetch = previousFetch;
      },
    };
  } catch (error) {
    globalThis.Deno = previousDeno;
    globalThis.fetch = previousFetch;
    throw error;
  }
}

function taskStatusWrites(harness) {
  return harness.writes.filter((call) => call.path.endsWith("/functions/v1/task-status"));
}

test("real intake handler writes, reads back, and returns the verified confirmation", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "订亚朵酒店", type: "task", title: "订亚朵酒店" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.write_success, true);
    assert.equal(body.verified, true);
    assert.equal(body.message, "已经写进去了");
    assert.deepEqual(taskStatusWrites(harness).map((call) => call.body.action || "create"), ["autonomy_context", "account_context", "create", "read_task"]);
  } finally {
    harness.restore();
  }
});

test("a timed-out successful provider write is reconciled and ten replays create only once", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ unknownCreateOnce: true });
  const input = { raw_text: "订亚朵酒店", type: "task", title: "订亚朵酒店" };
  try {
    const first = await (await harness.request(input)).json();
    assert.equal(first.success, false);
    assert.equal(first.code, "INTAKE_TIMEOUT");
    harness.mutateAudit({ next_retry_at: null, lease_expires_at: null });
    const recovered = await (await harness.request(input)).json();
    assert.equal(recovered.success, true);
    assert.equal(recovered.id, "task-hotel");
    for (let count = 0; count < 10; count += 1) {
      const replay = await (await harness.request(input)).json();
      assert.equal(replay.id, "task-hotel");
    }
    assert.equal(harness.createAttempts(), 1);
  } finally { harness.restore(); }
});

test("Calendar failure resumes projection on the same task", { concurrency: false }, async () => {
  const task = { id: "task-reminder", title: "交材料", notes: "2099-01-01 15:00提醒我交材料", dueDate: "2099-01-01" };
  const harness = await loadIntakeHandler({
    taskResult: { write_success: true, task, projection_error: { code: "CALENDAR_SYNC_PENDING" },
      receipt: { task_save_status: "verified", reminder_projection_status: "pending" } },
    projectionReceiptStatus: "configured",
  });
  const input = { raw_text: "2099-01-01 15:00提醒我交材料", type: "task", title: "交材料",
    due: "2099-01-01", requested_date: "2099-01-01", requested_time: "15:00" };
  try {
    const first = await (await harness.request(input)).json();
    assert.equal(first.success, false);
    assert.equal(first.id, "task-reminder");
    harness.mutateAudit({ next_retry_at: null, lease_expires_at: null });
    const second = await (await harness.request(input)).json();
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.id, "task-reminder");
    assert.equal(harness.createAttempts(), 1);
    assert.equal(taskStatusWrites(harness).filter((call) => call.body.action === "retry_projection").length, 1);
  } finally { harness.restore(); }
});

test("date-only reminder creates and verifies one task without a timed projection", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ createReceiptStatus: "not_requested" });
  const input = { raw_text: "明天提醒我落实重点人群退抵税系统", type: "task", title: "落实重点人群退抵税系统",
    due: "2026-09-25", requested_date: "2026-09-25", fixed_time: false, priority: "high" };
  try {
    const first = await (await harness.request(input)).json();
    assert.equal(first.success, true, JSON.stringify(first));
    const schedule = harness.getAudit().request_payload.schedule;
    assert.equal(schedule.scheduled_date, "2026-09-25");
    assert.equal(schedule.scheduled_start, null);
    assert.equal(schedule.fixed_time, false);
    assert.equal(schedule.priority, "high");
    const replay = await (await harness.request(input)).json();
    assert.equal(replay.id, first.id);
    assert.equal(harness.createAttempts(), 1);
  } finally { harness.restore(); }
});

test("a missing reminder time is listed and amended under the same request identity", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ createReceiptStatus: "configured" });
  try {
    const first = await (await harness.request({ raw_text: "提醒我交材料", type: "task", title: "交材料", fixed_time: true })).json();
    assert.equal(first.code, "REMINDER_TIME_REQUIRED");
    assert.equal(harness.createAttempts(), 0);
    const list = await (await harness.list("?limit=1&offset=0")).json();
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0].stage, "needs_input");
    assert.equal(list.has_more, false);
    const amended = await (await harness.request({ action: "amend_request", request_id: first.request_id,
      recovery_version: list.requests[0].recovery_version, requested_date: "2099-01-01", requested_time: "15:00" })).json();
    assert.equal(amended.id, "task-hotel");
    assert.equal(harness.createAttempts(), 1);
    assert.equal(harness.getAudit().id, first.request_id);
  } finally { harness.restore(); }
});

test("a prewrite authorization interruption resumes the same request after account verification", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const first = await (await harness.request({ raw_text: "提醒我交材料", type: "task", title: "交材料", fixed_time: true })).json();
    assert.equal(first.code, "REMINDER_TIME_REQUIRED");
    const payload = normalizeIntake({ raw_text: "交材料", type: "task", title: "交材料", due: "2099-01-01" });
    harness.mutateAudit({ stage: "auth_required", provider_attempted: false, request_payload: payload,
      account_subject: "account-one", lease_expires_at: null, next_retry_at: null });
    const recovered = await (await harness.request({ action: "recover", request_id: first.request_id })).json();
    assert.equal(recovered.results[0].success, true);
    assert.equal(harness.createAttempts(), 1);
    assert.equal(harness.getAudit().stage, "request_verified");
  } finally { harness.restore(); }
});

test("an expired credential during the first context read leaves a frozen request and resumes it once", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ contextAuthFailureOnce: true });
  const input = { raw_text: "2099-01-01 提醒我交材料", type: "task", title: "交材料", requested_date: "2099-01-01" };
  try {
    const firstResponse = await harness.request(input);
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 202);
    assert.equal(first.code, "GOOGLE_REAUTH_REQUIRED");
    assert.equal(harness.getAudit().stage, "auth_required");
    assert.equal(harness.getAudit().provider_attempted, false);
    assert.equal(harness.getAudit().request_payload.context_pending, true);
    assert.equal(harness.createAttempts(), 0);
    const recovered = await (await harness.request({ action: "recover", request_id: first.request_id })).json();
    assert.equal(recovered.results[0].success, true, JSON.stringify(recovered));
    assert.equal(harness.getAudit().request_payload.context_pending, undefined);
    assert.equal(harness.getAudit().account_subject, "account-one");
    assert.equal(harness.createAttempts(), 1);
    assert.equal(harness.getAudit().id, first.request_id);
  } finally { harness.restore(); }
});

test("recovery authorization failure releases its lease and waits for reconnect", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ accountFailureOnCall: 2 });
  try {
    const initial = await (await harness.request({ raw_text: "提醒我交材料", type: "task", title: "交材料", fixed_time: true })).json();
    assert.equal(initial.code, "REMINDER_TIME_REQUIRED");
    const payload = normalizeIntake({ raw_text: "交材料", type: "task", title: "交材料", due: "2099-01-01" });
    harness.mutateAudit({ stage: "received", status: "processing", request_payload: payload,
      lease_owner: null, lease_expires_at: null, next_retry_at: null });
    const recovered = await (await harness.request({ action: "recover", request_id: initial.request_id })).json();
    assert.equal(recovered.results[0].code, "GOOGLE_REAUTH_REQUIRED");
    assert.equal(harness.getAudit().stage, "auth_required");
    assert.equal(harness.getAudit().lease_owner, null);
    assert.equal(harness.getAudit().lease_expires_at, null);
    assert.equal(harness.getAudit().next_retry_at, null);
    assert.equal(harness.createAttempts(), 0);
    const accountAttempts = harness.accountAttempts();
    const background = await (await harness.request({ action: "recover_due" })).json();
    assert.deepEqual(background.results, []);
    assert.equal(harness.accountAttempts(), accountAttempts);
  } finally { harness.restore(); }
});

test("transient projection recovery keeps the verified Task ID and a bounded retry", { concurrency: false }, async () => {
  const task = { id: "task-reminder", title: "交材料", notes: "2099-01-01 15:00提醒我交材料", dueDate: "2099-01-01" };
  const harness = await loadIntakeHandler({ taskResult: { write_success: true, task,
    projection_error: { code: "CALENDAR_SYNC_PENDING" },
    receipt: { task_save_status: "verified", reminder_projection_status: "pending" } },
    projectionFailureOnce: true });
  const input = { raw_text: "2099-01-01 15:00提醒我交材料", type: "task", title: "交材料",
    due: "2099-01-01", requested_date: "2099-01-01", requested_time: "15:00" };
  try {
    const first = await (await harness.request(input)).json();
    assert.equal(first.id, "task-reminder");
    harness.mutateAudit({ next_retry_at: null, lease_expires_at: null });
    const retry = await (await harness.request({ action: "recover", request_id: first.request_id })).json();
    assert.equal(retry.results[0].code, "GOOGLE_PROVIDER_TRANSIENT");
    assert.equal(retry.results[0].object_id, "task-reminder");
    assert.equal(harness.getAudit().stage, "projection_pending");
    assert.equal(harness.getAudit().object_id, "task-reminder");
    assert.equal(harness.getAudit().lease_owner, null);
    assert.ok(Date.parse(harness.getAudit().next_retry_at) > Date.now());
    assert.equal(harness.createAttempts(), 1);
  } finally { harness.restore(); }
});

test("real intake handler answers pure questions without provider or audit writes", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "明天有什么安排？" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.code, "INFORMATION_ONLY");
    assert.equal(body.message, "这是信息查询，未创建任务。");
    assert.equal(harness.writes.length, 0);
  } finally {
    harness.restore();
  }
});

test("real intake handler blocks L3 money operations before any write", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler();
  try {
    const response = await harness.request({ raw_text: "帮我转账 100000 元" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.decision, "ask");
    assert.equal(body.risk_level, "L3");
    assert.equal(harness.writes.length, 0);
  } finally {
    harness.restore();
  }
});

test("short corrections use the provider update route and retain the current task id", { concurrency: false }, async () => {
  const task = { id: "task-current", title: "下午三点开会", notes: "", dueDate: null };
  const harness = await loadIntakeHandler({
    context: { current_task: { ...task, requested_date: "2026-09-06", requested_time: "15:00" }, calendar_events: [], context_warnings: [] },
    taskResult: { write_success: true, task, resolution: { decision: "UPDATE" }, receipt: { reminder_projection_status: "configured" } },
    readTask: { task },
  });
  try {
    const response = await harness.request({ raw_text: "改成四点", context: { current_task: { id: "task-current" } } });
    const body = await response.json();
    const update = taskStatusWrites(harness).find((call) => call.body.action === "update_task");

    assert.equal(body.success, true);
    assert.equal(body.id, "task-current");
    assert.equal(update.body.task_id, "task-current");
    assert.equal(update.body.changes.requested_time, "16:00");
    assert.equal(taskStatusWrites(harness).some((call) => !call.body.action), false);
  } finally {
    harness.restore();
  }
});

test("a failed provider readback never reports a successful write", { concurrency: false }, async () => {
  const created = { write_success: true, task: { id: "task-hotel", title: "订亚朵酒店", notes: "", dueDate: null } };
  const harness = await loadIntakeHandler({ taskResult: created, readTask: { task: { ...created.task, title: "另一家酒店" } } });
  try {
    const response = await harness.request({ raw_text: "订亚朵酒店", type: "task", title: "订亚朵酒店" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, false);
    assert.equal(body.verified, false);
    assert.equal(body.code, "WRITE_UNVERIFIED");
    assert.equal(body.message, "写入结果尚未核实，请回读原任务，勿重复创建。");
  } finally {
    harness.restore();
  }
});

test("mixed current action and lasting preference reports a partial result", { concurrency: false }, async () => {
  const harness = await loadIntakeHandler({ failPreference: true });
  try {
    const response = await harness.request({ raw_text: "这次订亚朵酒店，以后都住亚朵" });
    const body = await response.json();

    assert.equal(body.success, false);
    assert.equal(body.partial, true);
    assert.equal(body.id, "task-hotel");
    assert.equal(body.message, "部分写入完成，请按返回的对象 ID 继续处理未完成部分。");
    assert.ok(harness.goalPlanReads() >= 2);
  } finally {
    harness.restore();
  }
});


for (const type of [undefined, "task"]) {
  test(`voice reminder traverses intake write and readback (type=${type})`, { concurrency: false }, async () => {
    const harness = await loadIntakeHandler({ createReceiptStatus: "configured" });
    try {
      const raw_text = "提醒一下我今天下午四点半有陈明学长的分享，关于怎么做好圆桌的邀约人，如果有时间就参与一下";
      const response = await harness.request({ raw_text, type, title: "参与圆桌邀约人分享",
        due: "2099-10-02", requested_date: "2099-10-02", requested_time: "16:30",
        fixed_time: true, reminder_policy: "smart", timezone: "Asia/Shanghai" });
      const body = await response.json();
      assert.equal(body.write_success, true, JSON.stringify(body));
      assert.equal(body.verified, true);
      assert.equal(body.destination, "google_tasks");
      assert.deepEqual(taskStatusWrites(harness).map(call => call.body.action || "create"), ["autonomy_context", "account_context", "create", "read_task"]);
    } finally { harness.restore(); }
  });
}
for (const raw_text of ["下午四点半有什么安排？", "陈明学长这个分享是什么？", "怎么创建任务？"]) {
  test(`voice information query has zero writes: ${raw_text}`, { concurrency: false }, async () => {
    const harness = await loadIntakeHandler();
    try {
      const body = await (await harness.request({ raw_text })).json();
      assert.equal(body.code, "INFORMATION_ONLY");
      assert.equal(harness.writes.length, 0);
    } finally { harness.restore(); }
  });
}

for(const status of ['completed','cancelled'])test(`actual recover_due marks ${status} terminal and cannot revive Task or Event`,{concurrency:false},async()=>{
 const h=await loadIntakeHandler();try{
 await h.request({raw_text:'明天下午五点处理合成事项',type:'task',title:'Synthetic terminal recovery',requested_date:'2099-10-07',requested_time:'17:00',fixed_time:true,reminder_policy:'custom',reminder_policy_source:'user_explicit',reminder_at:'2099-10-07T17:00',timezone:'Asia/Shanghai'});
 assert.equal(h.getAudit().stage,'projection_pending');h.mutateTask({status});h.mutateAudit({next_retry_at:'2000-01-01T00:00:00Z'});
 const first=await (await h.request({action:'recover_due'})).json();assert.equal(first.results[0].code,'TASK_NO_LONGER_ACTIVE');assert.equal(h.getAudit().stage,'cancelled');
 const writes=h.writes.filter(x=>x.path.endsWith('/functions/v1/task-status')&&['create','retry_projection','update_task'].includes(x.body?.action));
 await h.request({action:'recover_due'});assert.equal(h.createAttempts(),1);assert.equal(h.writes.filter(x=>x.path.endsWith('/functions/v1/task-status')&&['create','retry_projection','update_task'].includes(x.body?.action)).length,writes.length);
 }finally{h.restore()}
});

 test("only explicit recovery can retry proven prewrite rejection with the original request identity",{concurrency:false},async()=>{
  for (const action of ["recover","recover_due"]) {
   const h=await loadIntakeHandler({reconciliationResult:{outcome:"not_written",code:"PREWRITE_REJECTED",account_subject:"account-one"}});
   try {
    const first=await(await h.request({raw_text:"提醒我交材料",type:"task",title:"交材料",fixed_time:true})).json();
    const payload=normalizeIntake({raw_text:"交材料",type:"task",title:"交材料",due:"2099-01-01"});
    h.mutateAudit({stage:"outcome_unknown",status:"processing",provider_attempted:true,account_subject:"account-one",request_payload:payload,object_id:null,target_object_id:null,next_retry_at:null,lease_owner:null,lease_expires_at:null});
    await h.request({action,request_id:first.request_id});
    assert.equal(h.createAttempts(),action==="recover"?1:0);
    assert.equal(h.getAudit().id,first.request_id);
   }finally{h.restore();}
  }
 });
test("lost reservation response returns key and exact lookup stays read-only",{concurrency:false},async()=>{
 const h=await loadIntakeHandler({lostReservationResponse:true});try{
  const r=await(await h.request({raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"})).json();
  assert.equal(r.outcome,"unknown");assert.equal(r.idempotency_key,"integration-key-1");assert.equal(h.createAttempts(),0);
  const before=h.writes.filter(w=>w.method!=="GET").length;
  const exact=await(await h.list("?idempotency_key=integration-key-1")).json();assert.equal(exact.lookup_status,"registered");assert.equal(exact.requests[0].request_id,h.getAudit().id);
  const missing=await(await h.list("?idempotency_key=integration-key-other")).json();assert.equal(missing.lookup_status,"not_registered_at_check");assert.equal(missing.requests.length,0);
  assert.equal(h.createAttempts(),0);assert.ok(h.writes.slice(before).every(w=>!['create','retry_projection'].includes(w.body?.action)));
 }finally{h.restore();}
});
test("concurrent identical requests reserve before context and create once",{concurrency:false},async()=>{
 let release;const gate=new Promise(r=>{release=r});const h=await loadIntakeHandler({contextGate:gate});try{
  const input={raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"};const first=h.request(input);
  for(let n=0;n<50 && !h.getAudit();n++)await new Promise(r=>setTimeout(r,1));
  assert.ok(h.getAudit());assert.equal(h.getAudit().provider_attempted,false);
  const second=await(await h.request(input)).json();assert.equal(second.request_id,h.getAudit().id);assert.equal(second.decision,"leased");assert.equal(second.verified,false);assert.equal(h.createAttempts(),0);
  release();const saved=await(await first).json();assert.equal(saved.verified,true);assert.equal(h.createAttempts(),1);
 }finally{release();h.restore();}
});
test("post-write interruption preserves request id and key for read-only verification",{concurrency:false},async()=>{
 const h=await loadIntakeHandler({unknownCreateOnce:true});try{
  const r=await(await h.request({raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"})).json();assert.equal(r.request_id,h.getAudit().id);assert.equal(r.outcome,"unknown");assert.equal(r.idempotency_key,"integration-key-1");
  const before=h.writes.length;const check=await(await h.list("?idempotency_key=integration-key-1")).json();assert.equal(check.requests[0].task_check.outcome,"verified");assert.equal(h.createAttempts(),1);assert.ok(h.writes.slice(before).every(w=>w.method==="GET" || w.body?.action==="reconcile_intake"));
 }finally{h.restore();}
});
test("exact lookup preserves cancelled request and does not resume it",{concurrency:false},async()=>{
 const h=await loadIntakeHandler();try{
  await h.request({raw_text:"提醒我交材料",type:"task",title:"交材料",fixed_time:true});h.mutateAudit({stage:"cancelled",status:"failed"});const before=h.writes.length;
  const check=await(await h.list("?idempotency_key=integration-key-1")).json();assert.equal(check.requests[0].stage,"cancelled");assert.equal(h.createAttempts(),0);assert.ok(h.writes.slice(before).every(w=>w.method==="GET"));
 }finally{h.restore();}
});

test("malformed intake JSON has a traceable key but does not claim registration or create",{concurrency:false},async()=>{
 const h=await loadIntakeHandler();try{const r=await(await h.malformed()).json();assert.equal(r.success,false);assert.equal(r.idempotency_key,"integration-key-1");assert.equal(r.outcome,"unknown");assert.equal(r.request_id,undefined);assert.equal(h.createAttempts(),0);assert.equal(h.getAudit(),null);}finally{h.restore();}
});

test("same key different input refuses without losing the original request identity or changing its ledger", {concurrency:false}, async()=>{
 const h=await loadIntakeHandler();try{
  const first=await(await h.request({raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"})).json();
  const before=JSON.stringify(h.getAudit());
  const response=await h.request({raw_text:"提醒我准备另一份材料",type:"task",title:"准备另一份材料"});
  const rejected=await response.json();assert.equal(response.status,409);assert.equal(rejected.code,"IDEMPOTENCY_CONFLICT");assert.equal(rejected.outcome,"rejected");assert.equal(rejected.request_id,first.request_id);assert.equal(rejected.idempotency_key,"integration-key-1");assert.equal(rejected.write_success,false);assert.equal(h.createAttempts(),1);assert.equal(JSON.stringify(h.getAudit()),before);
 }finally{h.restore();}
});

test("explicit context cancellation and denial are terminal and recover_due cannot create",{concurrency:false},async()=>{
 for(const code of ["USER_CANCELLED","ACTION_DENIED"]){
  const h=await loadIntakeHandler({contextRefusalCode:code});try{
   const first=await(await h.request({raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"})).json();assert.equal(first.code,code);assert.equal(first.request_id,h.getAudit().id);assert.equal(h.getAudit().stage,code==="USER_CANCELLED"?"cancelled":"unsupported");assert.equal(h.getAudit().next_retry_at,null);
   await h.request({action:"recover_due"});await h.request({action:"recover",request_id:first.request_id});assert.equal(h.createAttempts(),0);assert.equal(h.accountAttempts(),0);
  }finally{h.restore();}
 }
});
test("pure information questions do not persist even when the caller labels them task",{concurrency:false},async()=>{
 for(const type of [undefined,"task"]){const h=await loadIntakeHandler();try{
  const r=await(await h.request({raw_text:"我的提醒功能会不会在手机上提醒？",title:"提醒功能问题",...(type?{type}:{})})).json();assert.equal(r.code,"INFORMATION_ONLY");assert.equal(h.createAttempts(),0);assert.equal(h.getAudit(),null);
 }finally{h.restore();}}
});

test("actual gateways connected to actual intake preserve partial task saves and reject contradictory success",{concurrency:false},async()=>{
 const source=await readFile(new URL("../supabase/functions/personal-os-mcp/index.ts",import.meta.url),"utf8");
 const code=stripTypeScriptTypes(source.slice(source.indexOf("function uncertainIntakeResult("),source.indexOf("async function updateTaskReminder("))+source.slice(source.indexOf("async function captureItem("),source.indexOf("const GOAL_SELECT")));
 for(const method of ["createTask","captureItem"])for(const contradiction of [false,true]){
  const h=await loadIntakeHandler({createReceiptStatus:contradiction?"configured":"not_requested"});try{
   const gateway=new Function("fetch","SUPABASE_URL","WRITE_TOKEN","reminderArguments","intakeConfirmation",code+";return {createTask,captureItem};")(async(_url,init)=>{
    const response=await h.request(JSON.parse(init.body));
    const result=await response.json();assert.equal(result.write_success,true);assert.equal(result.verified,true);assert.equal(result.code,undefined);
    if(contradiction)result.outcome="unknown";
    return json(result,response.status);
   },"https://personal-os.test",h.token,a=>Object.fromEntries(["reminder_policy","reminder_policy_source","reminder_at","reminders"].filter(k=>Object.hasOwn(a,k)).map(k=>[k,a[k]])),()=>"pending");
   const r=await gateway[method]({raw_text:"提醒我2099年1月1日下午四点交材料",title:"交材料",type:"task",due:"2099-01-01",requested_date:"2099-01-01",requested_time:"16:00",fixed_time:true,reminder_policy:"custom",reminder_policy_source:"user_explicit",reminder_at:"2099-01-01T15:00",timezone:"Asia/Shanghai",idempotency_key:"integration-key-1"});
   assert.equal(r.isError,true);assert.equal(r.structuredContent.success,false);assert.equal(r.structuredContent.outcome,"partial");assert.equal(r.structuredContent.id,"task-hotel");assert.equal(r.structuredContent.request_id,h.getAudit().id);assert.equal(r.structuredContent.write_success,true);assert.equal(r.structuredContent.verified,true);assert.equal(r.structuredContent.receipt.task_save_status,"verified");assert.equal(h.createAttempts(),1);
  }finally{h.restore();}
 }
});

test("opaque prewrite interruption stays unknown and does not auto-create on background recovery",{concurrency:false},async()=>{
 const h=await loadIntakeHandler({contextRefusalCode:"INTAKE_INTERRUPTED"});try{
  const first=await(await h.request({raw_text:"订亚朵酒店",type:"task",title:"订亚朵酒店"})).json();assert.equal(first.outcome,"unknown");assert.equal(h.getAudit().stage,"received");h.mutateAudit({next_retry_at:null,lease_owner:null,lease_expires_at:null});
  const background=await(await h.request({action:"recover_due"})).json();assert.equal(background.results[0].code,"USER_CONTINUATION_REQUIRED");assert.equal(h.createAttempts(),0);
  await h.request({action:"recover",request_id:first.request_id});assert.equal(h.createAttempts(),1);
 }finally{h.restore();}
});
