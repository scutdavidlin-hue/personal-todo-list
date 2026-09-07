# Cloud PRD verification

- Branch: fix/cloud-calendar-task-sync
- Commit tested: 4267cb3f2c00a0feda46ecbe0f8cd67f4b493c35
- main baseline npm run verify exit code: 1
- fix branch npm run verify exit code: 1

## Main baseline failures
```text
196:not ok 37 - real intake handler writes, reads back, and returns the verified confirmation
200:  failureType: 'testCodeFailure'
201:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
212:not ok 38 - real intake handler answers pure questions without provider or audit writes
216:  failureType: 'testCodeFailure'
217:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
228:not ok 39 - real intake handler blocks L3 money operations before any write
232:  failureType: 'testCodeFailure'
233:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
244:not ok 40 - short corrections use the provider update route and retain the current task id
248:  failureType: 'testCodeFailure'
249:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
260:not ok 41 - a failed provider readback never reports a successful write
264:  failureType: 'testCodeFailure'
265:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
276:not ok 42 - mixed current action and lasting preference reports a partial result
280:  failureType: 'testCodeFailure'
281:  error: 'Unknown file extension ".ts" for /tmp/personal-os-main/supabase/functions/personal-os-intake/index.ts'
1697:# tests 323
1699:# pass 315
1700:# fail 6
1702:# skipped 2
```

## Fix branch failures
```text
196:not ok 37 - real intake handler writes, reads back, and returns the verified confirmation
200:  failureType: 'testCodeFailure'
201:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
212:not ok 38 - real intake handler answers pure questions without provider or audit writes
216:  failureType: 'testCodeFailure'
217:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
228:not ok 39 - real intake handler blocks L3 money operations before any write
232:  failureType: 'testCodeFailure'
233:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
244:not ok 40 - short corrections use the provider update route and retain the current task id
248:  failureType: 'testCodeFailure'
249:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
260:not ok 41 - a failed provider readback never reports a successful write
264:  failureType: 'testCodeFailure'
265:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
276:not ok 42 - mixed current action and lasting preference reports a partial result
280:  failureType: 'testCodeFailure'
281:  error: 'Unknown file extension ".ts" for /home/runner/work/personal-todo-list/personal-todo-list/supabase/functions/personal-os-intake/index.ts'
1707:# tests 325
1709:# pass 317
1710:# fail 6
1712:# skipped 2
```

## Fix branch log tail
```text
  ...
# Subtest: conflicting explicit Goal and Project context stops before Task persistence
ok 312 - conflicting explicit Goal and Project context stops before Task persistence
  ---
  duration_ms: 1.131896
  ...
# Subtest: an unassigned Project cannot be combined with an unrelated explicit Goal
ok 313 - an unassigned Project cannot be combined with an unrelated explicit Goal
  ---
  duration_ms: 0.493137
  ...
# Subtest: semantic profile hits outside the provider window are hydrated by stable Task id
ok 314 - semantic profile hits outside the provider window are hydrated by stable Task id
  ---
  duration_ms: 0.81701
  ...
# Subtest: explicit prerequisites outside the provider window are fetched and validated
ok 315 - explicit prerequisites outside the provider window are fetched and validated
  ---
  duration_ms: 0.519125
  ...
# Subtest: a missing explicit prerequisite aborts resolution before creating a dangling edge
ok 316 - a missing explicit prerequisite aborts resolution before creating a dangling edge
  ---
  duration_ms: 0.447022
  ...
# Subtest: runtime executes one canonical update and persists explainability metadata
ok 317 - runtime executes one canonical update and persists explainability metadata
  ---
  duration_ms: 1.697267
  ...
# Subtest: duplicate reuse is auditable without creating an invalid self-edge
ok 318 - duplicate reuse is auditable without creating an invalid self-edge
  ---
  duration_ms: 1.307452
  ...
# Subtest: profile upsert preserves durable context while adding new resolution evidence
ok 319 - profile upsert preserves durable context while adding new resolution evidence
  ---
  duration_ms: 0.445358
  ...
# Subtest: resource and Goal upserts preserve stronger existing metadata
ok 320 - resource and Goal upserts preserve stronger existing metadata
  ---
  duration_ms: 0.519757
  ...
# Subtest: moving a Task to a different Goal never carries an incompatible Project link
ok 321 - moving a Task to a different Goal never carries an incompatible Project link
  ---
  duration_ms: 0.345092
  ...
# Subtest: moving a semantic profile to a different Goal clears its old Project
ok 322 - moving a semantic profile to a different Goal clears its old Project
  ---
  duration_ms: 0.363376
  ...
# Subtest: linking an unassigned Project clears an incompatible existing Goal
ok 323 - linking an unassigned Project clears an incompatible existing Goal
  ---
  duration_ms: 0.328572
  ...
# Subtest: a Project can be linked without inventing a Goal
ok 324 - a Project can be linked without inventing a Goal
  ---
  duration_ms: 0.313543
  ...
# Subtest: relationship persistence canonicalizes symmetric edges and rejects dependency cycles
ok 325 - relationship persistence canonicalizes symmetric edges and rejects dependency cycles
  ---
  duration_ms: 1.074088
  ...
1..325
# tests 325
# suites 0
# pass 317
# fail 6
# cancelled 0
# skipped 2
# todo 0
# duration_ms 1505.832533
```
