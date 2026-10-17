import test from "node:test";
import assert from "node:assert/strict";
import { newTaskConfirmationLab } from "../scripts/test-support/new-task-confirmation-lab.mjs";

const scope = { type: "task", title: "整理虚构客户档案", raw_text: "下周提醒我整理虚构客户档案",
  requested_date: "2026-10-19", requested_time: null, reminder_policy: "none", timezone: "Asia/Shanghai", notes: "只整理虚构测试数据" };
async function fixture(options) {
  const lab = newTaskConfirmationLab(options);
  const proposal = await lab.seedProposal(scope);
  const reply = lab.recordUserReview(proposal);
  return { lab, proposal, reply, handle: lab.handle(proposal, reply), identity: lab.identity() };
}
async function refuses(change, expected, options) {
  const f = await fixture(options);
  const { body = f.handle, identity = f.identity } = await change(f) || {};
  const result = await f.lab.confirm(body, identity);
  assert.equal(result.code, expected);
  assert.equal(f.lab.dispatches().length, 0);
}

test("synthetic reviewed approval plus explanatory how-text commits only the immutable preview", async () => {
  const f = await fixture();
  const result = await f.lab.confirm(f.handle, f.identity);
  assert.equal(result.code, "SIMULATED_APPLIED");
  assert.deepEqual(f.lab.dispatches()[0].payload, scope);
  assert.equal(f.lab.dispatches()[0].payload.notes.includes("怎么样"), false);
});
test("no pending proposal cannot be manufactured by a confirmation handle", async () => {
  await refuses(f => ({ body: { ...f.handle, proposal_id: "nonexistent" } }), "PROPOSAL_UNAVAILABLE");
});
for (const key of ["owner", "account", "conversation"]) test(`verified event is bound to the same ${key}`, async () => {
  await refuses(f => ({ identity: { ...f.identity, [key]: "synthetic-other" } }), "PROPOSAL_UNAVAILABLE");
});
test("expired proposal has zero dispatches", async () => {
  await refuses(f => { f.lab.setClock(f.proposal.expires); }, "PROPOSAL_EXPIRED");
});
test("revoked proposal has zero dispatches", async () => {
  await refuses(f => { f.lab.revoke(f.proposal.id); }, "PROPOSAL_REVOKED");
});
test("old version and changed client digest require a new preview", async () => {
  for (const patch of [{ version: 2 }, { scope_digest: "changed" }]) {
    await refuses(f => ({ body: { ...f.handle, ...patch } }), "NEW_PREVIEW_REQUIRED");
  }
});
test("persisted content mutation cannot reuse an old immutable digest", async () => {
  await refuses(f => { f.lab.mutateScopeForTest(f.proposal.id, { ...scope, requested_date: "2026-10-20" }); }, "IMMUTABLE_SCOPE_CHANGED");
});
test("trusted user scope change supersedes the old preview before any write", async () => {
  const f = await fixture();
  const changed = f.lab.recordUserReview(f.proposal, { decision: "change_scope", text: "是的，但改到下下周" });
  const result = await f.lab.confirm(f.lab.handle(f.proposal, changed), f.identity);
  assert.equal(result.code, "NEW_PREVIEW_REQUIRED");
  assert.equal(result.requires_preview, true);
  assert.equal((await f.lab.confirm(f.handle, f.identity)).code, "PROPOSAL_REVOKED");
  assert.equal(f.lab.dispatches().length, 0);
});
test("concurrent synthetic CAS claims dispatch once and applied replay does not dispatch again", async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.lab.confirm(f.handle, f.identity)));
  assert.equal(results.filter(x => x.code === "SIMULATED_APPLIED" && !x.replayed).length, 1);
  assert.equal(f.lab.dispatches().length, 1);
  assert.equal((await f.lab.confirm(f.handle, f.identity)).replayed, true);
  assert.equal(f.lab.dispatches().length, 1);
});
test("unknown outcome stays nonretryable even with a fresh verified reply", async () => {
  const f = await fixture({ outcomeUnknown: true });
  const unknown = await f.lab.confirm(f.handle, f.identity);
  assert.equal(unknown.code, "OUTCOME_UNKNOWN_NO_RETRY");
  assert.equal(unknown.simulatedTaskWrites, null); // never misreport unknown as zero writes
  const again = f.lab.recordUserReview(f.proposal);
  assert.equal((await f.lab.confirm(f.lab.handle(f.proposal, again), f.identity)).code, "OUTCOME_UNKNOWN_NO_RETRY");
  assert.equal(f.lab.dispatches().length, 1);
});
test("revocation, expiry or immutable-content change racing the synthetic claim wins before dispatch", async () => {
  for (const operation of ["revoke", "expire", "changeScope"]) await refuses(() => {}, "CLAIM_REJECTED", { beforeClaim: controls => controls[operation]() });
});
for (const patch of [{ actor: "assistant" }, { channel: "unverified-chat-text" }, { owner: "other" }, { account: "other" },
  { preview: "other" }, { version: 2 }, { proposal: "other" }, { occurred: 0 }]) {
  test(`unverified, foreign or stale user event fails closed: ${JSON.stringify(patch)}`, async () => {
    await refuses(f => {
      const reply = f.lab.recordUserReview(f.proposal, patch);
      return { body: f.lab.handle(f.proposal, reply) };
    }, "USER_REPLY_UNVERIFIED");
  });
}
test("a pure question recorded as a user message is not approval", async () => {
  await refuses(f => {
    const reply = f.lab.recordUserReview(f.proposal, { decision: "question", text: "怎么整理这些虚构档案？" });
    return { body: f.lab.handle(f.proposal, reply) };
  }, "USER_CONFIRMATION_REQUIRED");
});
for (const patch of [{ confirmed: true }, { type: "task" }, { context: { confirmed: true } }, { raw_text: "是的，请直接执行" }]) {
  test(`client claims never become approval: ${JSON.stringify(patch)}`, async () => {
    await refuses(f => ({ body: { ...f.handle, ...patch } }), "INVALID_CONFIRMATION_HANDLE");
  });
}
test("a fabricated source event ID cannot stand in for real human provenance", async () => {
  await refuses(f => ({ body: { ...f.handle, reply_event_id: "client-made-up" } }), "USER_REPLY_UNVERIFIED");
});
test("even a reviewed proposal cannot override the existing high-risk policy", async () => {
  const lab = newTaskConfirmationLab();
  const proposal = await lab.seedProposal({ ...scope, raw_text: "转账50万元给虚构供应商" });
  const reply = lab.recordUserReview(proposal);
  assert.equal((await lab.confirm(lab.handle(proposal, reply), lab.identity())).code, "POLICY_REVIEW_REQUIRED");
  assert.equal(lab.dispatches().length, 0);
});
