import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_LIST_TITLE,
  chooseTaskList,
  composeTaskNotes,
  createGoogleTaskPayload,
  dateToGoogleDue,
  filterTaskModels,
  findDuplicateTask,
  googleDueToDate,
  splitTaskNotes,
  taskTitleSimilarity,
  toPublicTask,
  updateGoogleTaskPayload,
  validDate,
} from "../supabase/functions/_shared/google-tasks-core.js";

test("Google Tasks due dates deliberately preserve date only", () => {
  assert.equal(validDate("2026-09-03"), true);
  assert.equal(validDate("2026-02-31"), false);
  assert.equal(dateToGoogleDue("2026-09-03"), "2026-09-03T00:00:00.000Z");
  assert.equal(googleDueToDate("2026-09-03T00:00:00.000Z"), "2026-09-03");
  assert.equal(googleDueToDate(undefined), null);
});

test("create payload contains only native Google Tasks fields", () => {
  const payload = createGoogleTaskPayload({
    title: "测试：Google Tasks 已打通",
    notes: "真实测试",
    dueDate: "2026-09-03",
    originalIntent: "测试 Tasks 写入",
    time: "09:30",
    category: "工作",
  });
  assert.deepEqual(payload, {
    title: "测试：Google Tasks 已打通",
    notes: "真实测试\n\n原始意图：测试 Tasks 写入",
    due: "2026-09-03T00:00:00.000Z",
  });
});

test("completion and date updates map to Google Tasks v1 semantics", () => {
  assert.deepEqual(updateGoogleTaskPayload({ status: "completed" }), { status: "completed" });
  assert.deepEqual(updateGoogleTaskPayload({ status: "open" }), { status: "needsAction", completed: null });
  assert.deepEqual(updateGoogleTaskPayload({ dueDate: "2026-09-04" }), { due: "2026-09-04T00:00:00.000Z" });
});

test("Google task maps back to the existing UI contract", () => {
  const task = toPublicTask({
    id: "google-id",
    title: "A",
    notes: "说明",
    due: "2026-09-03T00:00:00.000Z",
    status: "completed",
    completed: "2026-09-03T02:00:00Z",
    updated: "2026-09-03T02:00:00Z",
  });
  assert.equal(task.status, "completed");
  assert.equal(task.done, true);
  assert.equal(task.dueDate, "2026-09-03");
  assert.equal(task.externalId, "google-id");
  assert.equal(task.provider, "google_tasks");
  assert.equal(task.source, "google_tasks");
});

test("original intent round-trips through native Google task notes", () => {
  const value = composeTaskNotes("执行说明", "让手机勾选状态同步到云端");
  assert.deepEqual(splitTaskNotes(value), {
    notes: "执行说明",
    originalIntent: "让手机勾选状态同步到云端",
  });
});

test("Personal OS task list is reused when it already exists", () => {
  const selected = chooseTaskList([{ id: "1", title: "My Tasks" }, { id: "2", title: "personal os" }]);
  assert.equal(DEFAULT_TASK_LIST_TITLE, "Personal OS");
  assert.equal(selected.id, "2");
});

test("semantic duplicate detection recognizes the luggage reminder wording", () => {
  const tasks = [{ id: "existing", title: "收拾东北旅行行李", dueDate: "2026-09-06", status: "open" }];
  assert.ok(taskTitleSimilarity("周日记得收拾东北旅行的行李", tasks[0].title) >= 0.82);
  assert.equal(findDuplicateTask({ title: "周日记得收拾东北旅行的行李", dueDate: "2026-09-06" }, tasks)?.id, "existing");
});

test("task filters expose today, overdue, upcoming and completed buckets", () => {
  const tasks = [
    { id: "today", dueDate: "2026-09-04", status: "open" },
    { id: "late", dueDate: "2026-09-03", status: "open" },
    { id: "future", dueDate: "2026-09-06", status: "open" },
    { id: "done", dueDate: "2026-09-04", status: "completed" },
  ];
  assert.equal(filterTaskModels(tasks, "today", "2026-09-04")[0].id, "today");
  assert.equal(filterTaskModels(tasks, "overdue", "2026-09-04")[0].id, "late");
  assert.equal(filterTaskModels(tasks, "upcoming", "2026-09-04")[0].id, "future");
  assert.equal(filterTaskModels(tasks, "completed", "2026-09-04")[0].id, "done");
});
