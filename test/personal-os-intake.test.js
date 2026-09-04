import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalIntake,
  destinationFor,
  goalPlanDispatchPayload,
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
    schedule: {
      scheduled_date: "2026-09-05",
      scheduled_start: null,
      scheduled_end: null,
      timezone: "Asia/Shanghai",
      duration_minutes: 30,
      scheduling_status: "unscheduled",
      scheduling_source: "explicit_user",
      calendar_id: "primary",
      fixed_time: false,
      priority: "medium",
      deadline: null,
    },
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

test("normalizes a scheduled task for Task creation plus Calendar projection", () => {
  const intake = normalizeIntake({ raw_text: "明天下午3点做导出 ChatGPT 历史数据，预计45分钟" }, { baseDate });
  assert.equal(intake.type, "task");
  assert.equal(intake.requested_date, "2026-09-05");
  assert.equal(intake.requested_time, "15:00");
  assert.equal(intake.schedule.scheduled_end, "15:45");
  assert.equal(intake.schedule.fixed_time, true);
});

test("auto-classifies and normalizes a Goal without inventing a deadline", () => {
  const intake = normalizeIntake({ raw_text: "2027 年完成家庭住房升级", why: "让家庭长期居住更稳定" }, { baseDate });
  assert.equal(intake.type, "goal");
  assert.equal(intake.destination, "goals_plans");
  assert.equal(intake.target_year, 2027);
  assert.equal(intake.horizon, "long");
  assert.equal(intake.deadline, null);
  assert.deepEqual(goalPlanDispatchPayload(intake), {
    title: intake.title,
    description: "2027 年完成家庭住房升级",
    why: "让家庭长期居住更稳定",
    type: "Goal",
    category: "Property",
    status: "Planning",
    horizon: "long",
    priority: "medium",
    progress_percent: 0,
    target_date: null,
    target_month: null,
    target_year: 2027,
    start_date: null,
    review_date: null,
    deadline: null,
    amount_total: null,
    amount_completed: 0,
    currency: "CNY",
    counterparty: null,
    financial_type: null,
    client_id: null,
    contact_id: null,
    company_id: null,
    notes: "",
    original_input: "2027 年完成家庭住房升级",
  });
});

test("auto-classifies a receivable and preserves the original wording", () => {
  const intake = normalizeIntake({ raw_text: "小斌还欠我3万块" }, { baseDate });
  const payload = goalPlanDispatchPayload(intake);
  assert.equal(intake.type, "financial_item");
  assert.equal(payload.financial_type, "Receivable");
  assert.equal(payload.amount_total, 30000);
  assert.equal(payload.counterparty, "小斌");
  assert.equal(payload.original_input, "小斌还欠我3万块");
});

test("rejects conflicting target precision", () => {
  assert.throws(() => normalizeIntake({
    raw_text: "买房",
    type: "goal",
    target_year: 2027,
    target_date: "2027-06-01",
  }), /one target precision/);
});

test("normalizes an explicit medium-term Goal and an existing Goal update hint", () => {
  const intake = normalizeIntake({
    raw_text: "把这个放进我的中期 Goal & Plan",
    type: "goal",
    title: "财务岗位经营化转型",
    horizon: "medium",
    existing_goal_id: "11111111-1111-4111-8111-111111111111",
  }, { baseDate });
  assert.equal(intake.horizon, "medium");
  assert.equal(intake.existing_goal_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(intake.explicit_fields.horizon, true);
  assert.equal(goalPlanDispatchPayload(intake).horizon, "medium");
});

test("a concrete Task can carry only a Goal relation id without becoming a Goal", () => {
  const intake = normalizeIntake({
    raw_text: "下周把财务销售提成方案整理出来",
    type: "task",
    title: "整理财务销售提成方案",
    goal_plan_id: "11111111-1111-4111-8111-111111111111",
  }, { baseDate });
  assert.equal(intake.type, "task");
  assert.equal(intake.goal_plan_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(intake.existing_goal_id, null);
});
