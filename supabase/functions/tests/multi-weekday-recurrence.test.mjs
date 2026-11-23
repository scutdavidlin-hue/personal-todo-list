import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRecurrence,
  nextRuleDate,
  nextOccurrenceDate,
  recurrenceRuleFromSeries,
} from "../_shared/task-recurrence-core.js";

const schedule = {
  scheduled_date: "2026-11-24",
  scheduled_start: "18:00",
  timezone: "Asia/Shanghai",
};
test("multi-weekday RRULE expands in order across week boundary", () => {
  const rule = normalizeRecurrence({ kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR" }, schedule);
  assert.equal(rule.rrule, "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR");
  const dates = [schedule.scheduled_date];
  for (let n = 0; n < 7; n++) dates.push(nextRuleDate(dates.at(-1), rule));
  assert.deepEqual(dates, [
    "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27",
    "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04",
  ]);
});
test("existing single-weekday recurrence remains unchanged", () => {
  const old = normalizeRecurrence({ kind: "weekly", weekday: 2 }, schedule);
  assert.equal(old.rrule, "FREQ=WEEKLY;BYDAY=TU");
  assert.equal(nextRuleDate("2026-11-24", old), "2026-12-01");
});
test("series restores all BYDAY values", () => {
  const rule = recurrenceRuleFromSeries({
    recurrence_kind: "weekly", recurrence_interval: 1, rrule: "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR",
    by_weekday: 2, current_date: "2026-11-24", local_time: "18:00:00", timezone: "Asia/Shanghai",
  });
  assert.deepEqual(rule.weekdays, [2, 3, 4, 5]);
  assert.equal(nextRuleDate("2026-11-24", rule), "2026-11-25");
});
test("closed occurrence advances to next available weekday", () => {
  const rule = normalizeRecurrence({ kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TU,WE,TH,FR" }, schedule);
  assert.equal(nextOccurrenceDate("2026-11-27", rule, "2026-11-27T18:05"), "2026-12-01");
});
test("invalid and duplicate weekday rules fail closed", () => {
  assert.throws(() => normalizeRecurrence({ kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TU,TU" }, schedule));
  assert.throws(() => normalizeRecurrence({ kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=XX" }, schedule));
  assert.throws(() => normalizeRecurrence({ kind: "weekly", rrule: "FREQ=WEEKLY;BYDAY=TU,WE" }, { ...schedule, scheduled_date: "2026-11-26" }));
});
