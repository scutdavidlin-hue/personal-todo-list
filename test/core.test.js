import test from "node:test";
import assert from "node:assert/strict";
import {
  collectLegacyTasks,
  fromDatabaseTask,
  groupTasksForToday,
  localDateISO,
  offsetDate,
  toDatabaseTask,
} from "../src/core.js";

class MemoryStorage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

test("local date helpers preserve calendar dates", () => {
  const date = new Date(2026, 8, 3, 23, 30);
  assert.equal(localDateISO(date), "2026-09-03");
  assert.equal(offsetDate(1, date), "2026-09-04");
});

test("database task maps snake_case fields and status", () => {
  const task = fromDatabaseTask({
    id: "11111111-1111-4111-8111-111111111111",
    title: "完成验收",
    date: "2026-09-03",
    time: "09:30:00",
    category: "工作",
    priority: "high",
    duration: 30,
    notes: "",
    status: "done",
    done: true,
    completed_at: "2026-09-03T01:00:00Z",
    carried_from_date: "2026-09-02",
    source: "carryover",
  });
  assert.equal(task.done, true);
  assert.equal(task.time, "09:30");
  assert.equal(task.completedAt, "2026-09-03T01:00:00Z");
  assert.equal(task.carriedFromDate, "2026-09-02");
});

test("database payload enforces completion consistency", () => {
  const open = toDatabaseTask({ id: "11111111-1111-4111-8111-111111111111", title: "A", date: "2026-09-03", status: "open", completedAt: "stale" });
  assert.equal(open.completed_at, null);
  const done = toDatabaseTask({ id: "11111111-1111-4111-8111-111111111111", title: "A", date: "2026-09-03", status: "done", completedAt: "2026-09-03T00:00:00Z" });
  assert.equal(done.completed_at, "2026-09-03T00:00:00Z");
});

test("legacy migration merges both stores, maps fields and excludes known samples", () => {
  const sharedId = "11111111-1111-4111-8111-111111111111";
  const storage = new MemoryStorage({
    "richeng-tasks-v1": JSON.stringify([
      { id: sharedId, title: "真实任务", date: "2026-09-02", done: false, category: "工作", priority: "high", duration: 20 },
      { id: crypto.randomUUID(), title: "阅读 30 分钟", date: "2026-09-03", done: false },
    ]),
    "gpt-personal-tasks-v1": JSON.stringify([
      { id: sharedId, title: "真实任务（最新版）", due: "2026-09-03", done: true, completedAt: "2026-09-03T01:00:00Z", source: "GPT" },
      { id: crypto.randomUUID(), title: "另一个真实任务", due: "2026-09-01", done: false, carryCount: 2, rolledFrom: "2026-08-30" },
    ]),
  });
  const result = collectLegacyTasks(storage);
  assert.equal(result.tasks.length, 2);
  const updated = result.tasks.find((task) => task.id === sharedId);
  assert.equal(updated.title, "真实任务（最新版）");
  assert.equal(updated.status, "done");
  assert.equal(updated.source, "gpt");
  const carry = result.tasks.find((task) => task.title === "另一个真实任务");
  assert.equal(carry.source, "carryover");
  assert.equal(carry.carried_from_date, "2026-08-30");
});

test("malformed legacy storage is reported without blocking valid data", () => {
  const storage = new MemoryStorage({
    "richeng-tasks-v1": "not-json",
    "gpt-personal-tasks-v1": JSON.stringify([{ id: crypto.randomUUID(), title: "有效任务", due: "2026-09-03", done: false }]),
  });
  const result = collectLegacyTasks(storage);
  assert.equal(result.malformedSources, 1);
  assert.equal(result.tasks.length, 1);
});

test("today grouping separates new, carryover, open and done without duplication", () => {
  const tasks = [
    { id: "1", date: "2026-09-03", status: "open", carriedFromDate: null },
    { id: "2", date: "2026-09-03", status: "open", carriedFromDate: "2026-09-02" },
    { id: "3", date: "2026-09-03", status: "done", carriedFromDate: "2026-09-02" },
    { id: "4", date: "2026-09-04", status: "open", carriedFromDate: null },
    { id: "5", date: "2026-09-03", status: "cancelled", carriedFromDate: null },
  ];
  const groups = groupTasksForToday(tasks, "2026-09-03");
  assert.deepEqual(groups.todayNew.map((task) => task.id), ["1"]);
  assert.deepEqual(groups.carryover.map((task) => task.id), ["2", "3"]);
  assert.deepEqual(groups.open.map((task) => task.id), ["1", "2"]);
  assert.deepEqual(groups.done.map((task) => task.id), ["3"]);
});

test("due grouping keeps overdue tasks instead of duplicating or rolling them forward", async () => {
  const { groupTasksByDue } = await import("../src/core.js");
  const tasks = [
    { id: "late", dueDate: "2026-09-02", status: "open" },
    { id: "today", dueDate: "2026-09-03", status: "open" },
    { id: "future", dueDate: "2026-09-04", status: "open" },
    { id: "done", dueDate: "2026-09-03", status: "completed", completedAt: "2026-09-03T08:00:00Z" },
  ];
  const groups = groupTasksByDue(tasks, "2026-09-03");
  assert.equal(groups.overdue[0].id, "late");
  assert.equal(groups.today[0].id, "today");
  assert.equal(groups.upcoming[0].id, "future");
  assert.equal(groups.completed[0].id, "done");
});
