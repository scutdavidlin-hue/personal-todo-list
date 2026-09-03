import test from "node:test";
import assert from "node:assert/strict";
import { buildStatus, shiftDate, validDate, validTime } from "../supabase/functions/task-status/status-core.js";

const base = {
  owner_id: "private-owner-id",
  category: "Google Tasks",
  priority: "medium",
  notes: "",
  source: "google_tasks",
};

test("automation summary returns morning and evening Google Tasks buckets and hides owner", () => {
  const rows = [
    { ...base, id: "new", title: "今日新增", dueDate: "2026-09-03", status: "open", completedAt: null },
    { ...base, id: "late", title: "登录 Supabase", dueDate: "2026-09-02", status: "open", priority: "high", completedAt: null },
    { ...base, id: "done", title: "今日完成", dueDate: "2026-09-03", status: "completed", completedAt: "2026-09-03T02:00:00Z" },
    { ...base, id: "yesterday", title: "昨日完成", dueDate: "2026-09-02", status: "completed", completedAt: "2026-09-02T12:00:00Z" },
    { ...base, id: "future", title: "未来事项", dueDate: "2026-09-05", status: "open", completedAt: null },
    { ...base, id: "far", title: "太远", dueDate: "2026-09-12", status: "open", completedAt: null },
  ];
  const status = buildStatus(rows, "2026-09-03", new Date("2026-09-03T03:00:00Z"));
  assert.deepEqual(status.counts, {
    today_open: 1,
    overdue_open: 1,
    priority_open: 1,
    personally_required: 1,
    today_completed: 1,
    yesterday_completed: 1,
    upcoming: 1,
    unscheduled: 0,
  });
  assert.equal(status.today_open[0].id, "new");
  assert.equal(status.overdue_open[0].id, "late");
  assert.equal(status.priority_open[0].id, "late");
  assert.equal(status.personally_required[0].id, "late");
  assert.equal(status.today_completed[0].id, "done");
  assert.equal(status.yesterday_completed[0].id, "yesterday");
  assert.equal(status.upcoming[0].id, "future");
  assert.equal("owner_id" in status.today_open[0], false);
});

test("Shanghai completion date handles UTC day boundary", () => {
  const rows = [{ ...base, id: "boundary", title: "凌晨完成", dueDate: "2026-09-03", status: "completed", completedAt: "2026-09-02T16:30:00Z" }];
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
