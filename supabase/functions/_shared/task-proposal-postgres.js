// Real PostgreSQL adapter. The host supplies an approved owner pool; no env,
// credentials, network defaults, schema installation or role grants occur here.
import { ProposalError } from "./proposal-execution-scope.js";

const select = "select *, clock_timestamp() as database_now from task_create_private.proposals where id=$1 and owner_id=$2 and account_subject=$3";
const identityArgs = (id, identity) => [id, identity.ownerId, identity.accountSubject];
const ready = (row, version, digest) => {
  if (!row) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
  if (row.version !== version || row.scope_digest !== digest) throw new ProposalError("NEW_PREVIEW_REQUIRED");
  if (["revoked", "superseded"].includes(row.status)) throw new ProposalError("PROPOSAL_REVOKED");
  if (new Date(row.expires_at) <= new Date(row.database_now)) throw new ProposalError("PROPOSAL_EXPIRED");
};
const bindingMatches = (row, reply) => row.owner_id === reply.ownerId && row.account_subject === reply.accountSubject
  && row.conversation_id === reply.conversationId && row.id === reply.proposalId && row.preview_id === reply.previewId
  && row.version === reply.version && row.scope_digest === reply.scopeDigest;

export function createPostgresProposalStore(pool) {
  if (!pool?.query || !pool?.connect) throw new ProposalError("PROPOSAL_STORE_UNAVAILABLE", 503);
  async function transaction(work) {
    const client = await pool.connect();
    try { await client.query("begin"); const value = await work(client); await client.query("commit"); return value; }
    catch (error) { await client.query("rollback"); throw error; }
    finally { client.release(); }
  }
  async function insert(client, row) {
    const result = await client.query(`insert into task_create_private.proposals
      (id,group_id,version,preview_id,owner_id,account_subject,conversation_id,execution_json,scope_digest,intake_input,received_at,created_at,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *, clock_timestamp() as database_now`,
    [row.id,row.group_id,row.version,row.preview_id,row.owner_id,row.account_subject,row.conversation_id,
      row.execution_json,row.scope_digest,row.intake_input,row.received_at,row.created_at,row.expires_at]);
    return result.rows[0];
  }
  return {
    create: row => insert(pool, row),
    async get(id, identity) { return (await pool.query(select, identityArgs(id, identity))).rows[0] || null; },
    async claim(id, identity, version, digest, reply) {
      return transaction(async client => {
        const row = (await client.query(select + " for update", identityArgs(id, identity))).rows[0];
        ready(row, version, digest);
        if (!bindingMatches(row, reply) || reply.actor !== "user" || reply.disposition !== "approve_exact"
          || new Date(reply.occurredAt) < new Date(row.created_at) || new Date(reply.occurredAt) > new Date(row.database_now)) throw new ProposalError("USER_REPLY_UNVERIFIED");
        if (row.status === "applied" || row.status === "rejected") return { state: "replay", row };
        if (row.status === "unknown") throw new ProposalError("OUTCOME_UNKNOWN_NO_RETRY");
        if (row.status !== "pending") throw new ProposalError("PROPOSAL_IN_PROGRESS");
        await client.query(`insert into task_create_private.reply_events
          (authority,event_id,proposal_id,owner_id,account_subject,conversation_id,preview_id,proposal_version,approved_digest,proof_digest,occurred_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
        [reply.authority,reply.eventId,row.id,row.owner_id,row.account_subject,row.conversation_id,row.preview_id,row.version,row.scope_digest,reply.proofDigest,reply.occurredAt]);
        const event = (await client.query("select * from task_create_private.reply_events where authority=$1 and event_id=$2", [reply.authority,reply.eventId])).rows[0];
        if (event?.proposal_id !== row.id || event.proof_digest !== reply.proofDigest || event.proposal_version !== row.version) throw new ProposalError("SOURCE_EVENT_REPLAYED");
        const token = crypto.randomUUID();
        const claimed = (await client.query("update task_create_private.proposals set status='claimed', claim_token=$2 where id=$1 returning *", [row.id,token])).rows[0];
        return { state: "claimed", row: claimed, token };
      });
    },
    async beginDispatch(row, token, identity) {
      const result = await pool.query(`update task_create_private.proposals set status='dispatching'
        where id=$1 and owner_id=$2 and account_subject=$3 and version=$4 and scope_digest=$5
        and status='claimed' and claim_token=$6 and expires_at>clock_timestamp() returning id`,
      [row.id,identity.ownerId,identity.accountSubject,row.version,row.scope_digest,token]);
      if (result.rowCount !== 1) throw new ProposalError("CLAIM_CLOSED");
    },
    async finish(row, token, state, receipt) {
      if (!["applied", "rejected", "unknown"].includes(state)) throw new ProposalError("INVALID_OUTCOME");
      const result = await pool.query(`update task_create_private.proposals set status=$3, receipt=$4
        where id=$1 and claim_token=$2 and status='dispatching' returning id`, [row.id,token,state,receipt]);
      if (result.rowCount !== 1) throw new ProposalError("PROPOSAL_CHECKPOINT_UNVERIFIED", 503);
    },
    async revoke(id, identity, version, supersede = false) {
      return transaction(async client => {
        const row = (await client.query(select + " for update", identityArgs(id, identity))).rows[0];
        if (!row) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
        if (row.version !== version) throw new ProposalError("NEW_PREVIEW_REQUIRED");
        if (["revoked", "superseded"].includes(row.status)) return row;
        if (!["pending", "claimed"].includes(row.status) || (supersede && row.status !== "pending")) throw new ProposalError("DISPATCH_ALREADY_STARTED");
        return (await client.query("update task_create_private.proposals set status=$2 where id=$1 returning *", [id,supersede ? "superseded" : "revoked"])).rows[0];
      });
    },
    async revise(id, identity, version, replacement) {
      return transaction(async client => {
        const row = (await client.query(select + " for update", identityArgs(id, identity))).rows[0];
        if (!row) throw new ProposalError("PROPOSAL_UNAVAILABLE", 404);
        if (row.version !== version || !["pending", "superseded"].includes(row.status)) throw new ProposalError("NEW_PREVIEW_REQUIRED");
        if ((await client.query("select id from task_create_private.proposals where group_id=$1 and version>$2 limit 1", [row.group_id,row.version])).rowCount) throw new ProposalError("NEW_PREVIEW_REQUIRED");
        if (row.status === "pending") await client.query("update task_create_private.proposals set status='superseded' where id=$1", [id]);
        return insert(client, { ...replacement, group_id: row.group_id, version: row.version + 1, conversation_id: row.conversation_id });
      });
    },
  };
}
