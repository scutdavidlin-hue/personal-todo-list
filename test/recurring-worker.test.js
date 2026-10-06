import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scheduler = await readFile(new URL("../supabase/functions/task-scheduler/index.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/20260930034636_recurring_task_reconciliation_worker.sql", import.meta.url), "utf8");
const isolationMigration = await readFile(new URL("../supabase/migrations/20260930035113_isolate_recurring_task_worker.sql", import.meta.url), "utf8");

test("scheduler accepts only the configured backend API key for unattended runs", () => {
  assert.match(scheduler, /const apiKey = request\.headers\.get\("apikey"\) \|\| ""/);
  assert.match(scheduler, /SERVICE_API_KEY\.length >= 32 && constantTimeEqual\(apiKey, SERVICE_API_KEY\)/);
  assert.doesNotMatch(scheduler, /if \(apiKey\) return OWNER_USER_ID/);
  assert.match(scheduler, /action === "run_recurrence"[\s\S]*advanceReadySeries\(ownerId\)/);
});

test("recurrence worker uses Supabase Cron, pg_net, and Vault without embedding a secret", () => {
  assert.match(migration, /create extension if not exists pg_cron/);
  assert.match(migration, /create extension if not exists pg_net/);
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, /where name = 'personal_os_scheduler_secret_key'/);
  assert.match(migration, /net\.http_post/);
  assert.match(isolationMigration, /jsonb_build_object\('action', 'run_recurrence'\)/);
  assert.doesNotMatch(isolationMigration, /jsonb_build_object\('action', 'run'\)/);
  assert.match(migration, /'personal-os-task-scheduler-5m',[\s\S]*'\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(migration, /sb_secret_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(migration, /eyJ[A-Za-z0-9_-]+\./);
});

test("worker entrypoint is private and unavailable to client roles", () => {
  assert.match(migration, /security definer/);
  assert.match(migration, /revoke all on schema private from public, anon, authenticated/);
  assert.match(migration, /revoke all on function private\.invoke_personal_os_task_scheduler\(\) from public, anon, authenticated/);
});
