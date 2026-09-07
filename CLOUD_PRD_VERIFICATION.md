# Cloud PRD verification

- Branch: fix/cloud-calendar-task-sync
- Commit tested before result commit: 41d5db347c4044e09fdce42b68428aadace2ed39
- npm run verify exit code: 0

## Failure summary
```text
1661:# tests 325
1663:# pass 323
1664:# fail 0
1666:# skipped 2
```

## Log tail
```text
  ...
# Subtest: context loading asks the semantic index and only open Goals for bounded candidates
ok 308 - context loading asks the semantic index and only open Goals for bounded candidates
  ---
  duration_ms: 1.110502
  ...
# Subtest: an explicit Goal id is retrieved directly instead of relying on recent ordering
ok 309 - an explicit Goal id is retrieved directly instead of relying on recent ordering
  ---
  duration_ms: 1.273344
  ...
# Subtest: a missing or closed explicit Goal stops before Task persistence
ok 310 - a missing or closed explicit Goal stops before Task persistence
  ---
  duration_ms: 1.036534
  ...
# Subtest: a Project supplies its canonical Goal context before semantic matching
ok 311 - a Project supplies its canonical Goal context before semantic matching
  ---
  duration_ms: 0.752628
  ...
# Subtest: conflicting explicit Goal and Project context stops before Task persistence
ok 312 - conflicting explicit Goal and Project context stops before Task persistence
  ---
  duration_ms: 0.61915
  ...
# Subtest: an unassigned Project cannot be combined with an unrelated explicit Goal
ok 313 - an unassigned Project cannot be combined with an unrelated explicit Goal
  ---
  duration_ms: 0.58193
  ...
# Subtest: semantic profile hits outside the provider window are hydrated by stable Task id
ok 314 - semantic profile hits outside the provider window are hydrated by stable Task id
  ---
  duration_ms: 0.97521
  ...
# Subtest: explicit prerequisites outside the provider window are fetched and validated
ok 315 - explicit prerequisites outside the provider window are fetched and validated
  ---
  duration_ms: 0.689391
  ...
# Subtest: a missing explicit prerequisite aborts resolution before creating a dangling edge
ok 316 - a missing explicit prerequisite aborts resolution before creating a dangling edge
  ---
  duration_ms: 0.50628
  ...
# Subtest: runtime executes one canonical update and persists explainability metadata
ok 317 - runtime executes one canonical update and persists explainability metadata
  ---
  duration_ms: 2.139112
  ...
# Subtest: duplicate reuse is auditable without creating an invalid self-edge
ok 318 - duplicate reuse is auditable without creating an invalid self-edge
  ---
  duration_ms: 1.541833
  ...
# Subtest: profile upsert preserves durable context while adding new resolution evidence
ok 319 - profile upsert preserves durable context while adding new resolution evidence
  ---
  duration_ms: 0.520116
  ...
# Subtest: resource and Goal upserts preserve stronger existing metadata
ok 320 - resource and Goal upserts preserve stronger existing metadata
  ---
  duration_ms: 0.572112
  ...
# Subtest: moving a Task to a different Goal never carries an incompatible Project link
ok 321 - moving a Task to a different Goal never carries an incompatible Project link
  ---
  duration_ms: 0.455335
  ...
# Subtest: moving a semantic profile to a different Goal clears its old Project
ok 322 - moving a semantic profile to a different Goal clears its old Project
  ---
  duration_ms: 0.39323
  ...
# Subtest: linking an unassigned Project clears an incompatible existing Goal
ok 323 - linking an unassigned Project clears an incompatible existing Goal
  ---
  duration_ms: 0.418076
  ...
# Subtest: a Project can be linked without inventing a Goal
ok 324 - a Project can be linked without inventing a Goal
  ---
  duration_ms: 0.361681
  ...
# Subtest: relationship persistence canonicalizes symmetric edges and rejects dependency cycles
ok 325 - relationship persistence canonicalizes symmetric edges and rejects dependency cycles
  ---
  duration_ms: 1.167618
  ...
1..325
# tests 325
# suites 0
# pass 323
# fail 0
# cancelled 0
# skipped 2
# todo 0
# duration_ms 5076.103326
```
