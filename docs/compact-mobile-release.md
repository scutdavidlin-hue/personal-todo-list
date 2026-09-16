# Compact mobile release

## WHY
The approved prototype prioritizes monthly planning, continuous task lists and compact iPhone delivery before further feature expansion.

## GOAL
Extend the existing Personal OS app with Today / Calendar / Tasks / Plans, preserving Google Tasks as the sole task content and completion source, Calendar as projection and existing Goals data.

## ACCEPTANCE CRITERIA
- Monthly 7-column grid; prior/next month; selected-day agenda; same-ID event edit.
- Task title/date open existing editor; today/tomorrow/day-after/week/no-date shortcuts; continuous previous/today/future/no-date groups.
- Short/medium/long plan sections visible together.
- Existing login, intake/conversation, schedules, goal links and review retained.
- Existing iPhone entry upgrades through cache release; legacy today URL forwards preserving OAuth return data.
- No seed data, migrations, new task store or new service.

## IMPLEMENTATION
Strategy EXTEND: reuse TaskCloudClient, task-scheduler calendar event actions and task lifecycle; compact presentation override; calendar view module. Calendar updates use concurrency token and server readback, task projections route to original Task via schedule event ID. Unsupported standalone event create/delete are not offered. Default calendar is the existing primary calendar; times are explicitly Shanghai time.

## TEST
Repository npm run verify; new calendar range, timezone, projection deduplication and client verification tests. Manual browser checks and production readback recorded separately. Unit checks cannot establish iPhone acceptance.

## RESULT
Published to the existing GitHub Pages site; application commit 3427251 has a successful Pages build. Existing task-scheduler deployed as ACTIVE v11 with its prior gateway configuration and unchanged handler owner authentication. Anonymous Calendar search returns 401.

Verification: npm run verify passes (351 tests: 349 pass, 2 existing skips). Signed-in Chrome at 390 × 844 read real Tasks, Goals and Calendar; the event edit form populated via exact-event GET. Task date shortcut changed draft to day-after-tomorrow and was cancelled; no real task/event mutations were used as tests. Plans show all three horizons and document width has no horizontal overflow. Prior event-read/logout race fixed during review.

User iPhone physical-device acceptance remains pending. Existing historical Task/Schedule date discrepancies were observed and preserved; this UI release does not silently reconcile production records. Independent Calendar create/delete are not included; more than 100 matching events on one day is explicitly incomplete. No new service, credentials or data migration.

Human interventions: 0. Approval prompts: 0. Autonomous recoveries: stale cache-version verifier updated, cached CLI reused, async event-read race repaired.
