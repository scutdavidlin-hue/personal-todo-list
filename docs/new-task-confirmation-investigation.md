# New-task confirmation: reproduced refusal and isolated contract draft

2026-10-17. Source snapshot: PR #8 head
`4f5cf010b881157fc9e15afe6222dede3f5f54b7` (verified from GitHub), independent
branch `investigate/task-confirmation-20261017`. The deployed bundle's identity
has **not** been verified. The reported response matches the source simulation;
that is not evidence that this exact commit is running in production.

**Result:** reproduce the information-only failure, preserve the production
zero-write guard, and supply executable synthetic confirmation-contract checks.
No production behavior is changed. The missing new-proposal persistence and
trusted-user-reply provenance require capabilities outside this task's scope;
their production integration stops at the design below.

## WHY / GOAL / acceptance

A user can explicitly ask for a future Task, then answer a creation question
with assent followed by discussion containing 怎么/怎么样. The assistant's
conversation preview must not be confused with a server-stored, authorized
new-task proposal. We need to distinguish a verified confirmation of an exact
preview from an information question without treating type, confirmed:true,
free context, an assistant message or a guessed task_id as authority.

Acceptance for this draft: demonstrate the two refused captures against actual
functions using mocks; keep pure questions at zero writes; keep an explicit
reminder command working; model exact owner/account/conversation/proposal/
preview/version/digest/expiry/revocation binding, re-preview for scope changes,
one concurrent claim, non-writing replay and no retry of unknown outcomes.
Physical/live creation and deployment are outside acceptance.

## Root cause and attribution

1. `personal-os-mcp/index.ts:captureItem` forwards raw_text/type/context to the
   intake handler. It does not turn prior chat dialogue into a new-task proposal.
2. `autonomy-policy.js:hasExplicitTaskIntent/isInformationQuestion` exempts an
   explicit persistence command, but a standalone affirmative explanation with
   怎么 is classified as information. `type:task` alone does not bypass that
   information guard. That protects legitimate information questions.
3. `autonomy-runtime.js:prepareAutonomousIntake` immediately returns information
   decisions before resolving context. Free client context cannot establish a
   pending creation or confirmation. Looking only at question words is inadequate
   for the full dialogue, but removing this guard is not a safe repair.
4. `personal-os-intake/index.ts` reserves a Task audit only for a preliminary
   executable Task. The information branch returns without that reservation:
   no request_id, no provider call. `normalizeIntakeReceipt` recognizes
   INFORMATION_ONLY as a refusal and adds retry_requires_user_intent=true.
   This is a known refusal, not evidence of a timeout or an uncertain Task write.
5. `task-conversation-runtime.js:runTaskConversation` requires task_id and then
   reads that existing Task. It handles task-bound proposals; it is not a
   standalone pending-new-task store. No existing task_id or pending record is
   fabricated here, and no previously refused request is replayed through it.

The original full capture JSON and production bundle were not inspected. We
cannot prove the exact production call shape or deployment cause. All wording
and Task fields in this patch are fictional paraphrases, not customer records.

## Executable evidence and patch scope

`node scripts/reproduce-confirmation-information.mjs` extracts the actual MCP
capture/receipt functions, strips TypeScript, and calls the actual intake handler
through the repository's existing synthetic adapters. Every fetch/environment
lookup is mocked; unexpected destinations throw. The full Hono/Zod gateway,
real Deno runtime, deployed authentication and provider services are not tested.

Both synthetic captures return INFORMATION_ONLY, outcome=rejected,
retry_requires_user_intent=true, no request_id and no audit. Total simulated Task
creates and context reads are zero. They are two explicit local calls; the gateway
does not automatically retry. A control with an explicit reminder directive plus
怎么样 follows the existing verified mock-create/readback route once.
Machine-readable capture: `docs/new-task-confirmation-reproduction.json`.

`scripts/test-support/new-task-confirmation-lab.mjs` is an **in-memory contract
lab only**, imported only by tests. It has no endpoint, credentials, persistent
adapter, network, real Task writer or production caller. Its fixture method
`recordUserReview` seeds a fictional trusted UI decision. It is NOT a real human
source verifier, authentication implementation, or natural-language scope
classifier. In particular, a passing explanation test assumes an independently
verified exact-preview approval event; it does not authorize the actual chat
reply or claim that the current capture route can recognize that reply safely.

The lab checks proposal and event bindings, immutable scope, versions, clocks,
revocation, actor/source mismatch, a final synthetic claim fence, concurrent
claims, replay, scope changes and unknown outcomes. It runs the existing L1/L3
intent policy over the original preview scope; it never replaces that scope with
confirmation text or appends the explanation to Task notes. A Map CAS is a model,
not multi-worker atomicity or crash-safe persistence. It cannot guarantee
exactly-once delivery or cancellation after a provider operation is in flight.

Production policy/runtime/MCP, auth, existing task-conversation, schema, grants
and provider paths are unchanged. PR #7 remains at
`afb3034e6117fd5d6014e3152712ace698c60bf7`, clean. This draft is stacked against
the PR #8 branch solely to review this seven-file delta; it does not update or
merge PR #8 and does not claim either PR is deployed.

## Production repair design — deliberately not wired

1. Before asking for creation confirmation, the server must persist an ephemeral
   proposal tied to a verified owner and current canonical account subject,
   conversation, preview event, immutable proposal ID/version, bounded expiry,
   revocation/status and digest of the **final normalized execution scope**.
   Include operation, title/notes, dates/timezone, reminder configuration,
   recurrence/relations and all other write-affecting fields. This is intent
   metadata, not a second Task source of truth. No schema/retention is approved
   or created by this draft.
2. Obtain a trustworthy actual-user confirmation event from an authorized user
   interaction/channel bound to that exact preview. Verify authentication,
   session/channel provenance, owner/account, actor, event uniqueness, timestamp,
   preview/proposal ID, version and approved digest server-side. A service bearer
   token or source="chatgpt" only authenticates a caller, not the truth of its
   claimed user wording. A role label, confirmed:true, arbitrary context or a
   client-generated event ID supplies no such proof. Do not expose the lab's
   seeding method as an API.
3. Resolve changes before committing. Scope additions, date changes, contradictory
   language or uncertain intent require a new preview/version, invalidating the
   old one; the original proposed task must not be silently changed. Explanation
   text may remain separate from the approved content. The fixture's explicit
   scope decision is simulated: safe real chat-source and semantic resolution
   are missing, and cannot be replaced by a larger yes/怎么 regex.
4. Use an approved owner-bound atomic store operation to compare all bindings,
   status, expiry and revocation, consume/claim the exact event/proposal, and
   record a stable execution idempotency key. Recheck account, normalized scope
   and policy immediately before using the existing intake/audit/verification
   path. Account or scope changes require re-preview. Do not grant an internal
   `confirmed` flag the ability to suppress INFORMATION_ONLY or L3 decisions.
5. Persist known result/replay state. A consumed/applied proposal returns its
   prior receipt without a provider call. Claimed/unknown outcomes stay fenced;
   use the existing readback/reconciliation path, not a new key or blind retry.
   Revocation wins before dispatch; after dispatch begins, report the race and
   do not claim a withdrawn remote operation has been undone.

These require new-task proposal persistence/atomic claims and a verified user
interaction source that the current capture path does not have. No new table,
RLS/grant, credential, role/scope, subscription, endpoint or durable access is
configured. Authorizing such capabilities is a separate concrete integration
decision; this task stops at a reviewable design and synthetic tests.

## Tests / result

Baseline at 4f5cf01: `npm run verify` **682 tests, 680 passed, two existing browser
skips, zero failures**. Final: **715 tests, 713 passed, the same two skips, zero
failures**; 33 new tests pass (five actual-function mock regressions, 28 contract
lab cases). The lab includes a 12-caller concurrent claim, applied replay,
unknown-no-retry, wrong owner/account/thread, expired/revoked records, old version,
changed scope/digest, forged event/actor/source, scope changes requiring preview,
pure questions, extra client confirmation fields and the existing high-risk gate.

No original Task is created, edited or retried. No production endpoint, restricted
access path or deployment is invoked. Simulation does not establish durable
atomicity, authentic human provenance, real NLP scope resolution, production
bundle identity, actual provider delivery or an end-to-end fix of the incident.
