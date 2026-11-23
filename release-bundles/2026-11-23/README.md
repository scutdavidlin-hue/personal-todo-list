# Personal OS reminder-reliability release — 2026-11-23

## Deployed, read back, and tested
Project ref: `zlezrdbloffdrkakqyiq` (Supabase Personal OS).

| Edge Function | Deployed version | Live bundle SHA-256 |
|---|---:|---|
| `personal-os-intake` | v21 | `5ef7a8299a5608a1f0f55ee074e64e0cedd0e6293a841e743687fb5adf7f75b0` |
| `task-scheduler` | v24 | `47660525dd51825edbb55a8d902ab4d4c68d6bc084e63633aad849dd23d67df7` |
| `google-tasks` | v22 | `8fd72e76fc3fe58b48c75016ed74b990bb524c83435292033a293b36af61fe69` |
| `personal-os-mcp` | v19 | `7076cfc20125f52e36217dab00b934231b84104c3cc19490bcaeba831fe50c21` |

**Important:** `supabase/functions/_shared` in the older repository was not identical to the live Edge Function bundles. For repeatable deployment use **each complete JSON release bundle** in this directory, including its own `files` collection and its exact `entrypoint_path` and optional `import_map_path`. Never reconstruct production packages from an arbitrarily mixed shared-directory snapshot. Existing `repair-backups/` contain pre-change rollback bundles.

## Repair summary
- Multi-weekday RRULE such as `FREQ=WEEKLY;BYDAY=TU,WE,TH,FR` supported; preserves old one-weekday rules.
- Chinese range/list phrasing (每周二到周五, 每周二、周三等) recognized.
- Date stepping across week boundary preserves local 18:00.
- Recurrence validator responds 400/`INVALID_RECURRENCE` instead of generic 503 and MCP surfaces a clear rejection rather than “outcome unknown”.
- First-occurrence verification permits explicit `reminder_policy=none` with already-verified Calendar event and `notification_status=not_required`.
- Calendar cancellation/deletion accepts verified `status=cancelled` tombstone as inactive, not only HTTP 404.
- Google Tasks deletion treats provider tombstone `deleted=true` as not found; retry confirms Schedule/Calendar cleanup and returns verified idempotent deletion, avoiding spurious partial 202.

## Evidence
- Isolated recurring rule tests: next dates 2026-11-24,25,26,27,12-01,02,03,04 (PASS).
- Real Google Tasks write + Schedule series + Calendar projection with multi-weekday rule: PASS.
- Multi-weekday series with explicit no-reminder policy: after targeted guard repair, recovered using the **same** original request ID (PASS).
- Idempotent replay of same request key returned the identical Task and Series (PASS).
- Invalid duplicate weekday rule returned HTTP 400 and MCP reported no Task created (PASS).
- Two temporary end-to-end Task/Series fixtures cancelled and deleted; user Task search showed zero remaining test tasks (PASS).
- Four existing Saturday-roundtable participant update reminders remain active at 18:00 Tue–Fri, configured as four existing independent weekly series, with no schedule mutation (PASS).
- Read-only sync inventory: 34 historical Calendar write errors occur exclusively on past dates; no future scheduled reminder has a current `CALENDAR_WRITE_UNVERIFIED` status. One future unscheduled no-reminder Task remains `sync_required`, not a reminder failure.

## Operational boundaries
- The UI/provider confirms that a Calendar reminder is configured, **not** that an iPhone device received a push. Device delivery needs a separate real scheduled observation.
- Do not auto-replay missed historical tasks, convert four existing series to one series, or mutate past records.
- A rollback must restore the exact named pre-change bundle with its original import map and auth setting, then verify the Task Schedule and four protected reminder IDs.
- Follow-up deployers must compare deployed SHA and current source before changing functions, then test the same intent/validation/idempotency/delete scenarios.
