# Reminder clearing and verified receipts

## Evidence and scope

Readonly production inspection found a developer task whose Google Task date is October 13 while its Schedule remains October 15 at noon with custom reminders. This draft does not correct that production record, touch the unrelated ticket-buying task, or deploy any function.

The isolated reproduction confirms that clearing requested_time leaves user-explicit custom reminder specs behind, causing `Reminder overrides require a scheduled or deadline time`. Direct none updates with inferred provenance can re-infer an old example from original wording. The original reminder gateway trusted success without checking the canonical cleared fields. The exact provenance of the two historical none calls cannot be proved from the stored Schedule alone.

## Change and safety boundaries

- Removing execution time without a remaining deadline anchor clears execution reminder specs and records that there is no reminder anchor. Schedule planning/validation runs before changing Google Task content.
- A direct none operation is normalized once with its current explicit operation preserved; old example text cannot re-enable it during a second normalization.
- The reminder endpoint reads canonical Schedule state after projection, compares normalized requested fields, requires successful synchronization and Calendar readback, and returns verified only then. The MCP gateway requires that receipt and validates none/null/empty fields before saying the reminder was cleared.
- Clearing a timed projection reuses the existing cleanup path only for the deterministic Calendar ID with matching googleTaskId and personalOsProjection private markers. It requires an ETag, sends If-Match, and verifies absence afterward. Unknown or unrelated Calendar objects are refused; Task completion/cancellation is never used to clear reminders.
- Google Tasks, Schedule and Calendar cannot form one distributed atomic transaction. Semantic validation happens first; downstream failure remains a partial or unverified outcome, not successful atomic completion. No automatic unsafe rollback of other tasks or activities is introduced.

The initial example-versus-current-intent parser remains outside this clearing-interface draft. This work prevents old examples from reviving a reminder during an explicit correction; it does not claim to solve every initial example extraction case.

## Validation

`npm run verify`: 489 tests, 487 passed, 2 skipped, 0 failed. All changed behavior is exercised with simulated records and isolated provider responses. Actual scheduler handlers cover explicit none, stale metadata acknowledgement, ignored Calendar reminder patch, ignored projection removal, foreign identity, missing ETag, and preservation of an unrelated event. Actual gateway code rejects accepted but unverified/uncleared responses. An actual Task handler test proves a bad combined timing plan stops before Google Task mutation.

## Release dependency

This is separate from PR3 receipts and PR4 outing identity. Its base is the production v18 source commit 82ea513. Changes to the MCP file must be composed with PR3 rather than copying the entire older file over it. Deploying this draft would also require the reused schedule-core/reminder-policy modules in the google-tasks bundle. Future approved release order: scheduler and shared backend helpers, both task entrypoints, then MCP. No permissions, credentials, Cron, paid services or real data were changed for this draft.
