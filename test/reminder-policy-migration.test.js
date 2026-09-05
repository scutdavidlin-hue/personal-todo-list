import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202609050003_smart_reminder_policy_v1.sql", import.meta.url);

test("Reminder Policy extends the canonical Schedule row instead of creating a task system", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.task_schedule_metadata/i);
  for (const field of [
    "deadline_time",
    "reminder_policy",
    "reminder_policy_source",
    "reminder_reason",
    "reminder_at",
    "reminder_offset_minutes",
    "reminder_type",
    "reminders",
    "reminder_context",
    "notification_channel",
    "notification_status",
  ]) assert.match(sql, new RegExp(`add column if not exists ${field}\\b`, "i"));
  assert.doesNotMatch(sql, /create table(?: if not exists)? public\.(?:tasks|reminders|notifications)/i);
  assert.doesNotMatch(sql, /\btitle\s+text|\btask_status\b|\bcompleted_at\b/i);
});

test("Reminder metadata enforces minimum necessary bounds and projection-only status", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /jsonb_array_length\(reminders\) <= 3/i);
  assert.match(sql, /reminder_offset_minutes between 0 and 40320/i);
  assert.match(sql, /user_explicit.*ai_inferred.*system_default/is);
  assert.match(sql, /notification_status.*pending_projection.*projected.*projection_failed/is);
  assert.match(sql, /does not claim that an iPhone displayed or delivered/i);
});

test("the original Schedule uniqueness contract still preserves one row per Google Task", async () => {
  const original = await readFile(new URL("../supabase/migrations/202609040002_task_scheduling_v1_1.sql", import.meta.url), "utf8");
  const reminder = await readFile(migrationUrl, "utf8");
  assert.match(original, /unique \(owner_id, google_task_id\)/i);
  assert.match(original, /task_schedule_calendar_event_unique/i);
  assert.doesNotMatch(reminder, /drop constraint|drop index|drop table/i);
});
