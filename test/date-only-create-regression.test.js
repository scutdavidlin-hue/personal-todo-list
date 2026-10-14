import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { normalizeIntake, taskDispatchPayload } from "../supabase/functions/_shared/personal-os-intake.js";
import { frozenIntake, isMissed } from "../supabase/functions/_shared/request-recovery.js";

// Desired behavior, deliberately RED on bb240517. Investigation only: no
// production parser is edited. These assertions must go green with a later fix.
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
