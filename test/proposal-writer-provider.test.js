import test from "node:test";
import assert from "node:assert/strict";
import { loadTaskStatusProviderSimulation } from "../scripts/test-support/task-status-provider-simulation.mjs";
import { prepareNewTaskProposal } from "../supabase/functions/_shared/proposal-execution-scope.js";
import { executeTaskResolution } from "../supabase/functions/_shared/task-resolution-executor.js";

const owner = "11111111-1111-4111-8111-111111111111";
const proposalId = "33333333-3333-4333-8333-333333333333";
async function input() {
  const p = await prepareNewTaskProposal({ title: "整理虚构客户档案", raw_text: "下周提醒我整理虚构客户档案", requested_date: "2026-10-19", reminder_policy: "none" });
  return { ...p.scope.payload, intake_audit_id: proposalId, resolution_idempotency_key: `proposal:${proposalId}:1`,
    proposal_guard: { proposal_id: proposalId, owner_id: owner, account_subject: "account-one", version: 1, scope_digest: p.digest } };
}
async function providerRequest(body, options) {
  const prior = globalThis.fetch, f = await loadTaskStatusProviderSimulation(options);
  globalThis.fetch = f.fetcher;
  try { const response = await f.request(body); return { status: response.status, body: await response.json(), f }; }
  finally { globalThis.fetch = prior; }
}
test("actual writer validates approved request and the same OAuth subject/token used by Google POST", async () => {
  const result = await providerRequest(await input());
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.resolution.decision, "NEW");
  assert.deepEqual(result.f.writes.map(x => x.method), ["POST"]);
});
for (const [name, change, options, code] of [
  ["title changed after intake", body => ({ ...body, title: "未批准的新标题" }), {}, "PROPOSAL_SCOPE_CHANGED"],
  ["resolver raw text injected after intake", body => ({ ...body, raw_text: "修改旧任务" }), {}, "PROPOSAL_SCOPE_CHANGED"],
  ["guard removed value rather than property", body => ({ ...body, proposal_guard: null }), {}, "PROPOSAL_GUARD_INVALID"],
  ["synthetic subject mismatch at writer", body => body, { account: "account-other" }, "PROPOSAL_ACCOUNT_CHANGED"],
  ["named update action cannot bypass create restriction", body => ({ ...body, action: "update_task", task_id: "existing" }), {}, "PROPOSAL_SCOPE_CHANGED"],
]) test(`actual writer fails before provider mutation: ${name}`, async () => {
  const result = await providerRequest(change(await input()), options);
  assert.equal(result.status, 409); assert.equal(result.body.code, code);
  assert.deepEqual(result.f.writes, []); assert.deepEqual(result.f.audits, []);
});
test("actual executor blocks MERGE before invoking any adapter, even with high resolver confidence", async () => {
  const body = await input(); let calls = 0;
  const adapter = new Proxy({}, { get() { calls += 1; return async () => { calls += 1; }; } });
  await assert.rejects(executeTaskResolution(body, { decision: "MERGE", confidence: 1, existing_task_id: "old-task", update: { notes: "unapproved" } }, adapter), { code: "PROPOSAL_SCOPE_CHANGED" });
  assert.equal(calls, 0);
});
test("ordinary unguarded legacy resolver can still update one exact existing task", async () => {
  const result = await providerRequest({ title: "跟佳佳核对成本", dueDate: "2026-10-19" }, { tasks: [{ id: "old-task", title: "跟佳佳核对成本" }] });
  assert.equal(result.body.resolution.decision, "UPDATE");
  assert.deepEqual(result.f.writes.map(x => ({ method: x.method, id: x.id })), [{ method: "PATCH", id: "old-task" }]);
});
