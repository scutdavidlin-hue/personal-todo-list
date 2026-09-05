import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  googleTasks: new URL("../supabase/functions/google-tasks/index.ts", import.meta.url),
  taskStatus: new URL("../supabase/functions/task-status/index.ts", import.meta.url),
  intake: new URL("../supabase/functions/personal-os-intake/index.ts", import.meta.url),
  actionRouter: new URL("../supabase/functions/action-router/index.ts", import.meta.url),
  mcp: new URL("../supabase/functions/personal-os-mcp/index.ts", import.meta.url),
};

test("every Task creation surface routes through the shared resolution runtime", async () => {
  const [googleTasks, taskStatus, intake] = await Promise.all([
    readFile(files.googleTasks, "utf8"),
    readFile(files.taskStatus, "utf8"),
    readFile(files.intake, "utf8"),
  ]);
  for (const source of [googleTasks, taskStatus]) {
    assert.match(source, /resolveAndExecuteTask/);
    assert.match(source, /loadTaskResolutionContext/);
    assert.match(source, /createTaskResolutionAdapter/);
    assert.doesNotMatch(source, /findDuplicateTask/);
  }
  assert.match(intake, /intake_audit_id: auditId/);
  assert.match(intake, /result\.resolution/);
  assert.ok(
    googleTasks.indexOf('if (!String(taskInput.title || "").trim())') < googleTasks.indexOf("await reserveCreateAudit"),
    "invalid browser Task input must be rejected before reserving an audit/write slot",
  );
});

test("Action Router delegates Task writes to the idempotent unified intake", async () => {
  const actionRouter = await readFile(files.actionRouter, "utf8");
  assert.match(actionRouter, /functions\/v1\/personal-os-intake/);
  assert.match(actionRouter, /request\.headers\.get\("idempotency-key"\)/);
  assert.match(actionRouter, /"Idempotency-Key": idempotencyKey/);
  assert.doesNotMatch(actionRouter, /functions\/v1\/task-status/);
});

test("parent-child writes use the native Google Tasks parent parameter", async () => {
  const [googleTasks, taskStatus] = await Promise.all([
    readFile(files.googleTasks, "utf8"),
    readFile(files.taskStatus, "utf8"),
  ]);
  for (const source of [googleTasks, taskStatus]) {
    assert.match(source, /params\.set\("parent", String\((?:metadata\.parent_task_id|parentId)\)\)/);
  }
});

test("Codex receives resolution, graph, explainability, and update-first reminder tools", async () => {
  const mcp = await readFile(files.mcp, "utf8");
  for (const tool of ["resolve_task_intent", "get_task_graph", "explain_task_resolution", "update_task_reminder"]) {
    assert.match(mcp, new RegExp(`name: "${tool}"`));
    assert.match(mcp, new RegExp(`${tool}:`));
  }
  assert.match(mcp, /Resolve Before Create/);
  assert.match(mcp, /Smart Reminder reasoning/);
  assert.match(mcp, /version: "1\.4\.0"/);
});

test("Task graph and audit reads are served from current provider truth plus metadata", async () => {
  const taskStatus = await readFile(files.taskStatus, "utf8");
  assert.match(taskStatus, /buildTaskExecutionGraph/);
  assert.match(taskStatus, /enrichTaskCandidates/);
  assert.match(taskStatus, /resource"\) === "graph"/);
  assert.match(taskStatus, /resource"\) === "resolution"/);
});
