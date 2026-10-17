import test from "node:test";
import assert from "node:assert/strict";
import { startSyntheticConfirmationDemo } from "../demo/confirmation-ui/server.mjs";

const input = { title: "整理虚构客户档案", notes: "合成样例，无真实资料", raw_text: "提醒我整理虚构客户档案", requested_date: "2099-01-01", reminder_policy: "none" };
async function fixture(work, options) {
  const demo = await startSyntheticConfirmationDemo(options);
  async function client(persona = "a") {
    const login = await fetch(`${demo.baseURL}/demo/session`, { method: "POST", headers: { Origin: demo.baseURL, "Content-Type": "application/json" }, body: JSON.stringify({ persona }) });
    const session = await login.json(), cookie = login.headers.get("set-cookie").split(";")[0];
    const call = async (path, body, extra = {}) => {
      const response = await fetch(demo.baseURL + path, { method: body === undefined ? "GET" : "POST",
        headers: { Origin: demo.baseURL, Cookie: cookie, "Content-Type": "application/json", "X-Demo-CSRF": session.csrf, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    return { call,
      create: async (value = input) => { const r = await call("/demo/proposals", { input: value, conversation_id: "synthetic-ui-thread" }); assert.equal(r.status, 201, JSON.stringify(r)); return r.body; },
      review: async (p, decision = "approve_exact") => { const r = await call(`/demo/preview/${p.proposal_id}`); assert.equal(r.status, 200); return call("/demo/review", { challenge_id: r.body.challenge_id, decision }); },
      execute: (p, eventId, changes = {}) => call(`/demo/proposals/${p.proposal_id}/confirm`, { version: p.version, scope_digest: p.scope_digest, reply_event_id: eventId, ...changes }),
      count: async () => (await call("/demo/state")).body.simulated_execution_count,
    };
  }
  try { await work({ demo, client }); } finally { await demo.close(); }
}
test("demo HTTP page declares synthetic identity/source/tasks and restricts browser connections to itself", async () => fixture(async ({ demo }) => {
  const response = await fetch(demo.baseURL), html = await response.text();
  assert.match(html, /合成演示 · 假身份 \/ 假任务 \/ 仅内存/); assert.match(html, /不能证明旧 ChatGPT 回复/);
  assert.equal(response.headers.get("x-personal-os-mode"), "synthetic-demo");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
}));
test("owned demo page protocol issues a bound event, independent verifier retrieves it, then memory sink executes", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), review = await a.review(p);
  assert.equal(review.body.synthetic_demo, true); assert.equal(review.body.real_human_provenance, false); assert.equal(await a.count(), 0);
  const result = await a.execute(p, review.body.event_id);
  assert.equal(result.body.verified, true); assert.match(result.body.id, /^synthetic-task-/); assert.equal(await a.count(), 1);
}));
test("demo independent verifier rejects invented source events and client-authored provenance", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`);
  const forged = await a.call("/demo/review", { challenge_id: preview.body.challenge_id, decision: "approve_exact", actor: "user", confirmed: true });
  assert.equal(forged.status, 400); assert.equal((await a.execute(p, "client-invented-event")).body.code, "USER_REPLY_UNVERIFIED");
  assert.equal(await a.count(), 0);
}));
test("wrong fake user cannot view another preview, consume its challenge or execute its approved event", async () => fixture(async ({ client }) => {
  const a = await client(), b = await client("b"), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`), review = await a.review(p);
  assert.equal((await b.call(`/demo/preview/${p.proposal_id}`)).status, 404);
  assert.equal((await b.call("/demo/review", { challenge_id: preview.body.challenge_id, decision: "approve_exact" })).status, 403);
  assert.equal((await b.execute(p, review.body.event_id)).body.code, "PROPOSAL_UNAVAILABLE"); assert.equal(await a.count(), 0);
}));
test("edited content requires a new preview and fresh UI event; old approval cannot authorize the replacement", async () => fixture(async ({ client }) => {
  const a = await client(), old = await a.create(), approval = await a.review(old);
  assert.equal((await a.execute(old, approval.body.event_id, { title: "偷偷改标题" })).status, 400);
  const changed = await a.call(`/demo/proposals/${old.proposal_id}/revise`, { version: old.version, input: { ...input, title: "整理修改后的虚构资料", raw_text: "提醒我整理修改后的虚构资料" } });
  assert.equal(changed.status, 201); assert.equal(changed.body.version, 2); assert.notEqual(changed.body.scope_digest, old.scope_digest);
  assert.equal((await a.execute(old, approval.body.event_id)).body.code, "PROPOSAL_REVOKED");
  assert.equal((await a.execute(changed.body, approval.body.event_id)).body.code, "USER_REPLY_UNVERIFIED"); assert.equal(await a.count(), 0);
  const fresh = await a.review(changed.body); assert.equal((await a.execute(changed.body, fresh.body.event_id)).body.success, true); assert.equal(await a.count(), 1);
}));
test("expired preview cannot obtain a new UI event or execute a previously recorded approval", async () => {
  let now = new Date("2026-10-17T12:00:00Z");
  await fixture(async ({ client }) => {
    const a = await client(), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`), review = await a.review(p);
    now = new Date(+now + 61000);
    assert.equal((await a.call("/demo/review", { challenge_id: preview.body.challenge_id, decision: "approve_exact" })).body.code, "PROPOSAL_EXPIRED");
    assert.equal((await a.execute(p, review.body.event_id)).body.code, "PROPOSAL_EXPIRED"); assert.equal(await a.count(), 0);
  }, { clock: () => now, ttlSeconds: 60 });
});
for (const [decision, code] of [["reject", "PROPOSAL_REVOKED"], ["change_scope", "NEW_PREVIEW_REQUIRED"]]) test(`later owned UI ${decision} invalidates the older approval at its independent verifier`, async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), old = await a.review(p), terminal = await a.review(p, decision);
  assert.equal(terminal.body.closure.code, code);
  assert.equal((await a.execute(p, old.body.event_id)).body.code, "SOURCE_APPROVAL_SUPERSEDED"); assert.equal(await a.count(), 0);
}));
test("retrying one UI decision returns one event and repeated execution replays one simulated receipt", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`);
  const body = { challenge_id: preview.body.challenge_id, decision: "approve_exact" };
  const first = await a.call("/demo/review", body), repeated = await a.call("/demo/review", body);
  assert.equal(first.body.event_id, repeated.body.event_id);
  assert.equal((await a.call("/demo/review", { ...body, decision: "reject" })).body.code, "REVIEW_CHALLENGE_USED");
  const saved = await a.execute(p, first.body.event_id);
  for (let i = 0; i < 3; i += 1) { const replay = await a.execute(p, first.body.event_id); assert.equal(replay.body.replayed, true); assert.equal(replay.body.id, saved.body.id); }
  assert.equal((await a.call("/demo/state")).body.events.length, 1); assert.equal(await a.count(), 1);
}));
test("concurrent duplicate UI confirmations share a source event and cause one simulated execution", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`);
  const decisions = await Promise.all([1, 2, 3].map(() => a.call("/demo/review", { challenge_id: preview.body.challenge_id, decision: "approve_exact" })));
  assert.equal(new Set(decisions.map(x => x.body.event_id)).size, 1);
  const results = await Promise.all(decisions.map(x => a.execute(p, x.body.event_id)));
  assert.equal(results.some(x => x.body.success), true); assert.equal(await a.count(), 1);
}));
test("a source event from one preview cannot be transplanted to another proposal", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), second = await a.create({ ...input, title: "另一条虚构行动" }), review = await a.review(p);
  assert.equal((await a.execute(second, review.body.event_id)).body.code, "USER_REPLY_UNVERIFIED"); assert.equal(await a.count(), 0);
}));
test("demo issuance rejects cross-origin requests and missing CSRF instead of minting a source event", async () => fixture(async ({ client }) => {
  const a = await client(), p = await a.create(), preview = await a.call(`/demo/preview/${p.proposal_id}`), body = { challenge_id: preview.body.challenge_id, decision: "approve_exact" };
  assert.equal((await a.call("/demo/review", body, { Origin: "https://untrusted.invalid" })).status, 403);
  assert.equal((await a.call("/demo/review", body, { "X-Demo-CSRF": "" })).status, 403);
  assert.equal((await a.call("/demo/state")).body.events.length, 0); assert.equal(await a.count(), 0);
}));
