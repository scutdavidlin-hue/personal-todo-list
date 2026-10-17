# Durable new-task confirmation — implementation, not deployment

2026-10-17. Continuation of Draft PR #12 from `d1c5691a84b1c2986e4c405a1b40f820bd9c345d`.
The earlier report/model remains historical. This change adds real PostgreSQL
state, a Request/Response runtime, existing identity/account adapters and a
restrictive check inside the actual intake handler. It does not enable a live
confirmation route or create/retry the original customer Task.

## Deployed version evidence

The existing authorized Supabase connector's metadata read reports:

| Function | Active deployment | Bundle SHA-256 |
| --- | --- | --- |
| personal-os-intake | v19 | de4090d0333e35fdae81633fb3a418a7d3cd4965423b2bc3c9e0f7893214efba |
| personal-os-mcp | v18 | c3680ac90a8d6e6178ea4630b98dcae576eb0a4c316c788bc69fc09cfd7e167e |
| task-conversation | v2 | 7d5b8656408565647a3670c8eb4e6dfae9bcf538c7ca801eb96bc944399ecb25 |

Only nonsecret metadata was retrieved; no bundle contents or credentials were
read. These are deployment versions/opaque package hashes, **not Git SHAs**.
No source-commit mapping is published by this evidence, so neither 4f5cf01 nor
the PR head is declared the deployed source. Public HTTP probes were blocked by
this environment's proxy (403), not observed application responses. The latest
observed successful public Pages run is 36950500165, from October 2 at 49e020b;
that historical frontend deployment cannot identify today's backend bundle.
Exact records: `docs/proposal-deployed-version-evidence.json`.

## Actual implementation

- `supabase/sql/task-create-proposals.sql`: private proposal and consumed-source
  tables, FK to existing Auth users, immutable scope/input/identity/version,
  SQL SHA-256 check, terminal transition/claim/receipt fences, expiry, indexes,
  RLS and client revokes. No role receives a grant, no SECURITY DEFINER is used,
  and the schema is not exposed to PostgREST. This is executable draft DDL, not
  an applied migration. CLI scaffolding did not succeed: 2.121 attempted its
  unwritable home configuration path and the pinned fallback returned no usable
  help/scaffold. No timestamped migration was invented. A release owner must use
  a working authorized CLI to package it as a migration before any rollout.
- `task-proposal-postgres.js`: parameterized real SQL with short row-locking
  transactions. Binding checks and unique source-event consumption share the
  claim transaction. Database time governs expiry. A separate atomic dispatch
  gate lets revocation win before sending; once dispatch begins, cancellation
  reports DISPATCH_ALREADY_STARTED instead of pretending an in-flight operation
  was undone. Applied/rejected receipts replay without execution; claimed,
  dispatching and unknown states do not automatically become retryable.
- `task-proposal-runtime.js`: authenticated create/get/confirm/revoke/revise HTTP
  flows, bounded input, server-generated preview IDs/versions, immutable hashes,
  fresh policy/scope/account checks, and opaque verified-event references.
  Revision creates a new immutable version and invalidates the old preview.
  It has no default pool, server, trusted source, transport, secret or deployment.
- Existing identity wiring uses Auth `/auth/v1/user`, as task-conversation does;
  only the verified returned user ID may match the configured existing owner.
  user_metadata, request body IDs and source strings cannot authenticate a user.
  Existing account wiring calls `task-status account_context`; no client account
  field supplies the canonical account subject. No new account, scope or key is
  created. These adapters are implemented but are not configured with real
  sessions/credentials in this task.
- `proposal-execution-scope.js` uses the actual intent/risk/normalization path to
  produce the full dispatch scope, freezes the resolved date before preview, and
  keeps confirmation explanations separate from Task content. Mixed/non-task,
  existing-task updates, pure questions and high-risk requests do not qualify.
- The actual `personal-os-intake/index.ts` checks `proposal_guard` **after** its
  ordinary policy and canonical account checks and **before** provider dispatch.
  This field only adds restrictions: final owner/account/scope mismatch becomes
  needs_input, without a provider call or scheduled retry. It never authorizes
  a write, suppresses INFORMATION_ONLY/L3, or accepts confirmed:true. The executor
  retains the existing intake/audit/write/readback path with a stable
  `proposal:<id>:<version>` idempotency key; it does not use another writer.
  Guard constraints remain in the audit payload (including prewrite Auth
  interruptions). Legacy recover/recover_due returns
  PROPOSAL_RECONCILIATION_REQUIRED with the prior receipt preserved and no
  provider retry, so it cannot become an alternate confirmation path.
  Legacy amend_request also refuses guarded requests with
  PROPOSAL_REPREVIEW_REQUIRED; it cannot strip the guard or change the approved
  date/scope. Changes must use a fresh bound proposal preview.

## Real isolation evidence

`npm run verify:proposal-db` uses a labeled disposable PostgreSQL 17.6 container,
actual SQL transactions, multiple connections, loopback HTTP, the implemented
session/account adapters and the actual intake function. Auth responses, reply
source events, canonical-provider reads and Task writes are explicitly synthetic.
The test URL is restricted to loopback `/proposal_fixture`; restarting is allowed
only for the labeled fixture container. No production connection is made.

The database-chain cases include valid bound approval plus
explanation, missing source, wrong identities/bindings, expired/revoked/changed
proposals, new previews, 12 concurrent confirmations dispatching once, source-event
replay across proposals, unknown-no-retry, SQL permissions/immutability, final
actual-intake account/content mismatch, legacy-recovery fencing, and cancellation on either side of the
dispatch gate. A real database container restart retains the applied receipt;
a fresh HTTP/intake instance replays it with zero new provider attempts. This is
durability evidence beyond the original Map model, not real human or Google
delivery evidence. Full regression and CI outcomes are recorded separately after
their actual completion.

### Completed CI and local results

Tested code: `8fd82b2a1acc44e829138b1f41e94383ae36be6c`.
[Actual CI run 39047898154](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/39047898154),
job 117440225021, completed at 2026-10-17 16:06:00 UTC on standard
`ubuntu-24.04`. Raw job logs confirm **725 regression tests: 723 passed, two
existing browser skips, zero failures**, and **24 PostgreSQL/HTTP cases: all
passed, zero skipped**. Local results match. Named execution evidence includes
the 12-way concurrent claim, actual intake constraints, prewrite Auth failure
followed by refused legacy recovery/amendment, receipt-preserving background
recovery refusal, and an actual PostgreSQL container restart followed by replay
without a new provider attempt. The earlier edca689 CI passed 22 database cases;
it is not used as validation of the later recovery changes.

The final handoff/evidence commit changes docs only. The workflow is isolated to
this review branch, public-repository guarded, standard-runner capped, and uses
a pinned disposable PostgreSQL image and pinned pg dependency. No artifact or
cache upload occurs; artifact readback is empty. The final 121,478-character log
was inspected for private-key blocks, JWT/GitHub-token values and production
Tasks/Auth URLs; none matched those probes. The clearly labeled synthetic DB
password, fake identities, public handles and runner metadata remain visible.
This is an inspection of this run, not a claim about all repository history.
Structured evidence: `docs/proposal-persistence-ci-evidence.json`.

## Trusted reply source: exact remaining platform boundary

Existing user/session authentication establishes identity, not the origin or
meaning of a chat sentence. The current MCP capture supplies free tool arguments;
it does not expose a server-verifiable human-turn/preview approval attestation.
This task therefore cannot wire the actual "yes, because ... how ..." message as
an authoritative event. The default confirmation handler returns
TRUSTED_REPLY_SOURCE_UNAVAILABLE before claiming or dispatching.

The host must supply `verifyReplySource({request, principal, accountSubject,
proposal, replyEventId})` backed by an approved existing trusted channel. It must
independently retrieve/verify actual-user provenance, signature/authenticated
channel and exact preview consent, then return:

`authority, eventId, actor, ownerId, accountSubject, conversationId, proposalId,
previewId, version, scopeDigest, disposition, occurredAt, proofDigest`.

`actor` must be user; the runtime checks every binding against server state and
only accepts a configured authority. `proofDigest` fingerprints already verified
evidence; a hash is **not** signature verification. Client role/identity, a bearer
token alone, an arbitrary event ID/context, confirmed:true or a yes-regex cannot
produce this evidence. The source must resolve scope changes as change_scope;
uncertain or question-only replies cannot become approve_exact. In tests a
fixture-owned event provider supplies these records. It is labeled synthetic,
is not registered as a real authority, and proves no real chat provenance/NLP.

Still required from the platform/release owner:

1. An existing approved private database owner/query binding for the store.
   Current REST credentials do not automatically expose this new private schema;
   no grant, password or persistent access is added to make it reachable.
2. A trusted UI-review or platform-signed actual-user-turn source bound to the
   exact server preview. No such connection/attestation is available here. Any
   new channel, key, permission or access must be separately approved; no flag
   may replace verification.
3. Approved migration packaging, retention/cleanup and route registration,
   followed by isolated acceptance of the real source and account bindings.
   Unknown attempts require read-only reconciliation via the stable intake key;
   no autonomous retry or reconciliation write endpoint is added here.

No production migration, grants, deployment, real Task retry, credential read or
new persistent permission occurred. PR #7's native work is not changed. The
original customer Task remains uncreated and must not be called complete.
