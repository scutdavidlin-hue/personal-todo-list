# Task Conversational Update V1 — implementation and acceptance

Date: 2026-09-05
Status: rules-based preview release in progress; production migrations applied. Full GPT and iPhone acceptance remain pending.

## WHY / GOAL

See PRD_TASK_CONVERSATIONAL_UPDATE_V1.md. The goal is continuing a task by speaking with context, clarification and confirmation, then updating the original Google Task with a durable history.

## Scope and reuse

- Extend canonical repository baseline e286824, not a second Personal OS.
- Existing task list and mobile Today page open the same task-bound conversation UI.
- Existing Supabase Auth/JWT, Google Tasks lifecycle, semantic resolution, Schedule/Calendar projection and MCP are reused.
- Conversation requests, proposals and immutable events are attached control/audit metadata; they are not a second editable Task store.
- Existing CRUD remains compatible. The new task-bound conversation endpoint requires a current proposal token for state changes.
- Microphone uses browser SpeechRecognition when supported; text and iPhone keyboard dictation remain available.

## Confirmed blockers

1. No existing server LLM/Speech-to-Text integration found in repository; `OPENAI_API_KEY` and `OPENAI_BASE_URL` are absent in this process. User has been asked for the existing service/config location, without requesting a secret in chat. The deterministic parser must be identified as a fallback, not GPT understanding.
2. Existing Supabase CLI was discovered and its read-only `projects list --output json` attempted. After resolving the sandbox file-write boundary, it reports `Access token not provided`. `SUPABASE_ACCESS_TOKEN` is absent. No cloud migration/deployment or real provider mutation was performed.
3. Real iPhone microphone/permissions and notification delivery are not available to local mocked tests. No claim of phone acceptance.

## Verification record

- Initial baseline plus client changes: `npm run verify`, 256 tests passed (before new conversation tests were integrated).
- MCP: existing cached Deno runtime with the existing MCP deno.json config passes full type checking after fixing argument types.
- Final `npm run verify`: 298 tests; 296 passed, 0 failed, 2 explicitly skipped browser tests. Existing static/syntax checks passed. Static web application has no separate bundler build command.
- Full cached Deno typecheck passed for `personal-os-mcp`, `task-conversation`, and `google-tasks` entrypoints using existing MCP configuration.
- `git diff --check` passed.
- Tests include actual deterministic parser + runtime confirmation, soft cancel, external change conflict, same-request replay, provider failure retry, original next-action semantics, direct notes, marker injection protection, and migration access-control assertions.
- Browser tests did not pass: sandbox Chrome launch failed with SIGABRT/EPERM; CUA reported `Browser is not available: iab`. Tests now require an explicitly supplied local isolated browser endpoint and never launch another browser by default.
- SQL was statically reviewed/tested, not executed against PostgreSQL; no local PostgreSQL/Docker executable or authenticated remote CLI was available.
- Two Sol/high development agents hit a usage limit; the controller took over their files, fixed compatibility/type/confirmation issues and completed combined checks. UI review used Terra/medium.

## Remaining engineering and acceptance limits

- Deterministic fallback covers the tested Chinese expressions, not general GPT intent understanding. Service configuration remains a required decision before completing the requested LLM phase.
- Exact-time fields/reminders belong to existing Schedule metadata; Google Tasks retains content/completion truth. Partial metadata/Calendar failures are reported explicitly and must be reconciled through existing lifecycle/scheduler; no claim of atomic cross-provider transaction.
- Same-request retries use persisted proposals and provider idempotency. A process killed while a request/proposal is `processing`/`committing` remains blocked pending reconciliation; no unsafe automatic lease takeover was added. This recovery case still needs a production-safe reconciliation acceptance test.
- Version fingerprints guard stale previews and recheck before lifecycle writes; external provider changes between read and PATCH are not protected by a Google ETag compare-and-swap in this baseline. Concurrent external editing must be covered before production acceptance.
- Existing task lifecycle history is included in interpretation context; conversation events are retained in immutable storage and the UI can request older pages. Pagination currently uses a timestamp cursor, so same-timestamp page boundaries require a cursor refinement before high-volume acceptance.
- The reuse decision passed selection. The full capability is not registered as validated because full task-level V1 acceptance is still pending.

## Release prerequisites

Use the existing Supabase account login on the Mac (`supabase login` via the installed CLI) or the existing protected access-token mechanism; never send credentials in conversation. Confirm the established LLM service location. Complete all local checks before release. Review and apply only the migration delta to the existing project, deploy affected functions, then publish the existing frontend workflow. Avoid an unreviewed all-migrations push because the baseline includes previously developed features whose production migration state must first be read.

A new provider/service, if required because no existing one is configured, requires explicit user approval under existing-system-first. This implementation does not install one silently.

## Acceptance boundary

Local tests passing establishes implementation behavior with fixtures. It does not establish database migration execution, GPT interpretation, Google Tasks production readback, Calendar production sync, or iPhone completion. Full V1 remains pending those steps.


## Preview release — 2026-09-05

User explicitly requested deployment to the existing Personal OS URL.
- Existing Supabase CLI login restored using the existing signed-in account.
- Production schema inspected; applied missing 050002, 050003 and 050004 migrations in one transaction. Google Tasks remains the sole content/status store.
- Production google-tasks and task-scheduler source backed up before replacement.
- Unknown questions/commands now clarify instead of silently appending notes. Failure UI no longer promises unconditional safe retries.
- Conversation create adapter preserves due date, exact Schedule time and parent/follow-up linkage; no date is invented for undated next actions.
- Combined verification: 303 tests, 301 passed, 0 failed, 2 browser tests skipped; three deployed function entrypoints pass cached Deno typecheck.
- Preview uses deterministic interpretation, explicitly identified in UI. This is not full GPT understanding.
- Deployment and browser readback results are recorded in the release task thread. Earlier blockers above are historical; server GPT integration and iPhone microphone/delivery acceptance remain outstanding.

- Production preview published at GitHub commit 84829844790a1dd6419ff49706b46d0836c9ef0d; Pages build 33973546317 succeeded.
- Signed-in Chrome verified task conversation loading, 20:15 -> 20:30 preview, natural-language confirmation and same Task/Event readback. Unknown question clarified without changing notes.
- Live acceptance found unpreviewed reminder inference on existing-task reschedule. Fixed preservation across scheduler normalization and Calendar projection. Regression: 307 tests, 305 passed, 0 failed, 2 skipped; new-task smart inference remains unchanged. Three runtime entrypoints passed typecheck again.

## iPhone stale-shell recovery — 2026-09-05

WHY: User screenshots showed Personal OS still without conversation controls despite published assets. Old workers can serve cached app.js before a new worker activates.
GOAL: Existing installed entry loads current code without clearing login/task data.
IMPLEMENTATION: New uncached loader pathname waits for worker activation before dynamic entry import; scoped shell-cache cleanup; network revalidation for code/styles; upgrade errors offer retry. Both main and today routes use the loader.
TEST: 308 passed, 0 failed, 2 skipped. Real isolated-browser test seeded legacy app.js in an active cache, navigated to new index.html, and read appRelease=20260905-conversation-4 with legacy=null. iPhone user-side acceptance remains pending.
