import { ProposalError, proposalUUID, proposalDigest, scopeHash, prepareNewTaskProposal } from "./proposal-execution-scope.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const only = (body, fields) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400);
};
async function boundedJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400);
  const decoder = new TextDecoder(); let bytes = 0, text = "";
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 65536) { await reader.cancel(); throw new ProposalError("REQUEST_TOO_LARGE", 413); }
    text += decoder.decode(chunk.value, { stream: true });
  }
  try { return JSON.parse(text + decoder.decode()); } catch { throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400); }
}
const preview = row => ({ proposal_id: row.id, version: row.version, preview_id: row.preview_id, scope_digest: row.scope_digest,
  scope: JSON.parse(row.execution_json), expires_at: row.expires_at, status: row.status, receipt: row.receipt || null });
const sanitize = result => {
  const safe = Object.fromEntries(["success", "write_success", "verified", "partial", "id", "request_id", "outcome", "code", "message"]
    .filter(key => result?.[key] !== undefined).map(key => [key, result[key]]));
  if (result?.receipt && typeof result.receipt === "object") safe.receipt = Object.fromEntries(
    ["task_save_status", "reminder_projection_status", "request_id", "task_id", "calendar_event_id"]
      .filter(key => result.receipt[key] !== undefined).map(key => [key, result.receipt[key]]));
  return safe;
};
const saved = result => result?.write_success === true && result.verified === true && Boolean(result.id && result.request_id)
  && result.receipt?.task_save_status === "verified";

// Same identity verification used by existing task-conversation: Auth server
// validates the bearer token. No user_metadata/body ID is accepted as identity.
export function createExistingSessionAuthenticator({ supabaseURL, publishableKey, ownerId, fetcher = fetch } = {}) {
  return async request => {
    if (!supabaseURL || !publishableKey || !proposalUUID(ownerId)) throw new ProposalError("AUTH_BINDING_UNAVAILABLE", 503);
    const authorization = request.headers.get("authorization") || "";
    if (!/^Bearer \S+$/i.test(authorization)) throw new ProposalError("AUTH_REQUIRED", 401);
    const response = await fetcher(`${supabaseURL}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: authorization }, signal: AbortSignal.timeout(10000) });
    const user = await response.json();
    if (!response.ok || user?.id !== ownerId) throw new ProposalError("AUTH_REQUIRED", 401);
    return { ownerId: user.id };
  };
}
export function createExistingAccountResolver(taskService, ownerId) {
  return async principal => {
    if (principal.ownerId !== ownerId || typeof taskService !== "function") throw new ProposalError("ACCOUNT_BINDING_UNAVAILABLE", 503);
    const account = await taskService({ action: "account_context" });
    if (typeof account?.account_subject !== "string" || !account.account_subject) throw new ProposalError("ACCOUNT_UNVERIFIED", 409);
    return account.account_subject;
  };
}

// No default server, pool, source authority, credential or live transport.
// The existing session proves identity, NOT the origin/meaning of a chat reply.
export function createTaskProposalHandler({ store, authenticateUser, resolveAccount, verifyReplySource,
  trustedAuthorities = [], prepare = prepareNewTaskProposal, resolveContext, sendIntake,
  clock = () => new Date(), ttlSeconds = 600 } = {}) {
  async function rowFor(id, identity) {
    const row = await store.get(id, identity);
    if (!row) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
    return row;
  }
  async function newRow(input, identity, conversationId) {
    const stamp = clock();
    const prepared = await prepare(input, { resolveContext, receivedAt: stamp.toISOString() });
    const id = crypto.randomUUID();
    return { id, group_id: id, version: 1, preview_id: crypto.randomUUID(), owner_id: identity.ownerId,
      account_subject: identity.accountSubject, conversation_id: conversationId, execution_json: prepared.executionJSON,
      scope_digest: prepared.digest, intake_input: prepared.intakeInput, received_at: prepared.receivedAt,
      created_at: stamp.toISOString(), expires_at: new Date(+stamp + ttlSeconds * 1000).toISOString() };
  }
  return async request => {
    try {
      if (!store || typeof authenticateUser !== "function" || typeof resolveAccount !== "function") throw new ProposalError("PROPOSAL_BINDING_UNAVAILABLE", 503);
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 1800) throw new ProposalError("PROPOSAL_TTL_INVALID", 503);
      const principal = await authenticateUser(request);
      if (!proposalUUID(principal?.ownerId)) throw new ProposalError("AUTH_REQUIRED", 401);
      const identity = { ownerId: principal.ownerId, accountSubject: await resolveAccount(principal) };
      const path = new URL(request.url).pathname.match(/\/proposals(?:\/([^/]+)(?:\/(confirm|revoke|revise))?)?\/?$/);
      if (!path) return json({ success: false, code: "NOT_FOUND" }, 404);
      const [,id,operation] = path;
      if (id && !proposalUUID(id)) throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400);
      if (request.method === "GET" && id && !operation) return json(preview(await rowFor(id, identity)));
      if (request.method !== "POST") return json({ success: false, code: "METHOD_NOT_ALLOWED" }, 405);
      const body = await boundedJSON(request);
      if (!id) {
        only(body, ["input", "conversation_id"]);
        if (typeof body.conversation_id !== "string" || !body.conversation_id || body.conversation_id.length > 300) throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400);
        return json(preview(await store.create(await newRow(body.input, identity, body.conversation_id))), 201);
      }
      if (operation === "revoke") {
        only(body, ["version"]);
        return json(preview(await store.revoke(id, identity, body.version)));
      }
      if (operation === "revise") {
        only(body, ["version", "input"]);
        const old = await rowFor(id, identity);
        return json(preview(await store.revise(id, identity, body.version, await newRow(body.input, identity, old.conversation_id))), 201);
      }
      if (operation !== "confirm") return json({ success: false, code: "NOT_FOUND" }, 404);
      only(body, ["version", "scope_digest", "reply_event_id"]);
      if (!Number.isSafeInteger(body.version) || !proposalDigest(body.scope_digest) || typeof body.reply_event_id !== "string" || !body.reply_event_id || body.reply_event_id.length > 300) throw new ProposalError("INVALID_PROPOSAL_REQUEST", 400);
      if (typeof verifyReplySource !== "function" || !trustedAuthorities.length) throw new ProposalError("TRUSTED_REPLY_SOURCE_UNAVAILABLE", 503);
      if (typeof sendIntake !== "function") throw new ProposalError("INTAKE_BINDING_UNAVAILABLE", 503);
      const row = await rowFor(id, identity);
      if (row.version !== body.version || row.scope_digest !== body.scope_digest) throw new ProposalError("NEW_PREVIEW_REQUIRED");
      const reply = await verifyReplySource({ request, principal, accountSubject: identity.accountSubject, proposal: preview(row), replyEventId: body.reply_event_id });
      if (!reply || !trustedAuthorities.includes(reply.authority) || reply.eventId !== body.reply_event_id || reply.actor !== "user"
        || reply.ownerId !== identity.ownerId || reply.accountSubject !== identity.accountSubject || reply.conversationId !== row.conversation_id
        || reply.proposalId !== id || reply.previewId !== row.preview_id || reply.version !== row.version
        || !proposalDigest(reply.proofDigest) || !proposalDigest(reply.scopeDigest)
        || !["approve_exact", "change_scope", "question", "reject"].includes(reply.disposition)
        || !reply.occurredAt || !Number.isFinite(Date.parse(reply.occurredAt))
        || new Date(reply.occurredAt) < new Date(row.created_at) || new Date(reply.occurredAt) > clock()) throw new ProposalError("USER_REPLY_UNVERIFIED");
      if (reply.disposition === "reject" || reply.disposition === "change_scope" || reply.scopeDigest !== row.scope_digest) {
        const closed = await store.terminateByReply(id, identity, body.version, reply);
        throw new ProposalError(closed.status === "revoked" ? "PROPOSAL_REVOKED" : "NEW_PREVIEW_REQUIRED");
      }
      if (reply.disposition !== "approve_exact") throw new ProposalError("USER_CONFIRMATION_REQUIRED");
      const fresh = await prepare(row.intake_input, { resolveContext, receivedAt: new Date(row.received_at).toISOString() });
      if (fresh.digest !== row.scope_digest || await scopeHash(row.execution_json) !== row.scope_digest) {
        await store.revoke(id, identity, body.version, true); throw new ProposalError("NEW_PREVIEW_REQUIRED");
      }
      if (await resolveAccount(principal) !== identity.accountSubject) throw new ProposalError("PROPOSAL_ACCOUNT_CHANGED");
      const claim = await store.claim(id, identity, body.version, body.scope_digest, reply);
      if (claim.state === "replay") return json({ ...claim.row.receipt, replayed: true });
      if (await resolveAccount(principal) !== identity.accountSubject) { await store.revoke(id, identity, body.version); throw new ProposalError("PROPOSAL_ACCOUNT_CHANGED"); }
      await store.beginDispatch(claim.row, claim.token, identity);
      let receipt;
      try {
        receipt = sanitize(await sendIntake({ ...claim.row.intake_input, source: "chatgpt",
          proposal_guard: { proposal_id: id, version: body.version, scope_digest: body.scope_digest, owner_id: identity.ownerId, account_subject: identity.accountSubject } },
        `proposal:${id}:${body.version}`));
      } catch { receipt = { success: false, write_success: false, verified: false, outcome: "unknown", code: "INTAKE_OUTCOME_UNKNOWN" }; }
      const state = saved(receipt) ? "applied" : ["PROPOSAL_ACCOUNT_CHANGED", "PROPOSAL_SCOPE_CHANGED", "PROPOSAL_GUARD_INVALID", "INFORMATION_ONLY", "CLARIFICATION_REQUIRED"].includes(receipt.code) ? "rejected" : "unknown";
      try { await store.finish(claim.row, claim.token, state, receipt); }
      catch { return json({ ...receipt, proposal_checkpoint: "unverified", automatic_retry_allowed: false }, 202); }
      return json({ ...receipt, proposal_id: id, automatic_retry_allowed: false }, state === "unknown" ? 202 : 200);
    } catch (error) { return json({ success: false, write_success: false, verified: false, code: error instanceof ProposalError ? error.code : "PROPOSAL_OPERATION_UNVERIFIED", automatic_retry_allowed: false }, error instanceof ProposalError ? error.status : 503); }
  };
}
