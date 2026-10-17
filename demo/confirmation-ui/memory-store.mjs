// SYNTHETIC DEMO ONLY: process-local Map, not durable or cross-process locking.
// Implements the existing proposal runtime's store contract without any DB.
import { ProposalError } from "../../supabase/functions/_shared/proposal-execution-scope.js";
const copy = value => structuredClone(value);
export function syntheticMemoryStore(clock) {
  const rows = new Map(), consumed = new Map();
  const find = (id, identity) => {
    const row = rows.get(id);
    if (!row || row.owner_id !== identity.ownerId || row.account_subject !== identity.accountSubject) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
    return row;
  };
  const version = (row, expected) => { if (row.version !== expected) throw new ProposalError("NEW_PREVIEW_REQUIRED"); };
  const consume = (row, reply) => {
    const key = `${reply.authority}:${reply.eventId}`, previous = consumed.get(key);
    if (previous && (previous.id !== row.id || previous.proof !== reply.proofDigest)) throw new ProposalError("SOURCE_EVENT_REPLAYED");
    consumed.set(key, { id: row.id, proof: reply.proofDigest });
  };
  const insert = input => { const row = { ...copy(input), status: "pending", receipt: null }; rows.set(row.id, row); return copy(row); };
  return {
    create: insert,
    get: (id, identity) => { try { return copy(find(id, identity)); } catch { return null; } },
    claim(id, identity, expected, digest, reply) {
      const row = find(id, identity); version(row, expected);
      if (row.scope_digest !== digest) throw new ProposalError("NEW_PREVIEW_REQUIRED");
      if (["revoked", "superseded"].includes(row.status)) throw new ProposalError("PROPOSAL_REVOKED");
      if (new Date(row.expires_at) <= clock()) throw new ProposalError("PROPOSAL_EXPIRED");
      if (["applied", "rejected"].includes(row.status)) return { state: "replay", row: copy(row) };
      if (row.status === "unknown") throw new ProposalError("OUTCOME_UNKNOWN_NO_RETRY");
      if (row.status !== "pending") throw new ProposalError("PROPOSAL_IN_PROGRESS");
      consume(row, reply); row.claim_token = crypto.randomUUID(); row.status = "claimed";
      return { state: "claimed", row: copy(row), token: row.claim_token };
    },
    beginDispatch(input, token, identity) {
      const row = find(input.id, identity);
      if (row.status !== "claimed" || row.claim_token !== token || new Date(row.expires_at) <= clock()) throw new ProposalError("CLAIM_CLOSED");
      row.status = "dispatching";
    },
    finish(input, token, status, receipt) {
      const row = rows.get(input.id);
      if (row?.status !== "dispatching" || row.claim_token !== token || !["applied", "rejected", "unknown"].includes(status)) throw new ProposalError("PROPOSAL_CHECKPOINT_UNVERIFIED", 503);
      row.status = status; row.receipt = copy(receipt);
    },
    revoke(id, identity, expected, supersede = false) {
      const row = find(id, identity); version(row, expected);
      if (["revoked", "superseded"].includes(row.status)) return copy(row);
      if (!["pending", "claimed"].includes(row.status)) throw new ProposalError("DISPATCH_ALREADY_STARTED");
      row.status = supersede ? "superseded" : "revoked"; return copy(row);
    },
    terminateByReply(id, identity, expected, reply) {
      const row = find(id, identity); version(row, expected);
      if (!["pending", "claimed", "revoked", "superseded"].includes(row.status)) throw new ProposalError("DISPATCH_ALREADY_STARTED");
      consume(row, reply);
      if (!["revoked", "superseded"].includes(row.status)) row.status = reply.disposition === "reject" ? "revoked" : "superseded";
      return copy(row);
    },
    revise(id, identity, expected, replacement) {
      const row = find(id, identity); version(row, expected);
      if (!["pending", "superseded"].includes(row.status) || [...rows.values()].some(x => x.group_id === row.group_id && x.version > row.version)) throw new ProposalError("NEW_PREVIEW_REQUIRED");
      row.status = "superseded";
      return insert({ ...replacement, group_id: row.group_id, version: row.version + 1, conversation_id: row.conversation_id });
    },
  };
}
