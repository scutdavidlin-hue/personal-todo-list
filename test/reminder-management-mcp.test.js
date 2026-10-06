import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const mcpPath = new URL("../supabase/functions/personal-os-mcp/index.ts", import.meta.url);

test("Personal OS MCP registers series and durable-request management behind owner auth", async () => {
  const source = await readFile(mcpPath, "utf8");
  for (const [name, schema] of [
    ["list_recurrence_series", "ListRecurrenceSeriesInput"],
    ["update_recurrence_series", "UpdateRecurrenceSeriesInput"],
    ["pause_recurrence_series", "PauseRecurrenceSeriesInput"],
    ["resume_recurrence_series", "ResumeRecurrenceSeriesInput"],
    ["skip_recurrence_occurrence", "SkipRecurrenceSeriesInput"],
    ["cancel_recurrence_series", "CancelRecurrenceSeriesInput"],
    ["list_reminder_requests", "ListReminderRequestsInput"],
    ["recover_reminder_request", "RecoverReminderRequestInput"],
    ["amend_reminder_request", "AmendReminderRequestInput"],
  ]) {
    assert.match(source, new RegExp(`${name}: ${schema}`));
    assert.match(source, new RegExp(`if \\(name === "${name}"\\)`));
  }
  assert.match(source, /if \(!await authorize\(context\.req\.raw\)\) return unauthorized\(\)/);
  assert.match(source, /Authorization: `Bearer \$\{WRITE_TOKEN\}`/);
});

test("series cancellation requires exact series ID and a cancelled readback", async () => {
  const source = await readFile(mcpPath, "utf8");
  assert.match(source, /CancelRecurrenceSeriesInput = z\.object\(\{ series_id: z\.string\(\)\.regex\(UUID_PATTERN\) \}\)/);
  assert.match(source, /body: JSON\.stringify\(\{ action: "list_series" \}\)/);
  assert.match(source, /result\.cancelled !== true \|\| series\.status !== "cancelled"/);
  const publicShape = source.slice(source.indexOf("function publicSeries("), source.indexOf("async function recurrenceSeriesResult("));
  assert.doesNotMatch(publicShape, /lease_token|owner_id|creation_started/);
  assert.match(source, /series: result\.series\.map\(\(row: Record<string, unknown>\) => publicSeries\(row\)\)/);
  assert.doesNotMatch(source, /cancel_recurrence_series[^\n]*cancel_task/);
});

test("series management exposes update, pause, resume, and skip with readback", async () => {
  const source = await readFile(mcpPath, "utf8");
  assert.match(source, /action === "update_series"/);
  assert.match(source, /action === "pause_series" \|\| action === "resume_series"/);
  assert.match(source, /action === "skip_series_once"/);
  assert.match(source, /series\.skip_date !== result\.recurrence_instance_date/);
  assert.match(source, /daily", "weekly", "monthly", "yearly/);
});

test("both ChatGPT task entrypoints advertise natural-language recurrence", async () => {
  const source = await readFile(mcpPath, "utf8");
  const unifiedInput = source.slice(source.indexOf("const UnifiedIntakeInput"), source.indexOf("const GoalQueryInput"));
  const captureTool = source.slice(source.indexOf("const CAPTURE_ITEM_TOOL"), source.indexOf("const GET_GOALS_TOOL"));
  assert.match(unifiedInput, /recurrence: RecurrenceInput\.optional/);
  assert.match(captureTool, /recurrence: RECURRENCE_TOOL_SCHEMA/);
  assert.match(source, /每周三=weekly with weekday 3/);
  assert.match(source, /never say recurrence is unsupported/);
  assert.match(source, /version: "1\.7\.0"/);
});

test("reminder recovery and amendment report pending outcomes as errors", async () => {
  const source = await readFile(mcpPath, "utf8");
  assert.match(source, /item\.success !== true \|\| item\.verified !== true/);
  assert.match(source, /result\.success !== true \|\| result\.verified !== true/);
  assert.match(source, /recovery_version: z\.number\(\)\.int\(\)\.min\(0\)/);
  assert.match(source, /has_more/);
});
