import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/20260924011757_task_schedule_series.sql", import.meta.url), "utf8");
const upgrade = await readFile(new URL("../supabase/migrations/202609290001_recurring_tasks_v1.sql", import.meta.url), "utf8");

test("series and occurrence mappings are owner scoped and unique", () => {
  assert.match(migration, /unique \(owner_id, anchor_task_id\)/);
  assert.match(migration, /primary key \(series_id, occurrence_date\)/);
  assert.match(migration, /unique \(owner_id, google_task_id\)/);
  assert.match(migration, /task_schedule_series force row level security/);
  assert.match(migration, /task_schedule_occurrence force row level security/);
});

test("upgrade stores RFC-compatible rules and supports the full lifecycle", () => {
  assert.match(upgrade, /recurrence_kind in \('daily', 'weekly', 'monthly', 'yearly'\)/);
  assert.match(upgrade, /status in \('active', 'paused', 'cancelled'\)/);
  assert.match(upgrade, /add column if not exists rrule text/);
  assert.match(upgrade, /add column if not exists next_date_override date/);
  assert.match(upgrade, /add column if not exists skip_date date/);
});

test("recurring_rule_id plus recurrence_instance_date is the idempotency key and skipped history is retained", () => {
  assert.match(upgrade, /recurring_rule_id uuid generated always as \(series_id\) stored/);
  assert.match(upgrade, /recurrence_instance_date date generated always as \(occurrence_date\) stored/);
  assert.match(upgrade, /unique index if not exists task_schedule_occurrence_rule_instance_uidx[\s\S]*recurring_rule_id, recurrence_instance_date/);
  assert.match(upgrade, /instance_status in \('task', 'skipped'\)/);
  assert.match(upgrade, /alter column google_task_id drop not null/);
});

test("claim serializes concurrent advances and cancellation blocks later claims", () => {
  assert.match(migration, /s\.status = 'active'/);
  assert.match(migration, /s\.current_task_id = expected_task/);
  assert.match(migration, /s\.lease_until is null or s\.lease_until < now\(\) or s\.lease_token = claim_token/);
  assert.match(migration, /creation_started = false/);
  assert.match(migration, /status = 'active'[\s\S]*lease_token = claim_token/);
  assert.match(migration, /on conflict \(series_id, occurrence_date\) do nothing/);
});
