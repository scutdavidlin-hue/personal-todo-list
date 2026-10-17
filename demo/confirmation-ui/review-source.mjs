// SYNTHETIC OWNED UI SOURCE, not OpenAI attestation or real authentication.
// The verifier independently retrieves server-issued immutable events. There
// is no API that accepts a client-authored actor, proof, identity or digest.
import { ProposalError, scopeHash } from "../../supabase/functions/_shared/proposal-execution-scope.js";
export const SYNTHETIC_AUTHORITY = "synthetic-owned-review-ui-only";
export function syntheticReviewSource({ store, clock }) {
  const challenges = new Map(), events = new Map(); let sequence = 0;
  const checkRow = row => {
    if (!row || !["pending", "claimed"].includes(row.status)) throw new ProposalError("SOURCE_PREVIEW_CLOSED");
    if (new Date(row.expires_at) <= clock()) throw new ProposalError("PROPOSAL_EXPIRED");
  };
  return {
    challenge(row) {
      checkRow(row);
      const id = crypto.randomUUID();
      challenges.set(id, { proposal: structuredClone(row), eventId: null });
      return id;
    },
    async record(body, identity) {
      if (!body || Object.keys(body).sort().join(",") !== "challenge_id,decision" || !["approve_exact", "reject", "change_scope"].includes(body.decision)) throw new ProposalError("INVALID_REVIEW_REQUEST", 400);
      const challenge = challenges.get(body.challenge_id), row = challenge?.proposal;
      if (!row || row.owner_id !== identity.ownerId || row.account_subject !== identity.accountSubject) throw new ProposalError("REVIEW_CHALLENGE_UNAVAILABLE", 403);
      const current = await store.get(row.id, identity); checkRow(current);
      if (current.preview_id !== row.preview_id || current.scope_digest !== row.scope_digest || current.version !== row.version) throw new ProposalError("SOURCE_PREVIEW_STALE");
      if (challenge.eventId) {
        const old = events.get(challenge.eventId);
        if (old.disposition !== body.decision) throw new ProposalError("REVIEW_CHALLENGE_USED");
        return structuredClone(old);
      }
      const event = { authority: SYNTHETIC_AUTHORITY, eventId: crypto.randomUUID(), actor: "user",
        ownerId: row.owner_id, accountSubject: row.account_subject, conversationId: row.conversation_id,
        proposalId: row.id, previewId: row.preview_id, version: row.version, scopeDigest: row.scope_digest,
        disposition: body.decision, occurredAt: clock().toISOString(), sequence: ++sequence };
      const proofDigest = await scopeHash(event);
      // Recheck after the async digest: revision/termination may have won.
      const latest = await store.get(row.id, identity); checkRow(latest);
      if (latest.scope_digest !== row.scope_digest || latest.preview_id !== row.preview_id) throw new ProposalError("SOURCE_PREVIEW_STALE");
      // Concurrent identical clicks share the first immutable source event.
      if (challenge.eventId) {
        const old = events.get(challenge.eventId);
        if (old.disposition !== body.decision) throw new ProposalError("REVIEW_CHALLENGE_USED");
        return structuredClone(old);
      }
      const saved = Object.freeze({ ...event, proofDigest });
      events.set(saved.eventId, saved); challenge.eventId = saved.eventId;
      return structuredClone(saved);
    },
    async verifyReplySource({ principal, accountSubject, proposal, replyEventId }) {
      const saved = events.get(replyEventId);
      if (!saved || saved.ownerId !== principal.ownerId || saved.accountSubject !== accountSubject
        || saved.proposalId !== proposal.proposal_id || saved.previewId !== proposal.preview_id
        || saved.version !== proposal.version || saved.scopeDigest !== proposal.scope_digest) throw new ProposalError("USER_REPLY_UNVERIFIED");
      const { proofDigest, ...data } = saved;
      if (await scopeHash(data) !== proofDigest) throw new ProposalError("USER_REPLY_UNVERIFIED");
      if (saved.disposition === "approve_exact" && [...events.values()].some(event => event.proposalId === saved.proposalId
        && event.sequence > saved.sequence && ["reject", "change_scope"].includes(event.disposition))) throw new ProposalError("SOURCE_APPROVAL_SUPERSEDED");
      return structuredClone(saved);
    },
    summary: identity => [...events.values()].filter(x => x.ownerId === identity.ownerId).map(x => ({ event_id: x.eventId, proposal_id: x.proposalId, decision: x.disposition, sequence: x.sequence })),
  };
}
