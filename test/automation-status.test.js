import test from "node:test";
import assert from "node:assert/strict";
import { buildStatus, shiftDate, validDate, validTime } from "../supabase/functions/task-status/status-core.js";

const base = {
  owner_id: "private-owner-id",
  time: null,
  category: "工作",
  priority: "medium",
  duration: 30,
  notes: "",
  done: false,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  source: "manual",
};

test("automation summary returns stable morning/evening buckets and hides owner", () => {
  const rows = [
    { ...base, id: "new", title: "今日新增", date: "2026-09-03", status: "open", carried_from_date: null, completed_at: null },
    { ...base, id: "carry", title: "昨日延续", date: "2026-09-03", status: "open", source: "carryover", carried_from_date: "2026-09-02", completed_at: null },
    { ...base, id: "done", title: "今日完成", date: "2026-09-03", status: "done", done: true, carried_from_date: null, completed_at: "2026-09-03T02:00:00Z" },
    { ...base, id: "yesterday", title: "昨日完成", date: "2026-09-02", status: "done", done: true, carried_from_date: null, completed_at: "2026-09-02T12:00:00Z" },
    { ...base, id: "future", title: "未来事项", date: "2026-09-05", status: "open", carried_from_date: null, completed_at: null },
    { ...base, id: "far", title: "太远", date: "2026-09-08", status: "open", carried_from_date: null, completed_at: null },
  ];
  const status = buildStatus(rows, "2026-09-03", new Date("2026-09-03T03:00:00Z"));
  assert.deepEqual(status.counts, { today_open: 1, today_done: 1, carryover_open: 1, yesterday_completed: 1, upcoming: 1 });
  assert.equal(status.today_open[0].id, "new");
  assert.equal(status.carryover_open[0].id, "carry");
  assert.equal(status.today_done[0].id, "done");
  assert.equal(status.yesterday_completed[0].id, "yesterday");
  assert.equal(status.upcoming[0].id, "future");
  assert.equal("owner_id" in status.today_open[0], false);
});

test("Shanghai completion date handles UTC day boundary", () => {
  const rows = [{ ...base, id: "boundary", title: "凌晨完成", date: "2026-09-03", status: "done", done: true, carried_from_date: null, completed_at: "2026-09-02T16:30:00Z" }];
  const status = buildStatus(rows, "2026-09-04", new Date("2026-09-04T00:00:00Z"));
  assert.equal(status.yesterday_completed[0].id, "boundary");
});

test("date validation rejects impossible calendar dates", () => {
  assert.equal(validDate("2026-09-03"), true);
  assert.equal(validDate("2026-02-31"), false);
  assert.equal(validDate("09/03/2026"), false);
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(validTime("09:30"), true);
  assert.equal(validTime("25:99"), false);
});
