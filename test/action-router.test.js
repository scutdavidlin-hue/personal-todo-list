import test from "node:test";
import assert from "node:assert/strict";
import { classifyAction } from "../supabase/functions/_shared/action-router.js";

const baseDate = "2026-09-04T08:00:00+08:00";

test("an actionable Sunday reminder routes to Google Tasks with a due date", () => {
  const route = classifyAction("周日记得收拾东北旅行的行李", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.title, "收拾东北旅行的行李");
  assert.equal(route.payload.dueDate, "2026-09-06");
  assert.equal(route.payload.originalIntent, "周日记得收拾东北旅行的行李");
});

test("a scheduled flight routes to Calendar rather than Tasks", () => {
  const route = classifyAction("2026年9月8日上午11点飞哈尔滨", { baseDate });
  assert.equal(route.type, "calendar_event");
  assert.equal(route.payload.date, "2026-09-08");
  assert.equal(route.payload.time, "11:00");
  assert.equal(route.payload.start, "2026-09-08T11:00:00+08:00");
});

test("a customer relationship fact routes to project data", () => {
  const route = classifyAction("袁老师可以对接三一重工", { baseDate });
  assert.equal(route.type, "project_data");
});

test("the domain review follow-up is a Task due next weekend", () => {
  const route = classifyAction("下周末提醒我查看域名审核结果", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.title, "查看域名审核结果");
  assert.equal(route.payload.dueDate, "2026-09-13");
});

test("a conversational domain check still routes to Tasks", () => {
  const route = classifyAction("下周末帮我再查一次 nou.aliyun.com 域名状态", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.dueDate, "2026-09-13");
});

test("a recurring research request routes to a GPT job", () => {
  const route = classifyAction("每天晚上帮我搜索比亚迪和招商南油最新情况并分析", { baseDate });
  assert.equal(route.type, "gpt_job");
});

test("a durable fact routes to knowledge", () => {
  const route = classifyAction("记住：普通待办只进入 Google Tasks", { baseDate });
  assert.equal(route.type, "knowledge");
});

test("an explicit task time remains a Task and carries schedule metadata", () => {
  const route = classifyAction("明天下午3点做导出 ChatGPT 历史数据，预计45分钟", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.dueDate, "2026-09-05");
  assert.equal(route.payload.requestedDate, "2026-09-05");
  assert.equal(route.payload.requestedTime, "15:00");
  assert.equal(route.payload.estimatedDuration, 45);
  assert.equal(route.payload.fixedTime, true);
});

test("a deadline is separated from a requested execution date", () => {
  const route = classifyAction("9月8日出发之前把行李收拾完成", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.deadline, "2026-09-08");
  assert.equal(route.payload.requestedDate, null);
});

test("a future housing outcome routes to Goal rather than Task", () => {
  const route = classifyAction("2027 年完成家庭住房升级", { baseDate });
  assert.equal(route.type, "goal");
  assert.equal(route.payload.targetYear, 2027);
  assert.equal(route.payload.category, "Property");
});

test("a medium-term product direction routes to Plan", () => {
  const route = classifyAction("10–11月开始做 To C 产品", { baseDate });
  assert.equal(route.type, "plan");
  assert.equal(route.payload.category, "Business");
});

test("a receivable fact routes to a durable Financial Item", () => {
  const route = classifyAction("小斌还欠我3万块", { baseDate });
  assert.equal(route.type, "financial_item");
  assert.equal(route.payload.title, "小斌欠款");
  assert.equal(route.payload.financialType, "Receivable");
  assert.equal(route.payload.amountTotal, 30000);
});

test("a dated collection action remains a Task", () => {
  const route = classifyAction("2026-09-07 催小斌归还 10,000 元旅游经费", { baseDate });
  assert.equal(route.type, "task");
  assert.equal(route.payload.dueDate, "2026-09-07");
});

test("a contact detail does not enter Goals & Plans", () => {
  const route = classifyAction("小斌电话是 13800138000", { baseDate });
  assert.equal(route.type, "contact");
});
