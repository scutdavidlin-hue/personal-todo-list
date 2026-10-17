// Explicit integration command: real loopback HTTP + PostgreSQL + actual intake;
// Auth/source/provider adapters only. Never accepts a production database URL.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { createPostgresProposalStore } from "../supabase/functions/_shared/task-proposal-postgres.js";
import { createTaskProposalHandler, createExistingSessionAuthenticator, createExistingAccountResolver } from "../supabase/functions/_shared/task-proposal-runtime.js";
import { prepareNewTaskProposal, scopeHash } from "../supabase/functions/_shared/proposal-execution-scope.js";
import { loadIntakeSimulation } from "./test-support/capture-intake-simulation.mjs";
import { loadTaskStatusProviderSimulation } from "./test-support/task-status-provider-simulation.mjs";

let connectionString = process.env.PERSONAL_OS_TEST_PG_URL;
if (!connectionString) throw new Error("Explicit disposable fixture URL is required");
const url = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/proposal_fixture") throw new Error("Only loopback proposal_fixture is allowed");
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const nativeFetch = globalThis.fetch;
const command = { raw_text: "下周提醒我整理虚构客户档案，并研究怎么样做封装", title: "整理虚构客户档案", reminder_policy: "none", requested_date: "2026-10-19" };
let pool;
function connectPool() { const result = new pg.Pool({ connectionString, max: 16, connectionTimeoutMillis: 1000 }); result.on("error", () => {}); return result; }
before(async () => {
  pool = connectPool();
  assert.equal((await pool.query("select current_database() as name")).rows[0].name, "proposal_fixture");
  await pool.query(`create schema if not exists auth; create table if not exists auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${other}') on conflict do nothing;
    do $$ begin if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if; end $$;
    drop schema if exists task_create_private cascade;`);
  await pool.query(await readFile(new URL("../supabase/sql/task-create-proposals.sql", import.meta.url), "utf8"));
});
after(async () => { await pool?.end(); });

async function fixture({ missingSource = false, intakeOptions, providerOptions, mutateSend, prepare = prepareNewTaskProposal, beforeAccount, clock } = {}) {
  const provider = providerOptions ? await loadTaskStatusProviderSimulation(providerOptions) : null;
  const intake = await loadIntakeSimulation({ ...intakeOptions, ...(provider ? { taskStatusProvider: provider } : {}) });
  const events = new Map();
  let account = "account-one", handler, baseURL;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === "/auth/v1/user") {
      const id = incoming.headers.authorization === "Bearer fixture-user" ? owner : other;
      outgoing.writeHead(200, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify({ id, user_metadata: { role: "admin" } })); return;
    }
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(baseURL + incoming.url, { method: incoming.method, headers: incoming.headers,
        ...(incoming.method !== "GET" ? { body: Buffer.concat(chunks).toString() } : {}) });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end('{"success":false}'); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  const store = createPostgresProposalStore(pool);
  handler = createTaskProposalHandler({ store, prepare, ...(clock ? { clock } : {}),
    authenticateUser: createExistingSessionAuthenticator({ supabaseURL: baseURL, publishableKey: "fixture-public", ownerId: owner, fetcher: nativeFetch }),
    resolveAccount: createExistingAccountResolver(async input => {
      assert.equal(input.action, "account_context"); if (beforeAccount) await beforeAccount(); return { account_subject: account };
    }, owner),
    verifyReplySource: missingSource ? undefined : async ({ replyEventId }) => structuredClone(events.get(replyEventId)),
    trustedAuthorities: missingSource ? [] : ["fixture-source"],
    sendIntake: async (input, key) => {
      if (mutateSend) input = await mutateSend(input);
      return (await intake.request({ ...input, idempotency_key: key })).json();
    },
  });
  const request = async (path, body, token = "fixture-user", method = "POST") => {
    const response = await nativeFetch(baseURL + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { store, intake, provider, request,
    create: async (input = command, conversation_id = "fixture-thread") => {
      const result = await request("/proposals", { input, conversation_id }); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body;
    },
    async review(proposal, changes = {}) {
      const event = { authority: "fixture-source", eventId: crypto.randomUUID(), actor: "user", ownerId: owner,
        accountSubject: account, conversationId: "fixture-thread", proposalId: proposal.proposal_id,
        previewId: proposal.preview_id, version: proposal.version, scopeDigest: proposal.scope_digest,
        disposition: "approve_exact", occurredAt: new Date().toISOString(),
        explanation: "是的是的，因为我在考虑怎么样封装虚构数据。", ...changes };
      event.proofDigest = await scopeHash(event);
      events.set(event.eventId, event); return event;
    },
    confirm: (proposal, event, changes = {}) => request(`/proposals/${proposal.proposal_id}/confirm`, { version: proposal.version, scope_digest: proposal.scope_digest, reply_event_id: event.eventId, ...changes }),
    setAccount: value => { account = value; },
    async close() { await new Promise(resolve => server.close(resolve)); intake.restore(); },
  };
}
async function withFixture(work, options) { const f = await fixture(options); try { await work(f); } finally { await f.close(); } }

test("HTTP -> durable proposal -> bound explanatory approval -> actual intake mock writes and reads once", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p); const result = await f.confirm(p, e);
    assert.equal(result.body.success, true, JSON.stringify(result));
    assert.equal(result.body.write_success, true); assert.equal(result.body.verified, true);
    assert.equal(f.intake.createAttempts(), 1);
    assert.equal((await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "applied");
    const create = f.intake.writes.find(x => x.path.endsWith("/functions/v1/task-status") && x.body?.title);
    assert.equal(create.body.title, command.title); assert.equal(create.body.dueDate, "2026-10-19");
    assert.equal(create.body.notes.includes(e.explanation), false);
  });
});
test("missing real reply source fails closed after persistence, before claim/provider", async () => {
  await withFixture(async f => {
    const p = await f.create(); const result = await f.confirm(p, { eventId: "client-made-up" });
    assert.equal(result.body.code, "TRUSTED_REPLY_SOURCE_UNAVAILABLE"); assert.equal(f.intake.createAttempts(), 0);
    assert.equal((await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "pending");
  }, { missingSource: true });
});
test("server-verified session identity and canonical account override all client identity claims", async () => {
  await withFixture(async f => {
    assert.equal((await f.request("/proposals", { input: command, conversation_id: "fixture-thread" }, "forged-admin")).status, 401);
    const p = await f.create(); const e = await f.review(p);
    assert.equal((await f.confirm(p, e, { owner_id: owner, confirmed: true })).status, 400);
    f.setAccount("account-other"); assert.equal((await f.confirm(p, e)).body.code, "PROPOSAL_UNAVAILABLE");
    assert.equal(f.intake.createAttempts(), 0);
    assert.equal(await f.store.get(p.proposal_id, { ownerId: other, accountSubject: "account-one" }), null);
  });
});
for (const patch of [{ actor: "assistant" }, { authority: "client-authority" }, { accountSubject: "account-other" },
  { previewId: "00000000-0000-4000-8000-000000000001" }, { version: 100 }, { occurredAt: "2000-01-01T00:00:00Z" }]) {
  test(`untrusted or incorrectly bound reply never claims: ${JSON.stringify(patch)}`, async () => {
    await withFixture(async f => { const p = await f.create(); const e = await f.review(p, patch);
      assert.equal((await f.confirm(p, e)).body.code, "USER_REPLY_UNVERIFIED"); assert.equal(f.intake.createAttempts(), 0); });
  });
}
test("revocation, old version and changed hash all stop before a Task write", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p);
    assert.equal((await f.confirm(p, e, { version: 2 })).body.code, "NEW_PREVIEW_REQUIRED");
    assert.equal((await f.confirm(p, e, { scope_digest: "0".repeat(64) })).body.code, "NEW_PREVIEW_REQUIRED");
    assert.equal((await f.request(`/proposals/${p.proposal_id}/revoke`, { version: p.version })).status, 200);
    assert.equal((await f.confirm(p, e)).body.code, "PROPOSAL_REVOKED"); assert.equal(f.intake.createAttempts(), 0);
  });
});
test("changed scope creates a new immutable preview/version; old approval cannot execute", async () => {
  await withFixture(async f => {
    const p = await f.create(); const old = await f.review(p);
    const revised = await f.request(`/proposals/${p.proposal_id}/revise`, { version: p.version, input: { ...command, requested_date: "2026-10-20" } });
    assert.equal(revised.status, 201); const next = revised.body; assert.equal(next.version, 2); assert.notEqual(next.scope_digest, p.scope_digest);
    assert.equal((await f.confirm(p, old)).body.code, "PROPOSAL_REVOKED"); assert.equal(f.intake.createAttempts(), 0);
    assert.equal((await f.confirm(next, await f.review(next))).body.success, true); assert.equal(f.intake.createAttempts(), 1);
  });
});
test("trusted source reporting a question or scope change never authorizes creation", async () => {
  await withFixture(async f => {
    const p = await f.create();
    assert.equal((await f.confirm(p, await f.review(p, { disposition: "question" }))).body.code, "USER_CONFIRMATION_REQUIRED");
    assert.equal((await f.confirm(p, await f.review(p, { disposition: "change_scope" }))).body.code, "NEW_PREVIEW_REQUIRED");
    assert.equal(f.intake.createAttempts(), 0);
  });
});
test("12 concurrent HTTP confirmations across PostgreSQL connections dispatch once; replay never dispatches", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.confirm(p, e)));
    assert.equal(results.some(x => x.body.success === true), true, JSON.stringify(results));
    assert.equal(f.intake.createAttempts(), 1);
    assert.equal((await f.confirm(p, e)).body.replayed, true); assert.equal(f.intake.createAttempts(), 1);
  });
});
test("unknown actual intake outcome remains durable and cannot trigger another provider attempt", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p); const result = await f.confirm(p, e);
    assert.equal(result.status, 202); assert.equal(f.intake.createAttempts(), 1);
    assert.equal((await f.confirm(p, await f.review(p))).body.code, "OUTCOME_UNKNOWN_NO_RETRY");
    assert.equal(f.intake.createAttempts(), 1);
  }, { intakeOptions: { unknownCreateOnce: true } });
});
test("a guarded prewrite Auth interruption cannot use legacy recover as another writer", async () => {
  await withFixture(async f => {
    const p = await f.create(); const result = await f.confirm(p, await f.review(p));
    assert.equal(result.status, 202); assert.equal(f.intake.createAttempts(), 0);
    assert.ok(f.intake.getAudit().request_payload.original_input.proposal_guard);
    const recovered = await (await f.intake.request({ action: "recover", request_id: result.body.request_id })).json();
    assert.equal(recovered.results[0].code, "PROPOSAL_RECONCILIATION_REQUIRED");
    assert.equal(f.intake.createAttempts(), 0); assert.equal(f.intake.getAudit().next_retry_at, null);
    const amended = await (await f.intake.request({ action: "amend_request", request_id: result.body.request_id,
      recovery_version: f.intake.getAudit().recovery_version, requested_date: "2026-10-20", requested_time: "12:00" })).json();
    assert.equal(amended.code, "PROPOSAL_REPREVIEW_REQUIRED");
    assert.ok(f.intake.getAudit().request_payload.original_input.proposal_guard); assert.equal(f.intake.createAttempts(), 0);
  }, { intakeOptions: { contextAuthFailureOnce: true } });
});
test("guarded unknown/background recovery never retries and retains a known verified Task receipt", async () => {
  await withFixture(async f => {
    const p = await f.create(); const first = await f.confirm(p, await f.review(p));
    assert.equal(first.body.verified, true); assert.equal(f.intake.createAttempts(), 1);
    assert.ok(f.intake.getAudit().request_payload.proposal_guard);
    f.intake.mutateAudit({ stage: "projection_pending", next_retry_at: "2000-01-01T00:00:00Z", lease_owner: null, lease_expires_at: null });
    const recovered = await (await f.intake.request({ action: "recover_due" })).json();
    assert.equal(recovered.results[0].code, "PROPOSAL_RECONCILIATION_REQUIRED");
    assert.equal(recovered.results[0].verified, true); assert.equal(recovered.results[0].id, first.body.id);
    assert.equal(f.intake.createAttempts(), 1);
  });
});
test("database time enforces expiry even when the application clock is stale", async () => {
  const past = new Date(Date.now() - 1200000);
  await withFixture(async f => { const p = await f.create(); const e = await f.review(p, { occurredAt: past.toISOString() });
    assert.equal((await f.confirm(p, e)).body.code, "PROPOSAL_EXPIRED"); assert.equal(f.intake.createAttempts(), 0);
  }, { clock: () => past });
});
test("real SQL revocation wins after claim and before the atomic dispatch gate", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p); const identity = { ownerId: owner, accountSubject: "account-one" };
    const claim = await f.store.claim(p.proposal_id, identity, p.version, p.scope_digest, e);
    assert.equal((await f.request(`/proposals/${p.proposal_id}/revoke`, { version: p.version })).status, 200);
    await assert.rejects(f.store.beginDispatch(claim.row, claim.token, identity), { code: "CLAIM_CLOSED" });
    assert.equal(f.intake.createAttempts(), 0);
  });
});
test("once dispatch starts, cancellation is reported honestly and another confirmation remains fenced", async () => {
  await withFixture(async f => {
    const p = await f.create(); const e = await f.review(p); const identity = { ownerId: owner, accountSubject: "account-one" };
    const claim = await f.store.claim(p.proposal_id, identity, p.version, p.scope_digest, e);
    await f.store.beginDispatch(claim.row, claim.token, identity);
    assert.equal((await f.request(`/proposals/${p.proposal_id}/revoke`, { version: p.version })).body.code, "DISPATCH_ALREADY_STARTED");
    assert.equal((await f.confirm(p, e)).body.code, "PROPOSAL_IN_PROGRESS"); assert.equal(f.intake.createAttempts(), 0);
  });
});
test("a verified source event cannot be consumed for a second proposal", async () => {
  await withFixture(async f => {
    const first = await f.create(); const e = await f.review(first); assert.equal((await f.confirm(first, e)).body.success, true);
    const second = await f.create({ ...command, title: "第二条虚构资料" }); const reused = await f.review(second, { eventId: e.eventId });
    assert.equal((await f.confirm(second, reused)).body.code, "SOURCE_EVENT_REPLAYED"); assert.equal(f.intake.createAttempts(), 1);
  });
});
test("final actual intake scope/account constraints reject changes after the proposal claim", async () => {
  for (const change of [input => ({ ...input, notes: "changed after approval" }), input => ({ ...input, proposal_guard: { ...input.proposal_guard, account_subject: "wrong-account" } })]) {
    await withFixture(async f => { const p = await f.create(); const result = await f.confirm(p, await f.review(p));
      assert.ok(["PROPOSAL_SCOPE_CHANGED", "PROPOSAL_ACCOUNT_CHANGED"].includes(result.body.code), JSON.stringify(result));
      assert.equal(f.intake.createAttempts(), 0); assert.equal(f.intake.getAudit().stage, "needs_input");
    }, { mutateSend: change });
  }
});
test("pure information and high-risk inputs persist no new proposal", async () => {
  await withFixture(async f => {
    const count = (await pool.query("select count(*) from task_create_private.proposals")).rows[0].count;
    for (const raw_text of ["是的是的，因为我在考虑怎么样封装虚构数据", "怎么整理这些虚构客户档案？", "转账50万元给虚构供应商"]) {
      const result = await f.request("/proposals", { input: { ...command, raw_text }, conversation_id: "fixture-thread" });
      assert.equal(result.body.success, false);
    }
    assert.equal((await pool.query("select count(*) from task_create_private.proposals")).rows[0].count, count); assert.equal(f.intake.createAttempts(), 0);
  });
});
test("SQL immutability, no client grants and parameterized content are enforced by PostgreSQL", async () => {
  await withFixture(async f => {
    const p = await f.create({ ...command, title: "虚构'; drop table auth.users; --" });
    await assert.rejects(pool.query("update task_create_private.proposals set scope_digest=$2 where id=$1", [p.proposal_id,"0".repeat(64)]));
    assert.equal((await pool.query("select count(*) from auth.users")).rows[0].count, "2");
    const client = await pool.connect();
    try { await client.query("begin"); await client.query("set local role authenticated");
      await assert.rejects(client.query("select * from task_create_private.proposals"), /permission denied/);
    } finally { await client.query("rollback"); client.release(); }
  });
});
test("trusted reject atomically terminates pending proposal and consumes its source event; earlier approval stays closed", async () => {
  await withFixture(async f => {
    const p = await f.create(), old = await f.review(p), reject = await f.review(p, { disposition: "reject" });
    const rejected = await f.confirm(p, reject);
    if (rejected.body.code !== "PROPOSAL_REVOKED") {
      const oldResult = await f.confirm(p, old);
      assert.fail(JSON.stringify({ rejectionCode: rejected.body.code, earlierApprovalSuccess: oldResult.body.success, simulatedIntakeCreates: f.intake.createAttempts() }));
    }
    assert.equal((await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "revoked");
    assert.equal((await f.confirm(p, old)).body.code, "PROPOSAL_REVOKED");
    assert.equal((await pool.query("select count(*) from task_create_private.reply_events where authority=$1 and event_id=$2", [reject.authority, reject.eventId])).rows[0].count, "1");
    const second = await f.create({ ...command, title: "第二条独立虚构事项" });
    const replay = await f.review(second, { disposition: "reject", eventId: reject.eventId });
    assert.equal((await f.confirm(second, replay)).body.code, "SOURCE_EVENT_REPLAYED");
    assert.equal((await f.store.get(second.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "pending");
    assert.equal(f.intake.createAttempts(), 0);
  });
});
for (const disposition of ["reject", "change_scope"]) test(`trusted ${disposition} after claim closes the real SQL dispatch gate`, async () => {
  await withFixture(async f => {
    const p = await f.create(), old = await f.review(p), identity = { ownerId: owner, accountSubject: "account-one" };
    const claim = await f.store.claim(p.proposal_id, identity, p.version, p.scope_digest, old);
    const stop = await f.review(p, { disposition });
    assert.equal((await f.confirm(p, stop)).body.code, disposition === "reject" ? "PROPOSAL_REVOKED" : "NEW_PREVIEW_REQUIRED");
    assert.equal((await f.store.get(p.proposal_id, identity)).status, disposition === "reject" ? "revoked" : "superseded");
    await assert.rejects(f.store.beginDispatch(claim.row, claim.token, identity), { code: "CLAIM_CLOSED" });
    assert.equal((await f.confirm(p, old)).body.code, "PROPOSAL_REVOKED"); assert.equal(f.intake.createAttempts(), 0);
  });
});
for (const disposition of ["reject", "change_scope"]) test(`concurrent HTTP ${disposition} wins while approval is paused after real claim`, { timeout: 10000 }, async () => {
  let calls = 0, claimed, release;
  const atClaim = new Promise(resolve => { claimed = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await withFixture(async f => {
    const p = await f.create(), old = await f.review(p);
    const approval = f.confirm(p, old);
    try {
      await atClaim;
      assert.equal((await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "claimed");
      const stopped = await f.confirm(p, await f.review(p, { disposition }));
      assert.equal(stopped.body.code, disposition === "reject" ? "PROPOSAL_REVOKED" : "NEW_PREVIEW_REQUIRED");
    } finally { release(); }
    assert.equal((await approval).body.code, "CLAIM_CLOSED"); assert.equal(f.intake.createAttempts(), 0);
  }, { beforeAccount: async () => { if (++calls === 4) { claimed(); await gate; } } });
});
test("trusted terminal replies after dispatch report that cancellation can no longer be guaranteed", async () => {
  await withFixture(async f => {
    const p = await f.create(), e = await f.review(p), identity = { ownerId: owner, accountSubject: "account-one" };
    const claim = await f.store.claim(p.proposal_id, identity, p.version, p.scope_digest, e);
    await f.store.beginDispatch(claim.row, claim.token, identity);
    for (const disposition of ["reject", "change_scope"]) {
      assert.equal((await f.confirm(p, await f.review(p, { disposition }))).body.code, "DISPATCH_ALREADY_STARTED");
    }
    assert.equal((await f.store.get(p.proposal_id, identity)).status, "dispatching"); assert.equal(f.intake.createAttempts(), 0);
  });
});
for (const [label, input, providerOptions] of [
  ["UPDATE", { ...command, title: "跟佳佳核对成本", raw_text: "下周提醒我跟佳佳核对成本" }, { tasks: [{ id: "existing-task", title: "跟佳佳核对成本", notes: "" }] }],
  ["PARENT_CHILD", { ...command, title: "做完整经营分析，包括收入、成本、人效和客户集中度。", raw_text: "下周提醒我做完整经营分析，包括收入、成本、人效和客户集中度。" }, {}],
  ["GOAL_LINK", { ...command, title: "做 Task Semantic Resolution", raw_text: "下周提醒我做 Task Semantic Resolution" }, { goals: [{ id: "goal-personal-os", title: "Personal OS 产品化", description: "把 Personal OS 做成可以长期使用的产品", status: "Active" }] }],
]) test(`real HTTP/PG/intake/task-status/resolver rejects unapproved ${label} before fake Google writes`, async () => {
  await withFixture(async f => {
    const p = await f.create(input), result = await f.confirm(p, await f.review(p));
    assert.equal(result.body.code, "PROPOSAL_SCOPE_CHANGED", JSON.stringify({ result, mutations: f.provider.writes.map(x => ({ method: x.method, id: x.id, parent: x.parent })), decisions: f.provider.audits.map(x => x.decision) }));
    assert.deepEqual(f.provider.writes, []); assert.deepEqual(f.provider.audits, []);
    assert.equal(result.body.outcome, "rejected"); assert.equal(f.intake.getAudit().stage, "needs_input"); assert.equal(f.intake.getAudit().next_retry_at, null);
    assert.equal((await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" })).status, "rejected");
  }, { providerOptions });
});
test("real HTTP/PG/intake/task-status/resolver permits exactly one approved independent create", async () => {
  await withFixture(async f => {
    const p = await f.create(), e = await f.review(p), result = await f.confirm(p, e);
    assert.equal(result.body.success, true, JSON.stringify(result)); assert.equal(result.body.verified, true);
    assert.deepEqual(f.provider.writes.map(x => x.method), ["POST"]);
    assert.equal(f.provider.writes[0].parent, null); assert.equal(f.provider.audits.length, 1);
    assert.equal((await f.confirm(p, e)).body.replayed, true); assert.equal(f.provider.writes.length, 1);
  }, { providerOptions: {} });
});
test("applied receipt survives connection/process loss and a real PostgreSQL container restart", async () => {
  let p;
  await withFixture(async f => { p = await f.create(); assert.equal((await f.confirm(p, await f.review(p))).body.success, true); });
  const container = process.env.PERSONAL_OS_TEST_PG_CONTAINER;
  if (!container || !/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error("Labeled disposable container required for restart evidence");
  const metadata = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }));
  assert.equal(metadata[0].Config.Labels["personal-os.proposal-fixture"], "true");
  await pool.end(); pool = null;
  execFileSync("docker", ["restart", container], { stdio: "pipe" });
  // Docker may reassign an automatically allocated host port on restart.
  const restarted = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8" }))[0];
  url.port = restarted.NetworkSettings.Ports["5432/tcp"][0].HostPort;
  connectionString = url.href;
  pool = connectPool();
  for (let attempt = 0; ; attempt += 1) {
    try { await pool.query("select 1"); break; }
    catch (error) { if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  await withFixture(async f => {
    const stored = await f.store.get(p.proposal_id, { ownerId: owner, accountSubject: "account-one" });
    assert.equal(stored.status, "applied"); assert.equal(stored.receipt.verified, true);
    assert.equal((await f.confirm(p, await f.review(p))).body.replayed, true); assert.equal(f.intake.createAttempts(), 0);
  });
});
