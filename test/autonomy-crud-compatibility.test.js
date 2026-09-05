import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("CRUD MCP compatibility surface retains lifecycle tools beside autonomy tools", async () => {
  const source = await readFile(new URL("supabase/functions/personal-os-mcp/index.ts", root), "utf8");
  for (const name of ["search_tasks", "get_task", "update_task", "complete_task", "reopen_task", "delete_task", "update_task_reminder", "resolve_task_intent"]) {
    assert.equal(source.includes(name), true);
  }
  assert.match(source, /Authorization: request\.headers\.get\("authorization"\)/);
});

test("Google Tasks lifecycle routes preserve audited mutation and verification hooks", async () => {
  const source = await readFile(new URL("supabase/functions/google-tasks/index.ts", root), "utf8");
  for (const symbol of ["reserveActivity", "runAuditedMutation", "normalizeTaskPatch", "searchTaskViews", "getTaskView"]) assert.match(source, new RegExp(symbol));
  assert.match(source, /Google Tasks deletion readback failed/);
  assert.match(source, /requireSchedulerSync/);
  assert.match(source, /resolveAndExecuteTask/);
  assert.match(source, /projection_error: projection\.success === true \? null : projection/);
  assert.match(source, /google_task_id: task\.google_task_id/);
  assert.match(source, /projection_error: projection\?\.success === false \? projection : null/);
});
