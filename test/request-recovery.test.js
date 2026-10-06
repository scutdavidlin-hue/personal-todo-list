import test from "node:test";
import assert from "node:assert/strict";
import { frozenIntake, intakeBlocker, isMissed, publicRecovery, recoveryDecision, retryAt } from "../supabase/functions/_shared/request-recovery.js";
import { normalizeIntake } from "../supabase/functions/_shared/personal-os-intake.js";

test("relative dates stay anchored to the original receipt across retries and midnight", () => {
  const receivedAt = "2026-09-24T15:59:00.000Z"; // 23:59 Shanghai
  const input = frozenIntake({ raw_text: "明天15:00提醒我交材料", type: "task", timezone: "Asia/Shanghai" }, receivedAt);
  const first = normalizeIntake(input);
  const retry = normalizeIntake(input, { baseDate: "2026-10-01T00:00:00Z" });
  assert.equal(first.due, "2026-09-25");
  assert.equal(retry.due, first.due);
  assert.equal(first.requested_time, "15:00");
});

test("explicit offset reminder is compared as an instant", () => {
  const intake = { timezone: "Asia/Shanghai", schedule: { reminder_at: "2026-09-25T07:00:00Z" } };
  assert.equal(isMissed(intake, new Date("2026-09-25T06:59:00Z")), false);
  assert.equal(isMissed(intake, new Date("2026-09-25T07:01:00Z")), true);
});

test("missing reminder time and unsupported recurrence remain visible", () => {
  const missing = normalizeIntake({ raw_text: "提醒我交材料", type: "task", fixed_time: true }, { baseDate: "2026-09-24T08:00:00+08:00" });
  assert.equal(intakeBlocker(missing), "REMINDER_TIME_REQUIRED");
  assert.equal(intakeBlocker({ type: "task", raw_text: "每周五下午三点提醒我" }), "RECURRING_NOT_SUPPORTED");
  assert.equal(publicRecovery({ id: "r", idempotency_key: "k", raw_text: "raw", request_payload: missing, stage: "needs_input", status: "failed" }).stage, "needs_input");
});

test("date-only reminder language preserves the date without inventing a clock", () => {
  for (const requested_time of [undefined, null]) {
    const intake = normalizeIntake({ raw_text: "明天提醒我落实重点人群退抵税系统", type: "task",
      due: "2026-09-25", requested_date: "2026-09-25", requested_time, fixed_time: false, priority: "high" });
    assert.equal(intakeBlocker(intake), null);
    assert.equal(intake.requested_time, null);
    assert.equal(intake.schedule.scheduled_start, null);
    assert.equal(intake.schedule.fixed_time, false);
    assert.equal(intake.schedule.priority, "high");
    assert.equal(intakeBlocker({ ...intake, fixed_time: true }), "REMINDER_TIME_REQUIRED");
  }
});

test("unknown writes only reconcile and leased requests wait", () => {
  const now = new Date("2026-09-25T00:00:00Z");
  assert.equal(recoveryDecision({ stage: "outcome_unknown" }, now), "reconcile_first");
  assert.equal(recoveryDecision({ stage: "projection_pending" }, now), "projection_only");
  assert.equal(recoveryDecision({ stage: "write_pending", lease_expires_at: "2026-09-25T00:01:00Z" }, now), "leased");
  assert.equal(recoveryDecision({ stage: "missed" }, now), "needs_input");
  assert.ok(Date.parse(retryAt(2, now.valueOf())) > now.valueOf());
});
