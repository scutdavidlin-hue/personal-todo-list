# Date-only creation repair — isolated draft

An explicitly dated create_task could be changed to today's date before provider
dispatch; Chinese quantity/list words could introduce 01:00 or 02:00; none could
then be rejected as REMINDER_MISSED. This draft repairs those reproduced
non-security date/time behaviors without modifying the already corrected real
Task, production, protected service paths, or the native PR #7.

## Final implementation

- `_shared/autonomy-policy.js` chooses the supported explicit execution date
  fields before inferred/context/default dates: requested_date/requestedDate,
  nested Schedule date, then due/dueDate. Existing requested_date precedence is
  retained. Invalid explicit date values reach normalizeIntake's validation
  instead of being silently replaced by today. Supplied due is execution Date,
  distinct from a separately supplied hard deadline.
- Chinese clock candidates require temporal context and skip quantity/list,
  relative and fractional wording. Rejected quantity candidates do not prevent
  recognizing a later real clock. Genuine afternoon, midnight, half-hour, bare
  event-clock and short time-change behavior are covered. This is bounded
  linguistic handling, not a claim to parse every possible Chinese sentence.
- An unanchored month-start/mid/end window does not default to today; it requires
  an exact execution date. A supplied date or exact date in the wording follows
  the normal path. No new window schema or invented day-one rule is introduced.
- `_shared/request-recovery.js` returns not-missed for explicit none, including
  past execution clocks or stale reminder fields. A genuinely enabled reminder
  still becomes missed after its instant. The ordinary missed-time comparison
  and account/lease/recovery guards are otherwise unchanged.

Only these two production shared modules change. No permission/authentication,
L3 confirmation, credentials, APNs, schema or provider-write code is modified.
The added L2 decision is exclusively business-date clarification for a month
window without an exact anchor. All original safety-policy tests remain in the
full suite and pass; no restricted runtime path is exercised.

## Verified results

Follow-up at da69503c: date-adjacent Chinese clocks retain their time when the
following action is outside the event-word vocabulary (办理 / 去超市 / 阅读).
Bare 月底 and 这个月底 also require an exact date, unless an explicit due/date
already supplies it. Original quantity, explicit-date and none-policy cases
remain covered. The follow-up adds ten synthetic regressions.

Local follow-up validation with existing Node 24.21.0: `npm run verify` reports
549 tests, 547 passed, two existing skips, zero failures; all 36 date regressions
pass. The four existing gateway/intake pure-simulation scenarios pass again.
These are local checks, not GitHub CI, deployment or iPhone acceptance. No Node
installation or network configuration change was needed.

The following totals describe the earlier PR revision, not this follow-up:

`npm run verify`: **539 tests, 537 passed, two existing browser tests skipped,
zero failures**. The 26 date regressions cover pure ISO date, due-only,
requested_date-only, matching and competing explicit fields, supported aliases,
invalid dates, anchored/unanchored month windows, no execution clock, quantity
words without a no-clock disclaimer, a later genuine clock, midnight/half-hour,
explicit time, none and real missed reminders. Existing deadline, recurrence,
current-task update, information-only and high-risk confirmation tests pass.

`node scripts/reproduce-date-only-create.mjs` executes actual type-stripped MCP
gateway functions and the actual intake handler through synthetic adapters. All
four fixed-clock cases now create exactly one simulated Task dated 2026-11-01,
with requested_time/scheduled_start null, none, reminder_at null and no missed
error. There are no real provider calls or Task writes. Gateway Hono/Zod
initialization, actual Deno deployment and production providers are not verified.

`docs/date-only-create-reproduction.json` is the archived pre-fix capture;
`docs/date-only-create-fixed.json` is the same scenarios after the repair. The
frozen clock, fictitious wording and adapter boundaries are documented in the
investigation report. Original customer request IDs/details are not included.

## Attribution and release limits

The baseline reproduces the reported shapes with due-only inputs and a
quantity-like 一点. If a valid requested_date=2026-11-01 actually reached the
same baseline handler together with due, that baseline control retains November
1. The original raw JSON/wording and exact deployed bundle were not inspected.
These confirmed defects therefore do not establish full causation for the
historical production incident. That conclusion is unchanged by fixing them.

This is code/test delivery only. No real Task update, production deployment,
merge, auth/permission change, credential access, APNs operation, native change
or macOS CI run occurred. PR #7's worktree remains at
`48fe9319fa45af19741e3deff38a47c885ed7c2f`. Future authorized release must use the
correct deployed-source baseline and package these shared helpers into the
affected intake/recovery bundles; this draft does not claim that rollout.
