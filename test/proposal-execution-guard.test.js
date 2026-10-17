import test from "node:test";
import assert from "node:assert/strict";
import { prepareNewTaskProposal, proposalGuardError } from "../supabase/functions/_shared/proposal-execution-scope.js";
import { evaluateAutonomy } from "../supabase/functions/_shared/autonomy-policy.js";
import { normalizeIntake } from "../supabase/functions/_shared/personal-os-intake.js";
import { frozenIntake } from "../supabase/functions/_shared/request-recovery.js";
import { createExistingSessionAuthenticator, createTaskProposalHandler } from "../supabase/functions/_shared/task-proposal-runtime.js";

const owner = "11111111-1111-4111-8111-111111111111";
async function fixture() {
  const p = await prepareNewTaskProposal({ raw_text: "下周提醒我整理虚构档案", title: "整理虚构档案", reminder_policy: "none" });
  const policy = evaluateAutonomy({ ...p.intakeInput, source: "chatgpt" }, { baseDate: p.receivedAt });
  return { p, policy, intake: normalizeIntake(frozenIntake(policy.input, p.receivedAt), { baseDate: p.receivedAt }),
    guard: { proposal_id: "33333333-3333-4333-8333-333333333333", owner_id: owner, account_subject: "account-one", version: 1, scope_digest: p.digest } };
}
test("preview freezes relative dates and exactly matches repeated normal preparation", async () => {
  const f = await fixture(); const again = await prepareNewTaskProposal(f.p.intakeInput, { receivedAt: f.p.receivedAt });
  assert.equal(again.digest, f.p.digest);
  assert.equal(await proposalGuardError(f.guard, f.intake, { account_subject: "account-one" }, owner, f.policy), null);
});
for (const field of ["title", "notes", "due", "raw_text"]) test(`final intake guard detects changed ${field}`, async () => {
  const f = await fixture(); f.intake[field] = "changed";
  assert.equal(await proposalGuardError(f.guard, f.intake, { account_subject: "account-one" }, owner, f.policy), "PROPOSAL_SCOPE_CHANGED");
});
test("final guard binds owner/account and cannot turn an information decision into authorization", async () => {
  const f = await fixture();
  assert.equal(await proposalGuardError(f.guard, f.intake, { account_subject: "different" }, owner, f.policy), "PROPOSAL_ACCOUNT_CHANGED");
  assert.equal(await proposalGuardError(f.guard, f.intake, { account_subject: "account-one" }, "22222222-2222-4222-8222-222222222222", f.policy), "PROPOSAL_ACCOUNT_CHANGED");
  assert.equal(evaluateAutonomy({ type: "task", confirmed: true, raw_text: "怎么整理虚构档案？", proposal_guard: f.guard }).intent, "information");
});
test("unsupported confirmation fields in proposal input and guard fail closed", async () => {
  await assert.rejects(prepareNewTaskProposal({ raw_text: "下周整理虚构档案", confirmed: true }), { code: "PROPOSAL_INPUT_INVALID" });
  const f = await fixture();
  assert.equal(await proposalGuardError({ ...f.guard, approved: true }, f.intake, { account_subject: "account-one" }, owner, f.policy), "PROPOSAL_GUARD_INVALID");
});
test("existing Auth server response, not JWT text or user_metadata, determines the principal", async () => {
  let returnedId = "22222222-2222-4222-8222-222222222222", calls = 0;
  const authenticate = createExistingSessionAuthenticator({ supabaseURL: "https://fixture.invalid", publishableKey: "fixture-public", ownerId: owner,
    fetcher: async url => { calls += 1; assert.match(url, /\/auth\/v1\/user$/); return Response.json({ id: returnedId, user_metadata: { owner_id: owner, role: "admin" } }); } });
  const request = new Request("https://fixture.invalid/proposals", { headers: { Authorization: "Bearer fixture-only" } });
  await assert.rejects(authenticate(request), { code: "AUTH_REQUIRED" });
  returnedId = owner; assert.deepEqual(await authenticate(request), { ownerId: owner }); assert.equal(calls, 2);
});
test("an unconfigured real handler never accepts caller-supplied identity/confirmation", async () => {
  const response = await createTaskProposalHandler()(new Request("https://fixture.invalid/proposals", { method: "POST", body: JSON.stringify({ owner_id: owner, confirmed: true }) }));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, "PROPOSAL_BINDING_UNAVAILABLE");
});
test("the request stream is bounded before any proposal insert", async () => {
  let inserts = 0;
  const handler = createTaskProposalHandler({ store: { create: () => { inserts += 1; } }, authenticateUser: async () => ({ ownerId: owner }), resolveAccount: async () => "fixture-account" });
  const response = await handler(new Request("https://fixture.invalid/proposals", { method: "POST", body: "x".repeat(65537) }));
  assert.equal(response.status, 413); assert.equal(inserts, 0);
});
