# Traceable intake receipts

## Problem and scope

An interrupted MCP call is not evidence that a task was never saved or that the user cancelled the intent. The previous gateway reported `任务未写入` on transport errors, and intake errors could omit an already allocated request ID.

This draft changes the existing gateway and intake only. It adds no permissions, credentials, schema, Cron, deployment, or task writes. The PR is based on `fix/minimal-reminder-without-auto-recovery-20261006` at `17bc935`; it carries forward the already deployed v17 intake explicit-recovery fence so that an older repository branch cannot remove it. Unrelated production engines are not replaced by this draft.

Readonly production source inspection on 2026-10-12 found:

| Function | Version | Bundle SHA256 |
| --- | --- | --- |
| personal-os-mcp | 17 | 984c8f62e5f3804d78eb24712095449d18ee8b68df7a47d3db8f6ffd1eed256d |
| personal-os-intake | 17 | 64248ed5ec7cea4d86c0c95bb6e6764af70b81043d00b0c74aaa6f4139a7b11b |
| task-status | 18 | 7372517d1bd7a2b15f21edd5522c5bfb586e35475412ba4df3dc14e6a1b5bff1 |
| google-tasks | 18 | a74312976d92dc41d9f7f858ed67d616c4ca64c801126d24fbf7529328934273 |

## Behavior and acceptance

- Task reservation occurs before remote context reads. Original wording, received clock, hash, and key are persisted with `context_pending`; the existing lease and uniqueness fence remain.
- Gateway timeout, abort, invalid JSON and interrupted response body return `INTAKE_OUTCOME_UNKNOWN`, the original key, and `retry_requires_user_intent=true`. The gateway never automatically repeats the write. Valid rejection/cancellation responses retain their code and request identity.
- Intake failure returns any allocated `request_id` and original key. Losing the reservation response may leave only the key; that is not proof that registration failed.
- `list_reminder_requests(idempotency_key=...)` performs an owner-bound exact match, ignoring pagination offset and stage filters. It performs only canonical read/reconciliation and reports `task_check`, separate from reminder delivery. It neither changes ledger state nor retries task/calendar writes.
- An empty exact lookup means `not_registered_at_check`; requests can still arrive later. Cancelled, superseded and clarification-blocked requests are not resumed by lookup.
- A saved Google Task is distinct from a configured reminder and phone delivery. A verified task check does not assert notification delivery.

## Isolated validation

`npm run verify`: 468 tests, 466 passed, 2 skipped, 0 failed. Tests use simulated records and fetch responses only.

Actual intake handlers cover reservation-response loss, original request ID retention after provider-write interruption, read-only exact lookup and wrong keys, pending same-key concurrent requests creating once, malformed input and cancelled ledger lookup. Actual gateway functions are type-stripped and executed against isolated fetch responses for timeout, AbortError, malformed/empty/interrupted bodies, verified receipts and explicit cancellation/denial. Existing recovery tests retain account, lease and uncertain-write guards.

## Remaining platform boundary

An opaque `user cancelled MCP tool call` returned by the platform before a gateway response exposes neither a business request ID nor proof that the service received it. The service cannot retroactively determine whether that cancellation was human intent, approval interruption, connection loss, or platform execution cancellation. A final ledger row with `replayed=false` and `retry_count=0` describes the final registered request only. It does not establish what happened to a prior opaque call.

This draft provides traceable receipts when service code executes and exact-key verification afterward. It cannot promise that the platform will never cancel a call. Production behavior remains unchanged until a separately authorized deployment.
