import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalIntake,
  destinationFor,
  normalizeIntake,
  taskDispatchPayload,
} from "../supabase/functions/_shared/personal-os-intake.js";

const baseDate = "2026-09-04T08:00:00+08:00";

test("normalizes the Issue #1 task contract", () => {
  const intake = normalizeIntake({
    source: "chatgpt",
    raw_text: "明天提醒我安排小青蛙寄养。",
    type: "task",
    title: "安排小青蛙寄养",
    notes: "联系乔治安排寄养。",
    due: "2026-09-05",
    timezone: "Asia/Shanghai",
  }, { baseDate });
  assert.equal(intake.destination, "google_tasks");
  assert.equal(intake.due, "2026-09-05");
  assert.deepEqual(taskDispatchPayload(intake), {
    title: "安排小青蛙寄养",
    notes: "联系乔治安排寄养。",
    dueDate: "2026-09-05",
    originalIntent: "明天提醒我安排小青蛙寄养。",
    source: "chatgpt",
  });
});

test("classifies all non-task destinations without dispatching them as tasks", () => {
  assert.equal(normalizeIntake({ raw_text: "9月8日上午11点广州飞哈尔滨" }, { baseDate }).type, "calendar_event");
  assert.equal(normalizeIntake({ raw_text: "袁老师可以对接三一重工" }, { baseDate }).type, "project_data");
  assert.equal(normalizeIntake({ raw_text: "记住普通待办进入 Google Tasks" }, { baseDate }).type, "knowledge");
  assert.equal(normalizeIntake({ raw_text: "每天晚上搜索比亚迪最新情况并分析" }, { baseDate }).type, "gpt_job");
  assert.equal(destinationFor("calendar_event"), "google_calendar");
  assert.equal(destinationFor("gpt_job"), "gpt_schedule");
});

test("rejects invalid types and dates", () => {
  assert.throws(() => normalizeIntake({ raw_text: "测试", type: "email" }), /type must be one of/);
  assert.throws(() => normalizeIntake({ raw_text: "测试", type: "task", due: "2026-02-30" }), /YYYY-MM-DD/);
});

test("canonical intake is stable and excludes transient fields", () => {
  const intake = normalizeIntake({ raw_text: "下周跟袁老师确认三一重工的对接", type: "task", due: "2026-09-07" });
  assert.equal(canonicalIntake(intake), canonicalIntake({ ...intake, confidence: 0.1, payload: { ignored: true } }));
});
