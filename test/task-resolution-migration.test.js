import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/202609050002_task_resolution_layer_v1.sql", import.meta.url);

test("resolution migration extends the provider model without adding a second Task store", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create extension if not exists pg_trgm/i);
  assert.match(sql, /create table if not exists public\.task_resolution_profiles/i);
  assert.match(sql, /create table if not exists public\.task_relationships/i);
  assert.match(sql, /create table if not exists public\.task_resolution_audit/i);
  assert.match(sql, /create table if not exists public\.task_resource_bindings/i);
  assert.match(sql, /google_task_id text not null/i);
  assert.match(sql, /canonical_task_id text not null/i);
  assert.doesNotMatch(sql, /create table if not exists public\.(?:tasks|personal_os_tasks)\s*\(/i);
  assert.match(sql, /not a second Task content or completion store/i);
});

test("all resolution metadata is owner-scoped, RLS-protected, and service-written", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const table of ["task_resolution_audit", "task_resolution_profiles", "task_relationships", "task_resource_bindings"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`, "i"));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }
  assert.match(sql, /owner_id uuid not null references auth\.users\(id\) on delete cascade/i);
  assert.match(sql, /grant execute on function public\.search_task_resolution_profiles[\s\S]+to service_role/i);
  assert.match(sql, /project_id must belong to goal_plan_id/i);
  assert.match(sql, /intake_audit_id must belong to the same owner/i);
  assert.match(sql, /source_intent_id must belong to the same owner/i);
  assert.match(sql, /source_intent_ids must belong to the same owner/i);
});

test("the migration persists explainability, graph, resource, and confidence fields", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  for (const field of [
    "original_intent",
    "normalized_intent",
    "decision",
    "confidence",
    "candidate_snapshot",
    "previous_state",
    "new_state",
    "related_object_ids",
    "reason",
    "source_intent_ids",
    "superseded_by",
    "last_semantic_resolution_at",
  ]) assert.match(sql, new RegExp(`\\b${field}\\b`, "i"));
  assert.match(sql, /'DEPENDS_ON'/);
  assert.match(sql, /'PARENT_OF'/);
  assert.match(sql, /'RELATED_TO'/);
  assert.match(sql, /'CONFLICTS_WITH'/);
  assert.match(sql, /'SHARES_RESOURCE'/);
});

test("the database normalizes symmetric edges and rejects dependency cycles", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /normalize_and_validate_task_relationship/i);
  assert.match(sql, /relationship_type in \('RELATED_TO', 'POTENTIAL_RELATION', 'CONFLICTS_WITH', 'SHARES_RESOURCE'\)/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(new\.owner_id::text, 0\)\)/i);
  assert.match(sql, /with recursive dependency_path/i);
  assert.match(sql, /dependency would create a cycle/i);
});

test("semantic retrieval uses indexed bounded candidate pools", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /with candidate_ids as/i);
  assert.match(sql, /normalized_title <-> coalesce\(query_text, ''\)/i);
  assert.match(sql, /semantic_key <-> coalesce\(query_text, ''\)/i);
  assert.match(sql, /limit greatest\(20, least\(coalesce\(match_count, 20\) \* 3, 100\)\)/i);
});

test("technical idempotency remains distinct from semantic resolution", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /task_resolution_audit_idempotency_unique/i);
  assert.match(sql, /alter table public\.personal_os_intake_audit[\s\S]+resolution_audit_id/i);
  assert.match(sql, /resolution_decision/i);
  assert.match(sql, /resolution_confidence/i);
});
