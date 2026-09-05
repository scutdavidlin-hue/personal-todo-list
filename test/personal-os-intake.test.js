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
  const dispatched = taskDispatchPayload(intake);
  assert.equal(dispatched.title, "安排小青蛙寄养");
  assert.equal(dispatched.notes, "联系乔治安排寄养。");
  assert.equal(dispatched.dueDate, "2026-09-05");
  assert.equal(dispatched.originalIntent, "明天提醒我安排小青蛙寄养。");
  assert.equal(dispatched.source, "chatgpt");
  assert.equal(dispatched.schedule.scheduled_date, "2026-09-05");
  assert.equal(dispatched.schedule.scheduled_start, null);
  assert.equal(dispatched.schedule.deadline_time, null);
  assert.equal(dispatched.schedule.reminder_policy, "none");
  assert.deepEqual(dispatched.schedule.reminders, []);
});

test("classifies all non-task destinations without dispatching them as tasks", () => {
  assert.equal(normalizeIntake({ raw_text: "只加到日历：9月8日上午11点广州飞哈尔滨" }, { baseDate }).type, "calendar_event");
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
  assert.equal(intake.schedule.reminder_policy, "smart");
  assert.equal(intake.schedule.reminders[0].type, "preparation");
});

test("a timed flight becomes one Task schedule with Smart Reminder context", () => {
  const intake = normalizeIntake({ raw_text: "15:00去机场" }, { baseDate });
  assert.equal(intake.type, "task");
  assert.equal(intake.due, "2026-09-04");
  assert.equal(intake.requested_date, "2026-09-04");
  assert.equal(intake.requested_time, "15:00");
  assert.equal(intake.schedule.reminder_context.task_kind, "flight");
  assert.deepEqual(intake.schedule.reminders.map((item) => item.type), ["preparation", "departure"]);
});

test("the PRD acceptance meeting defaults to one hour and contextual reminders", () => {
  const intake = normalizeIntake({
    raw_text: "今天下午3点祥晖到公司聊天。起床吃早餐，然后运动一下，再自己坐地铁去公司。不让我老婆送。",
  }, { baseDate: "2026-09-05T08:00:00+08:00" });
  assert.equal(intake.type, "task");
  assert.equal(intake.title, "祥晖到公司聊天");
  assert.equal(intake.requested_date, "2026-09-05");
  assert.equal(intake.schedule.scheduled_start, "15:00");
  assert.equal(intake.schedule.scheduled_end, "16:00");
  assert.equal(intake.schedule.reminder_context.transportation, "metro");
  assert.deepEqual(intake.schedule.reminders.map((item) => item.type), ["preparation", "departure"]);
});

test("an exact deadline does not become a Task date or execution time", () => {
  const intake = normalizeIntake({ raw_text: "今天18:00之前把材料发出去" }, { baseDate });
  assert.equal(intake.due, null);
  assert.equal(intake.requested_date, null);
  assert.equal(intake.requested_time, null);
  assert.equal(intake.deadline, "2026-09-04");
  assert.equal(intake.deadline_time, "18:00");
  assert.equal(intake.schedule.reminder_context.task_kind, "deadline");
});

test("explicit intake separates execution, reminder, and deadline clocks", () => {
  const intake = normalizeIntake({
    raw_text: "今天15:00开始整理材料，12:00提醒我，18:00截止",
    type: "task",
    title: "整理材料",
  }, { baseDate });
  assert.equal(intake.due, "2026-09-04");
  assert.equal(intake.requested_time, "15:00");
  assert.equal(intake.deadline, "2026-09-04");
  assert.equal(intake.deadline_time, "18:00");
  assert.equal(intake.schedule.reminder_at, "2026-09-04T12:00");
  assert.equal(intake.schedule.reminder_policy_source, "user_explicit");
});

test("a structured deadline does not leak into Google Task due", () => {
  const intake = normalizeIntake({
    raw_text: "把材料发出去",
    type: "task",
    title: "发送材料",
    due: "2026-09-05",
    deadline: "2026-09-05",
    deadline_time: "18:00",
  }, { baseDate });
  assert.equal(intake.due, null);
  assert.equal(intake.requested_date, null);
  assert.equal(intake.deadline, "2026-09-05");
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

test("task intake preserves graph and shared-resource hints for resolution", () => {
  const intake = normalizeIntake({
    raw_text: "佳佳给成本后分析财务数据",
    type: "task",
    project_id: "22222222-2222-4222-8222-222222222222",
    resources: ["financial_records", "financial_records"],
    read_resources: ["financial_records"],
    resource_fields: ["cost"],
    depends_on_task_ids: ["google-task-1"],
  });
  assert.equal(intake.project_id, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(intake.resources, ["financial_records"]);
  assert.deepEqual(intake.depends_on_task_ids, ["google-task-1"]);
  const dispatched = taskDispatchPayload(intake);
  assert.deepEqual(dispatched.read_resources, ["financial_records"]);
  assert.deepEqual(dispatched.resource_fields, ["cost"]);
});
