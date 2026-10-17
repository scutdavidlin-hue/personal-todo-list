// SYNTHETIC CONTRACT LAB ONLY. No production imports this module. No server,
// persistent store, auth, human-origin verification, network or Task writer.
// recordUserReview() seeds fictional trusted-channel events; it is NOT an auth
// implementation and must never be exposed as a client-callable endpoint.
import { evaluateAutonomy } from "../../supabase/functions/_shared/autonomy-policy.js";

const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export async function syntheticDigest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const deny = code => ({ success: false, code, simulatedTaskWrites: 0 });
const fields = new Set(["proposal_id", "version", "scope_digest", "reply_event_id"]);

export function newTaskConfirmationLab({ now = 1792227600, beforeClaim, outcomeUnknown = false } = {}) {
  let clock = now;
  const proposals = new Map(), replies = new Map(), dispatches = [];

  async function seedProposal(scope, overrides = {}) {
    const row = { id: "synthetic-proposal", owner: "synthetic-owner-a", account: "synthetic-account-a",
      conversation: "synthetic-thread-a", preview: "synthetic-preview-a", version: 1,
      created: clock - 10, expires: clock + 600, status: "pending", revoked: false,
      scope: clone(scope), scopeDigest: await syntheticDigest(scope), ...clone(overrides) };
    proposals.set(row.id, row);
    return clone(row);
  }

  function recordUserReview(proposal, overrides = {}) {
    const event = { id: `synthetic-reply-${replies.size + 1}`, owner: proposal.owner, account: proposal.account,
      conversation: proposal.conversation, preview: proposal.preview, proposal: proposal.id,
      version: proposal.version, scopeDigest: proposal.scopeDigest, actor: "user", channel: "synthetic-reviewed-ui",
      decision: "approve_exact", occurred: clock, text: "是的是的，因为我在考虑怎么样封装这些虚构资料。",
      ...clone(overrides) };
    replies.set(event.id, event);
    return clone(event);
  }

  const sameIdentity = (row, identity) => row && identity && row.owner === identity.owner
    && row.account === identity.account && row.conversation === identity.conversation;
  const current = (row, body) => row && row.status === "pending" && !row.revoked
    && row.created <= clock && clock < row.expires && row.version === body.version && row.scopeDigest === body.scope_digest;

  async function confirm(body, identity) {
    // All client claims, including context/type/confirmed/raw_text, are rejected.
    if (!body || Object.keys(body).some(key => !fields.has(key)) || Object.keys(body).length !== fields.size) return deny("INVALID_CONFIRMATION_HANDLE");
    const row = proposals.get(body.proposal_id);
    if (!sameIdentity(row, identity)) return deny("PROPOSAL_UNAVAILABLE");
    if (row.revoked || row.status === "superseded") return deny("PROPOSAL_REVOKED");
    if (!(row.created <= clock && clock < row.expires)) return deny("PROPOSAL_EXPIRED");
    if (row.version !== body.version || row.scopeDigest !== body.scope_digest) return deny("NEW_PREVIEW_REQUIRED");
    const approvedScope = clone(row.scope);
    const approvedCanonical = JSON.stringify(canonical(approvedScope));
    if (await syntheticDigest(approvedScope) !== row.scopeDigest) return deny("IMMUTABLE_SCOPE_CHANGED");

    // Look up a fixture-owned event. Body text/role/booleans cannot manufacture
    // this event. Real user-origin and scope-consent verification remain absent.
    const reply = replies.get(body.reply_event_id);
    if (!sameIdentity(reply, identity) || reply.actor !== "user" || reply.channel !== "synthetic-reviewed-ui"
      || reply.proposal !== row.id || reply.preview !== row.preview || reply.version !== row.version
      || reply.occurred < row.created || reply.occurred > clock) return deny("USER_REPLY_UNVERIFIED");
    if (reply.decision === "change_scope" || reply.scopeDigest !== row.scopeDigest) {
      if (row.status !== "pending") return deny("PROPOSAL_IN_PROGRESS");
      row.status = "superseded";
      return { ...deny("NEW_PREVIEW_REQUIRED"), requires_preview: true };
    }
    if (reply.decision !== "approve_exact") return deny("USER_CONFIRMATION_REQUIRED");

    // Never use a confirmation to bypass the existing intent/risk policy.
    const policy = evaluateAutonomy(approvedScope, { baseDate: new Date(row.created * 1000) });
    if (policy.decision !== "execute" || policy.risk_level !== "L1" || policy.input?.type !== "task"
      || policy.input.existing_task_id || policy.input.update_patch) return deny("POLICY_REVIEW_REQUIRED");
    if (row.status === "applied") return { ...clone(row.receipt), replayed: true, simulatedTaskWrites: 0 };
    if (row.status === "unknown") return { ...deny("OUTCOME_UNKNOWN_NO_RETRY"), previousWriteStatus: "unknown" };
    if (row.status !== "pending") return deny("PROPOSAL_IN_PROGRESS");

    if (beforeClaim) await beforeClaim({ revoke: () => { row.revoked = true; }, expire: () => { clock = row.expires; },
      changeScope: () => { row.scope.notes = "synthetic concurrent content change"; } });
    // This synchronous Map CAS models the REQUIRED atomic production operation.
    // It is not durable, cross-process locking or a deployable database adapter.
    if (proposals.get(row.id) !== row || !current(row, body) || !sameIdentity(row, identity)
      || JSON.stringify(canonical(row.scope)) !== approvedCanonical) return deny("CLAIM_REJECTED");
    row.status = "claimed";
    const payload = approvedScope;
    dispatches.push({ payload, idempotencyKey: `synthetic-confirm:${row.id}:${row.version}`, replyEvent: reply.id });
    await Promise.resolve(); // exercise concurrent callers while claimed
    if (outcomeUnknown) {
      row.status = "unknown";
      return { ...deny("OUTCOME_UNKNOWN_NO_RETRY"), simulatedTaskWrites: null, writeStatus: "unknown" };
    }
    row.receipt = { success: true, code: "SIMULATED_APPLIED", id: `synthetic-task-${dispatches.length}`,
      proposal_id: row.id, simulatedTaskWrites: 1, replayed: false };
    row.status = "applied";
    return clone(row.receipt);
  }

  return { seedProposal, recordUserReview, confirm,
    dispatches: () => clone(dispatches),
    identity: () => ({ owner: "synthetic-owner-a", account: "synthetic-account-a", conversation: "synthetic-thread-a" }),
    handle: (row, reply) => ({ proposal_id: row.id, version: row.version, scope_digest: row.scopeDigest, reply_event_id: reply.id }),
    revoke: id => { proposals.get(id).revoked = true; },
    mutateScopeForTest: (id, scope) => { proposals.get(id).scope = clone(scope); },
    setClock: value => { clock = value; },
  };
}
