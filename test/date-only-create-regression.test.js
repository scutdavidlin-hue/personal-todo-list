import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { normalizeIntake, taskDispatchPayload } from "../supabase/functions/_shared/personal-os-intake.js";
import { frozenIntake, isMissed } from "../supabase/functions/_shared/request-recovery.js";

// These desired-behavior assertions were RED on bb240517. They now guard the
// isolated repair; passing tests do not establish a production deployment.
const receivedAt = "2026-10-14T06:00:00Z";
const target = "2026-11-01";
function creation(raw_text, dates) {
  const input = { type: "task", title: "整理虚构资料", raw_text,
    requested_time: null, fixed_time: false, reminder_policy: "none", ...dates };
  const policy = evaluateAutonomy(input, { baseDate: receivedAt });
  assert.equal(policy.decision, "execute");
  return normalizeIntake(frozenIntake(policy.input, receivedAt), { baseDate: receivedAt });
}
function assertDateOnly(intake) {
  assert.equal(intake.due, target);
  assert.equal(intake.requested_date, target);
  assert.equal(intake.schedule.scheduled_date, target);
  assert.equal(intake.requested_time, null);
  assert.equal(intake.schedule.scheduled_start, null);
  assert.equal(intake.schedule.reminder_policy, "none");
  assert.deepEqual(intake.schedule.reminders, []);
  assert.equal(isMissed(intake, new Date(receivedAt)), false);
  assert.equal(taskDispatchPayload(intake).dueDate, target);
}

test("explicit due-only date survives a month-start window and no clock", () => {
  assertDateOnly(creation("11月初整理虚构资料，无时刻，不要弹窗", { due: target }));
});
test("explicit due-only date survives wording without any date", () => {
  assertDateOnly(creation("整理虚构资料，无时刻，不要弹窗", { due: target }));
});
test("explicit requested_date-only date remains date-only", () => {
  assertDateOnly(creation("11月初整理虚构资料，无时刻，不要弹窗", { requested_date: target }));
});
test("matching due/requested_date preserve a precise November 1 date", () => {
  assertDateOnly(creation("2026-11-01整理虚构资料，无时刻，不要弹窗", { due: target, requested_date: target }));
});
for (const wording of ["整理一点虚构资料", "列出两点虚构说明", "提前一点准备虚构资料"]) {
  test(`quantity wording must not become an execution clock: ${wording}`, () => {
    assertDateOnly(creation(`${wording}，无时刻，不要弹窗`, { due: target, requested_date: target }));
  });
}
test("none policy with no configured reminder cannot be REMINDER_MISSED", () => {
  const intake = normalizeIntake({ type: "task", title: "虚构定时事项", raw_text: "虚构事项无弹窗",
    due: "2026-10-14", requested_date: "2026-10-14", requested_time: "01:00", reminder_policy: "none" }, { baseDate: receivedAt });
  assert.deepEqual(intake.schedule.reminders, []);
  assert.equal(intake.schedule.reminder_at, null);
  assert.equal(isMissed(intake, new Date(receivedAt)), false);
});
test("a genuine explicit Chinese clock remains 13:00 rather than being stripped", () => {
  const intake = creation("11月1日下午一点整理虚构资料，不要弹窗", { due: target, requested_date: target });
  assert.equal(intake.due, target);
  assert.equal(intake.requested_time, "13:00");
  assert.equal(intake.schedule.reminder_policy, "none");
});
test("month-start window with an explicit anchor is not itself a clock", () => {
  assertDateOnly(creation("11月初整理虚构资料，不设时刻，不要弹窗", { due: target, requested_date: target }));
});
test("an unanchored month-start window must not silently collapse to today", () => {
  const policy = evaluateAutonomy({ type: "task", title: "整理虚构资料", raw_text: "11月初整理虚构资料，无时刻，不要弹窗",
    requested_time: null, reminder_policy: "none", fixed_time: false }, { baseDate: receivedAt });
  assert.ok(policy.decision === "ask" || policy.input?.execution_window
    || policy.input?.requested_date?.startsWith("2026-11-"), "Preserve/resolve the future window; do not invent today's date");
});

for (const wording of ["整理一点虚构资料", "列出两点虚构说明", "提前一点准备虚构资料", "只有一点虚构要求", "总结第一点内容", "一点五倍虚构数值", "一点虚构知识", "明天一点虚构想法"]) {
  test(`quantity without a no-clock disclaimer stays untimed: ${wording}`, () => {
    assertDateOnly(creation(wording, { due: target, requested_date: target }));
  });
}
test("skip a quantity candidate and keep the later genuine Chinese clock", () => {
  const intake = creation("整理一点虚构资料，然后下午三点开始检查", { due: target });
  assert.equal(intake.due, target);
  assert.equal(intake.requested_time, "15:00");
});
test("pure ISO date from wording remains date-only without structured fields", () => {
  assertDateOnly(creation("2026-11-01整理虚构资料，不要弹窗", {}));
});
test("explicit requested_date stays authoritative and explicit clock beats quantity prose", () => {
  const intake = creation("整理一点虚构资料，不要弹窗", { due: "2026-11-02", requested_date: target, requested_time: "15:45" });
  assert.equal(intake.due, target);
  assert.equal(intake.requested_time, "15:45");
});
test("already supported date aliases do not lose their explicit values", () => {
  for (const fields of [{ dueDate: target }, { requestedDate: target }, { schedule: { scheduled_date: target } }]) {
    assertDateOnly(creation("整理虚构资料，不要弹窗", fields));
  }
});
test("invalid explicit dates reach semantic validation rather than becoming today", () => {
  for (const fields of [{ due: "2026-02-30" }, { requested_date: "2026-02-30" }]) {
    assert.throws(() => creation("整理虚构资料", fields), /YYYY-MM-DD/);
  }
});
test("genuine clocks keep midnight, half-hour and bare-clock semantics", () => {
  for (const [wording, expected] of [["11月1日零点整理虚构资料", "00:00"], ["11月1日下午三点半整理虚构资料", "15:30"],
    ["11月1日一点整理虚构资料", "01:00"], ["11月1日会议三点开始", "03:00"]]) {
    assert.equal(creation(wording, { due: target }).requested_time, expected);
  }
});
test("an enabled actual reminder still becomes missed after its instant", () => {
  const intake = normalizeIntake({ type: "task", title: "虚构提醒", raw_text: "今天一点整理虚构资料",
    due: "2026-10-14", requested_date: "2026-10-14", requested_time: "01:00", reminder_policy: "custom", reminder_at: "2026-10-14T01:00" }, { baseDate: receivedAt });
  assert.equal(isMissed(intake, new Date(receivedAt)), true);
});

for (const [wording, date, time] of [
  ["11月1日九点办理虚构业务", target, "09:00"],
  ["明天三点去超市买虚构物品", "2026-10-15", "03:00"],
  ["11月1日九点阅读虚构故事", target, "09:00"],
]) {
  test(`date-anchored Chinese clock survives an arbitrary action: ${wording}`, () => {
    const intake = creation(wording, {});
    assert.equal(intake.due, date);
    assert.equal(intake.requested_time, time);
    assert.equal(intake.schedule.scheduled_start, time);
    assert.equal(intake.schedule.reminder_policy, "none");
    assert.equal(isMissed(intake, new Date(receivedAt)), false);
  });
}

for (const window of ["月底", "这个月底", "本月底", "下个月底", "月初", "这个月中", "11月下旬"]) {
  test(`unanchored month window asks for a date: ${window}`, () => {
    const input = { type: "task", title: "整理虚构资料", raw_text: `${window}整理虚构资料`,
      requested_time: null, reminder_policy: "none" };
    const policy = evaluateAutonomy(input, { baseDate: receivedAt });
    assert.equal(policy.decision, "ask");
    assert.equal(policy.input.requested_date, undefined);
    assertDateOnly(creation(input.raw_text, { due: target }));
  });
}

// Natural wording only; all execution remains pure normalization/simulation.
for (const [anchor, date] of [["明天", "2026-10-15"], ["周五", "2026-10-16"],
  ["星期五", "2026-10-16"], ["11月1日", target], ["2026-11-01", target]]) {
  for (const action of ["办理业务", "去超市买东西", "阅读小说"]) {
    test(`natural clock matrix: ${anchor}九点${action}`, () => {
      const intake = creation(`${anchor}九点${action}`, { reminder_policy: "smart" });
      assert.equal(intake.due, date);
      assert.equal(intake.requested_time, "09:00");
    });
  }
  for (const quantity of ["一点想法都记下来", "一点新的资料都不要遗漏", "一点知识", "一点钱也不要浪费"]) {
    test(`natural quantity matrix: ${anchor}${quantity}`, () => {
      const intake = creation(`${anchor}${quantity}`, { reminder_policy: "smart" });
      assert.equal(intake.due, date);
      assert.equal(intake.requested_time, null);
      assert.equal(intake.schedule.reminder_at, null);
      assert.deepEqual(intake.schedule.reminders, []);
    });
  }
}
test("an unresolved modified 一点 phrase asks rather than inventing a clock", () => {
  const policy = evaluateAutonomy({ type: "task", raw_text: "明天一点新的体验", requested_time: null,
    reminder_policy: "smart" }, { baseDate: receivedAt });
  assert.equal(policy.decision, "ask");
  assert.equal(policy.input.requested_time, null);
});

for (const predicate of ["记下来", "记录下来", "整理好", "保存起来", "提交给团队", "发送给同事"]) {
  for (const separator of ["", "，", "；", ",", ";"]) {
    for (const laterClock of [false, true]) {
      if (!laterClock && separator) continue;
      const phrase = `明天一点新的想法都${predicate}${laterClock ? `${separator}下午三点整理` : ""}`;
      test(`adjacent quantity grammar with later predicate/clock: ${phrase}`, () => {
        const intake = creation(phrase, { reminder_policy: "smart" });
        assert.equal(intake.due, "2026-10-15");
        assert.equal(intake.requested_time, laterClock ? "15:00" : null);
        if (!laterClock) {
          assert.equal(intake.schedule.reminder_at, null);
          assert.deepEqual(intake.schedule.reminders, []);
        }
      });
    }
  }
}
test("multiple quantity candidates do not hide the later real clock", () => {
  const intake = creation("明天一点想法都记录下来；一点资料都整理好，下午三点办理业务", { reminder_policy: "smart" });
  assert.equal(intake.requested_time, "15:00");
});
test("unmodified noun and synonymous predicate remain quantity wording", () => {
  for (const suffix of ["", "，下午三点整理"]) {
    const intake = creation(`明天一点想法都记录下来${suffix}`, { reminder_policy: "smart" });
    assert.equal(intake.requested_time, suffix ? "15:00" : null);
    if (!suffix) assert.equal(intake.schedule.reminder_at, null);
  }
});
