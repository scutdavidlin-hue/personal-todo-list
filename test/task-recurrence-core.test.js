import test from "node:test";
import assert from "node:assert/strict";
import {
  localDateTimeInZone,
  nextOccurrenceDate,
  nextRuleDate,
  normalizeRecurrence,
  notesWithRecurrenceMarker,
  occurrenceWriteDecision,
  openOccurrenceReady,
  recurrenceKeyFromNotes,
  recurrenceLeadMinutes,
  recurrenceMaintenanceBatch,
  recurrenceRuleFromSeries,
  recurrenceSchedule,
} from "../supabase/functions/_shared/task-recurrence-core.js";
import { createGoogleTaskPayload, toTaskModel } from "../supabase/functions/_shared/google-tasks-core.js";

const timedSchedule = { scheduled_date: "2026-09-30", scheduled_start: "15:00", scheduled_end: "16:00",
  timezone: "Asia/Shanghai", reminder_offset_minutes: 30, deadline: null };

test("normalizes Daily, Weekly, Monthly, and Yearly as a bounded RRULE subset", () => {
  assert.equal(normalizeRecurrence({ kind: "daily" }, timedSchedule).rrule, "FREQ=DAILY");
  assert.equal(normalizeRecurrence({ kind: "weekly", weekday: 3 }, timedSchedule).rrule, "FREQ=WEEKLY;BYDAY=WE");
  assert.equal(normalizeRecurrence({ kind: "monthly" }, timedSchedule).rrule, "FREQ=MONTHLY;BYMONTHDAY=30");
  assert.equal(normalizeRecurrence({ kind: "yearly" }, timedSchedule).rrule, "FREQ=YEARLY;BYMONTHDAY=30;BYMONTH=9");
  assert.equal(normalizeRecurrence("RRULE:FREQ=WEEKLY;BYDAY=WE", timedSchedule).kind, "weekly");
  assert.throws(() => normalizeRecurrence({ kind: "hourly" }, timedSchedule), /daily, weekly, monthly, or yearly/);
  assert.throws(() => normalizeRecurrence({ kind: "weekly", weekday: 5 }, timedSchedule), /single weekday/);
  assert.throws(() => normalizeRecurrence({ kind: "daily", count: 10 }, timedSchedule), /not supported/);
});

test("date-only recurring Tasks do not require a Calendar time", () => {
  const recurrence = normalizeRecurrence({ kind: "weekly", weekday: 3 }, {
    scheduled_date: "2026-09-30", scheduled_start: null, timezone: "Asia/Shanghai",
  });
  assert.equal(recurrence.local_time, null);
  assert.equal(nextOccurrenceDate("2026-09-30", recurrence, "2026-09-30T20:00"), "2026-10-07");
});

test("calendar arithmetic follows anchor dates and skips invalid month/year dates", () => {
  assert.equal(nextRuleDate("2026-09-30", { kind: "weekly", interval: 1 }), "2026-10-07");
  assert.equal(nextRuleDate("2026-01-31", { kind: "monthly", interval: 1, month_day: 31 }), "2026-03-31");
  assert.equal(nextRuleDate("2024-02-29", { kind: "yearly", interval: 1, month: 2, month_day: 29 }), "2028-02-29");
  assert.equal(nextRuleDate("2026-09-30", { kind: "monthly", interval: 2, month_day: 30 }), "2026-11-30");
});

test("local clock handles timezone and reminder boundaries", () => {
  assert.equal(localDateTimeInZone("2026-09-29T23:30:00Z", "Asia/Shanghai"), "2026-09-30T07:30");
  const recurrence = { kind: "weekly", interval: 1 };
  const options = { local_time: "15:00", reminder_offset_minutes: 30 };
  assert.equal(nextOccurrenceDate("2026-09-23", recurrence, "2026-09-30T14:29", options), "2026-09-30");
  assert.equal(nextOccurrenceDate("2026-09-23", recurrence, "2026-09-30T14:30", options), "2026-10-07");
});

test("occurrence key survives retries and dates shift without copying an absolute reminder", () => {
  const seriesId = "01234567-89ab-cdef-0123-456789abcdef";
  const notes = notesWithRecurrenceMarker("提前邀约阿东", seriesId, "2026-10-07");
  assert.equal(recurrenceKeyFromNotes(notes), `${seriesId}:2026-10-07`);
  assert.equal(notesWithRecurrenceMarker(notes, seriesId, "2026-10-14").match(/Personal OS recurrence:/g)?.length, 1);
  const next = recurrenceSchedule({ ...timedSchedule, reminder_at: "2026-09-30T14:30" }, "2026-10-07");
  assert.equal(next.scheduled_date, "2026-10-07");
  assert.equal(next.reminder_at, null);
  assert.equal(next.reminder_offset_minutes, 30);
  const payload = createGoogleTaskPayload({ title: "园桌拜访活动｜提前邀约阿东", notes: "提前邀约阿东", dueDate: "2026-10-07",
    metadata: { recurrence_key: `${seriesId}:2026-10-07` } });
  const recovered = toTaskModel({ ...payload, id: "provider-1", status: "needsAction" });
  assert.equal(recovered.metadata.recurrence_key, `${seriesId}:2026-10-07`);
});

test("园桌验收：完成 9/30 后只生成一条 10/7，重复重试不新增，历史保留", () => {
  const seriesId = "01234567-89ab-cdef-0123-456789abcdef";
  const recurrence = normalizeRecurrence({ kind: "weekly", weekday: 3 }, {
    scheduled_date: "2026-09-30", timezone: "Asia/Shanghai", scheduled_start: null,
  });
  const history = [{ id: "task-0930", title: "园桌拜访活动｜提前邀约阿东", dueDate: "2026-09-30", status: "completed" }];
  const nextDate = nextOccurrenceDate("2026-09-30", recurrence, "2026-09-30T18:00");
  assert.equal(nextDate, "2026-10-07");
  const marker = `${seriesId}:${nextDate}`;
  const providerTasks = [];
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: false }, providerTasks), "create_once");
  providerTasks.push({ id: "task-1007", title: history[0].title, dueDate: nextDate, metadata: { recurrence_key: marker } });
  const matches = providerTasks.filter((task) => task.metadata.recurrence_key === marker);
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: true }, matches), "recover_existing");
  assert.equal(matches.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "completed");
  assert.deepEqual(recurrenceSchedule({ scheduled_date: "2026-09-30", scheduled_start: null, timezone: "Asia/Shanghai" }, nextDate), {
    scheduled_date: "2026-10-07", scheduled_start: null, timezone: "Asia/Shanghai", deadline: null, deadline_time: null,
    scheduling_status: "scheduled", scheduling_source: "explicit_user", fixed_time: false, reminder_at: null, reminder_offset_minutes: null,
  });
});

test("repeated and concurrent advancement never chooses a second blind provider create", () => {
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: false }, []), "create_once");
  assert.equal(occurrenceWriteDecision({ claimed: false }, []), "busy_or_cancelled");
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: true }, []), "outcome_unknown");
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: true }, [{ id: "already-written" }]), "recover_existing");
  assert.equal(occurrenceWriteDecision({ claimed: true, creation_started: true }, [{ id: "one" }, { id: "two" }]), "duplicate_review");
});

test("open recurrence advances only when the next occurrence window begins", () => {
  const weekly = { kind: "weekly", interval: 1 };
  assert.equal(openOccurrenceReady("2026-09-23", weekly, "2026-09-30T14:29", { local_time: "15:00", reminder_offset_minutes: 30 }), false);
  assert.equal(openOccurrenceReady("2026-09-23", weekly, "2026-09-30T14:30", { local_time: "15:00", reminder_offset_minutes: 30 }), true);
  assert.equal(openOccurrenceReady("2026-09-23", weekly, "2026-09-30T00:00"), true);
});

test("series exposes its stored canonical rule fields", () => {
  assert.deepEqual(recurrenceRuleFromSeries({ recurrence_kind: "yearly", recurrence_interval: 1, by_month: 9, by_month_day: 30,
    current_date: "2026-09-30", timezone: "Asia/Shanghai", local_time: null, rrule: "FREQ=YEARLY;BYMONTHDAY=30;BYMONTH=9" }), {
    kind: "yearly", rrule: "FREQ=YEARLY;BYMONTHDAY=30;BYMONTH=9", interval: 1, weekday: undefined,
    month_day: 30, month: 9, anchor_date: "2026-09-30", local_time: null, timezone: "Asia/Shanghai",
  });
});

test("series uses the earliest configured reminder and maintenance rotates bounded pages", () => {
  assert.equal(recurrenceLeadMinutes({ reminder_offset_minutes: 30, reminders: [{ offset_minutes: 60 }, { offset_minutes: 15 }] }), 60);
  const rows = Array.from({ length: 43 }, (_, index) => ({ id: index }));
  assert.deepEqual(recurrenceMaintenanceBatch(rows, 2).rows.map((row) => row.id), [40, 41, 42]);
  assert.throws(() => recurrenceMaintenanceBatch(rows, 1, 21), /Invalid recurrence maintenance batch/);
});
