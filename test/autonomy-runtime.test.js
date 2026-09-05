import assert from "node:assert/strict";
import test from "node:test";

import {
  intakeConfirmation,
  prepareAutonomousIntake,
  verifyTaskWrite,
} from "../supabase/functions/_shared/autonomy-runtime.js";

const clearTask = {
  raw_text: "明天提醒我订亚朵酒店",
  type: "task",
  title: "订亚朵酒店",
};

test("prepareAutonomousIntake resolves provider context for a clear low-risk action", async () => {
  const calls = [];
  const result = await prepareAutonomousIntake(clearTask, {
    resolveContext: async (input) => {
      calls.push(input);
      return { travel_plans: [{ id: "trip-1", title: "哈尔滨出差" }] };
    },
  });

  assert.deepEqual(calls, [clearTask]);
  assert.equal(result.decision, "execute");
  assert.equal(result.input.context.travel_plans[0].id, "trip-1");
});

test("prepareAutonomousIntake skips provider context for information and L3 requests", async () => {
  let calls = 0;
  const adapter = { resolveContext: async () => { calls += 1; return {}; } };

  const information = await prepareAutonomousIntake({ raw_text: "明天有什么安排？" }, adapter);
  const highRisk = await prepareAutonomousIntake({ raw_text: "帮我转账 100000 元" }, adapter);

  assert.equal(information.intent, "information");
  assert.equal(highRisk.risk_level, "L3");
  assert.equal(calls, 0);
});

test("prepareAutonomousIntake stops when provider context cannot be read", async () => {
  await assert.rejects(
    prepareAutonomousIntake(clearTask, {
      resolveContext: async () => { throw new Error("provider context unavailable"); },
    }),
    /provider context unavailable/,
  );
});

test("verifyTaskWrite accepts only an exact provider readback", async () => {
  const result = {
    write_success: true,
    task: { id: "task-1", title: "订亚朵酒店", notes: "靠近会场", dueDate: "2026-09-06" },
  };
  const verified = await verifyTaskWrite(result, async (id) => ({ task: { ...result.task, id } }));

  assert.deepEqual(verified, { task: result.task, verified: true, write_success: true });
});

test("verifyTaskWrite rejects a missing write id and mismatched or missing readback", async () => {
  await assert.rejects(
    verifyTaskWrite({ task: { title: "订酒店" } }, async () => ({ task: {} })),
    /did not return an id/,
  );

  const result = { task: { id: "task-1", title: "订酒店", notes: "", dueDate: null } };
  for (const readback of [
    undefined,
    { task: null },
    { task: { ...result.task, id: "task-2" } },
    { task: { ...result.task, title: "改订酒店" } },
    { task: { ...result.task, notes: "不同备注" } },
    { task: { ...result.task, dueDate: "2026-09-07" } },
  ]) {
    await assert.rejects(
      verifyTaskWrite(result, async () => readback),
      /readback did not match/,
    );
  }
});

test("verifyTaskWrite propagates provider read failures", async () => {
  await assert.rejects(
    verifyTaskWrite({ task: { id: "task-1", title: "订酒店" } }, async () => {
      throw new Error("provider read failed");
    }),
    /provider read failed/,
  );
});

test("intakeConfirmation reports information, partial writes, and verified reuse distinctly", () => {
  assert.equal(intakeConfirmation({ intent: "information" }), "这是信息查询，未创建任务。");
  assert.equal(intakeConfirmation({ partial: true, id: "task-1" }), "部分写入完成，请按返回的对象 ID 继续处理未完成部分。");
  assert.equal(intakeConfirmation({ operation: "reused", verified: true, id: "task-1" }), "现有任务已核对，无需重复创建。");
  assert.equal(
    intakeConfirmation({ write_success: true, verified: false, id: "task-1", error: "Google Tasks 写入结果尚未核实" }),
    "写入结果尚未核实，请回读原任务，勿重复创建。",
  );
});

test("time-only mutations require schedule readback as well as task identity", async () => {
  const result = { write_success: true, task: { id: "task-1", title: "翔辉到公司" }, expected_schedule: { scheduled_start: "16:00" } };
  await assert.rejects(verifyTaskWrite(result, async () => ({ task: result.task, schedule: { scheduled_start: "15:00:00" } })), /schedule readback/);
  const verified = await verifyTaskWrite(result, async () => ({ task: result.task, schedule: { scheduled_start: "16:00:00" } }));
  assert.equal(verified.verified, true);
});
