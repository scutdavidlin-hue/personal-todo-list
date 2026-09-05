import test from "node:test";
import assert from "node:assert/strict";
import { confirmationForWrite, evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";

const baseDate = "2026-09-05T09:00:00+08:00";

test("PRD 1: a clear hotel action executes without asking for missing hotel or time", () => {
  const result = evaluateAutonomy({
    raw_text: "帮我订哈尔滨的酒店",
    context: {
      conversation_trips: [{ title: "哈尔滨旅行", start_date: "2026-09-08", end_date: "2026-09-12" }],
    },
  }, { baseDate });

  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "execute");
  assert.equal(result.question, null);
  assert.equal(result.input.type, "task");
  assert.equal(result.input.requested_date, "2026-09-08");
  assert.equal(result.input.requested_time, undefined);
  assert.equal(result.input.notes, "帮我订哈尔滨的酒店");
  assert.equal(result.input.deadline, undefined);
});

test("PRD 2: an information question does not create a task", () => {
  const result = evaluateAutonomy({ raw_text: "哈尔滨这周天气怎么样？" }, { baseDate });

  assert.equal(result.intent, "information");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "information");
  assert.equal(result.input.type, undefined);
  assert.equal(result.input.requested_date, undefined);
});

test("PRD exact information text without punctuation remains information", () => {
  const result = evaluateAutonomy({ raw_text: "亚朵酒店一般有没有梳子" }, { baseDate });

  assert.equal(result.intent, "information");
  assert.equal(result.decision, "information");
  assert.equal(result.input.type, undefined);
});

test("PRD 2 scheduled statement: Chinese afternoon time is an actionable task", () => {
  const result = evaluateAutonomy({ raw_text: "翔辉下午三点过来" }, { baseDate });

  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "execute");
  assert.equal(result.input.type, "task");
  assert.equal(result.input.title, "翔辉过来");
  assert.equal(result.input.requested_date, "2026-09-05");
  assert.equal(result.input.requested_time, "15:00");
});

test("PRD 3: a pure future preference becomes a plan", () => {
  const result = evaluateAutonomy({ raw_text: "以后旅行尽量住亚朵" }, { baseDate });

  assert.equal(result.intent, "preference");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "execute");
  assert.equal(result.preference_text, null);
  assert.equal(result.input.type, "plan");
  assert.equal(result.input.requested_date, undefined);
});

test("PRD 4: a preference plus a current trip splits the preference from the task", () => {
  const result = evaluateAutonomy({
    raw_text: "以后旅行尽量住亚朵，这次去哈尔滨帮我订一家酒店",
    context: {
      travel_plans: [{ title: "哈尔滨旅行", start_date: "2026-09-08", end_date: "2026-09-12" }],
    },
  }, { baseDate });

  assert.equal(result.intent, "mixed");
  assert.equal(result.decision, "execute");
  assert.equal(result.preference_text, "以后旅行尽量住亚朵");
  assert.equal(result.input.type, "task");
  assert.equal(result.input.raw_text, "以后旅行尽量住亚朵，这次去哈尔滨帮我订一家酒店");
  assert.equal(result.input.requested_date, "2026-09-08");
  assert.equal(result.input.notes, "以后旅行尽量住亚朵，这次去哈尔滨帮我订一家酒店");
});

test("PRD exact mixed shorthand expands the lasting rule into this trip task", () => {
  const result = evaluateAutonomy({ raw_text: "以后旅游入住酒店都提醒我检查充电器，这次东北旅行也这样" }, { baseDate });

  assert.equal(result.intent, "mixed");
  assert.equal(result.decision, "execute");
  assert.equal(result.preference_text, "以后旅游入住酒店都提醒我检查充电器");
  assert.equal(result.input.type, "task");
  assert.equal(result.input.raw_text, "以后旅游入住酒店都提醒我检查充电器，这次东北旅行也这样");
  assert.equal(result.input.notes, "以后旅游入住酒店都提醒我检查充电器，这次东北旅行也这样");
});

test("PRD 5: an ordinary contract reminder is a task rather than contract execution", () => {
  const result = evaluateAutonomy({ raw_text: "明天提醒我检查购房合同" }, { baseDate });

  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "execute");
  assert.equal(result.input.requested_date, "2026-09-06");
});

test("PRD 6: real major money, property, and critical deletion operations require confirmation", () => {
  const cases = [
    "把100万元转账给卖家",
    "卖掉这套房子",
    "删除全部生产数据库备份",
  ];

  for (const raw_text of cases) {
    const result = evaluateAutonomy({ raw_text, risk_level: "L1", confirmed: true }, { baseDate });
    assert.equal(result.intent, "action", raw_text);
    assert.equal(result.risk_level, "L3", raw_text);
    assert.equal(result.decision, "ask", raw_text);
    assert.ok(result.question, raw_text);
  }
});

test("PRD exact property purchase is L3 and date numbers do not hide money amounts", () => {
  const property = evaluateAutonomy({ raw_text: "明天买套400万的房子" }, { baseDate });
  const money = evaluateAutonomy({ raw_text: "9月10日转账100万元给卖家" }, { baseDate });

  assert.equal(property.risk_level, "L3");
  assert.equal(property.decision, "ask");
  assert.equal(money.risk_level, "L3");
  assert.equal(money.decision, "ask");
});

test("only material ambiguity asks; an unspecified pronoun target does", () => {
  const result = evaluateAutonomy({ raw_text: "把它删掉" }, { baseDate });

  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L2");
  assert.equal(result.decision, "ask");
});

test("explicit dates beat context, and travel context does not date unrelated work", () => {
  const context = {
    conversation_trips: [{ title: "哈尔滨旅行", start_date: "2026-09-08", end_date: "2026-09-12" }],
  };
  const explicit = evaluateAutonomy({ raw_text: "9月10日帮我订酒店", context }, { baseDate });
  const unrelated = evaluateAutonomy({ raw_text: "整理合同", context }, { baseDate });

  assert.equal(explicit.input.requested_date, "2026-09-10");
  assert.equal(unrelated.input.requested_date, "2026-09-05");
  assert.equal(unrelated.input.deadline, undefined);
});

test("bare next week resolves to the next Monday", () => {
  const result = evaluateAutonomy({ raw_text: "下周提醒我整理行李" }, { baseDate });
  assert.equal(result.input.requested_date, "2026-09-07");
});

test("exact PRD accounting wording is an ordinary task", () => {
  const result = evaluateAutonomy({ raw_text: "下周跟佳佳对一下账" }, { baseDate });
  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L1");
  assert.equal(result.decision, "execute");
  assert.equal(result.input.type, "task");
  assert.equal(result.input.requested_date, "2026-09-07");
});

test("exact PRD missing-item reminder asks for the outcome-changing object", () => {
  const result = evaluateAutonomy({
    raw_text: "明天记得提醒我把这个东西带去公司",
    context: { calendar_events: [{ title: "去公司", start_date: "2026-09-06", end_date: "2026-09-06" }] },
  }, { baseDate });
  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L2");
  assert.equal(result.decision, "ask");
});

test("exact PRD hotel reminder asks what vague object to process", () => {
  const result = evaluateAutonomy({
    raw_text: "到酒店以后提醒我处理一下这个",
    context: { conversation_trips: [{ title: "东北旅行", start_date: "2026-09-08", end_date: "2026-09-12" }] },
  }, { baseDate });
  assert.equal(result.intent, "action");
  assert.equal(result.risk_level, "L2");
  assert.equal(result.decision, "ask");
});

test("structured date-only and deadline-only inputs preserve their meanings", () => {
  const dated = evaluateAutonomy({ raw_text: "整理材料", requested_date: "2026-09-09" }, { baseDate });
  const deadline = evaluateAutonomy({ raw_text: "提交合同", deadline: "2026-09-10" }, { baseDate });
  const textualDeadline = evaluateAutonomy({ raw_text: "9月11日前提交合同" }, { baseDate });

  assert.equal(dated.input.requested_date, "2026-09-09");
  assert.equal(dated.input.deadline, undefined);
  assert.equal(deadline.input.deadline, "2026-09-10");
  assert.equal(deadline.input.requested_date, undefined);
  assert.equal(textualDeadline.input.requested_date, undefined);
  assert.equal(textualDeadline.input.deadline, undefined);
});

test("short time changes preserve the current task and its afternoon convention", () => {
  const context = {
    current_task: {
      id: "task-123",
      title: "和供应商开会",
      requested_date: "2026-09-08",
      requested_time: "15:00",
      notes: "讨论交付",
    },
  };
  const four = evaluateAutonomy({ raw_text: "改成四点", context }, { baseDate });
  const three = evaluateAutonomy({ raw_text: "还是三点", context }, { baseDate });

  assert.equal(four.decision, "execute");
  assert.equal(four.input.existing_task_id, "task-123");
  assert.deepEqual(four.input.update_patch, { requested_time: "16:00" });
  assert.equal(four.input.title, "和供应商开会");
  assert.deepEqual(three.input.update_patch, {});
});

test("dinner cancellation removes only the dinner clause from the current task", () => {
  const result = evaluateAutonomy({
    raw_text: "晚饭取消，会议保留",
    context: {
      current_task: {
        id: "task-456",
        title: "下午三点和王总开会，晚上一起吃晚饭",
        notes: "下午三点和王总开会，晚上一起吃晚饭",
        requested_date: "2026-09-08",
        requested_time: "15:00",
      },
    },
  }, { baseDate });

  assert.equal(result.decision, "execute");
  assert.equal(result.input.existing_task_id, "task-456");
  assert.deepEqual(result.input.update_patch, { title: "下午三点和王总开会", notes: "下午三点和王总开会" });
});

test("exact dinner cancellation wording removes dinner from current task notes too", () => {
  const result = evaluateAutonomy({
    raw_text: "晚上不一起吃饭了，他有饭局",
    context: {
      current_task: {
        id: "task-xianghui",
        title: "翔辉下午三点过来，晚上一起吃饭",
        notes: "翔辉下午三点过来，晚上一起吃饭",
        requested_date: "2026-09-05",
        requested_time: "15:00",
      },
    },
  }, { baseDate });

  assert.equal(result.decision, "execute");
  assert.equal(result.input.raw_text, "晚上不一起吃饭了，他有饭局");
  assert.deepEqual(result.input.update_patch, { title: "翔辉下午三点过来", notes: "翔辉下午三点过来" });
});

test("existing normalized intake fields survive while untrusted policy claims and patches are stripped", () => {
  const result = evaluateAutonomy({
    raw_text: "明天整理项目材料",
    type: "task",
    goal_plan_id: "goal-1",
    reminder_policy: "smart",
    priority: "high",
    timezone: "Asia/Shanghai",
    resources: ["project-db"],
    task_type: "work",
    risk_level: "L3",
    confirmed: true,
    write_success: true,
    verified: true,
    update_patch: { title: "untrusted" },
  }, { baseDate });

  assert.equal(result.input.goal_plan_id, "goal-1");
  assert.equal(result.input.reminder_policy, "smart");
  assert.equal(result.input.priority, "high");
  assert.equal(result.input.timezone, "Asia/Shanghai");
  assert.deepEqual(result.input.resources, ["project-db"]);
  assert.equal(result.input.task_type, "work");
  assert.equal(result.input.risk_level, undefined);
  assert.equal(result.input.confirmed, undefined);
  assert.equal(result.input.write_success, undefined);
  assert.equal(result.input.verified, undefined);
  assert.equal(result.input.update_patch, undefined);
});

test("established router destinations remain intact", () => {
  const gptJob = evaluateAutonomy({ raw_text: "每天搜索行业新闻并汇总" }, { baseDate });
  const financial = evaluateAutonomy({ raw_text: "小斌还欠我3万块" }, { baseDate });
  const goal = evaluateAutonomy({ raw_text: "2027年完成家庭住房升级" }, { baseDate });

  assert.equal(gptJob.input.type, "gpt_job");
  assert.equal(financial.input.type, "financial_item");
  assert.equal(financial.input.amountTotal, 30000);
  assert.equal(goal.input.type, "goal");
  assert.equal(goal.input.targetYear, 2027);
});

test("write confirmation requires strict success, verification, and an id", () => {
  assert.equal(confirmationForWrite({ write_success: true, verified: true, id: "task-789" }), "已经写进去了");
  assert.equal(confirmationForWrite({ write_success: true, verified: true }), "没有写进去");
  assert.equal(confirmationForWrite({ write_success: true, id: "task-789" }), "没有写进去");
  assert.equal(confirmationForWrite({ write_success: "true", verified: true, id: "task-789" }), "没有写进去");
  assert.equal(confirmationForWrite({ write_success: true }), "没有写进去");
  assert.equal(confirmationForWrite({ success: true, verified: true, id: "task-789" }), "没有写进去");
  assert.equal(confirmationForWrite({ noop: true }), "没有执行写入");
  assert.equal(confirmationForWrite({ write_success: false, error: "API rejected the write" }), "没有写进去：API rejected the write");
});
test("a correction without a current task asks instead of creating a replacement", () => {
  const result = evaluateAutonomy({ raw_text: "改成四点。" });
  assert.equal(result.decision, "ask");
  assert.equal(result.risk_level, "L2");
});

test("a compound high-risk action cannot bypass confirmation through a time correction", () => {
  const result = evaluateAutonomy({ raw_text: "签署购房合同并改成四点", context: { current_task: { id: "meeting", requested_time: "15:00" } } });
  assert.equal(result.decision, "ask");
  assert.equal(result.risk_level, "L3");
});

test("partial cancellation also removes dinner only recorded in notes", () => {
  const result = evaluateAutonomy({ raw_text: "晚上不一起吃饭了，他有饭局。", context: { current_task: { id: "meeting", title: "翔辉到公司", notes: "下午核对资料，晚上一起吃饭" } } });
  assert.equal(result.input.existing_task_id, "meeting");
  assert.equal(result.input.update_patch.title, undefined);
  assert.equal(result.input.update_patch.notes, "下午核对资料");
});
