# Cloud PRD verification

- Branch: fix/cloud-calendar-task-sync
- Commit tested: 6c9249f0392422cfee82f46bddfc5b5e511dfa83
- npm run verify exit code: 1

## Log tail
```text
  ...
# Subtest: candidate retrieval keeps open tasks and only recently completed history
ok 304 - candidate retrieval keeps open tasks and only recently completed history
  ---
  duration_ms: 2.28155
  ...
# Subtest: provider truth is enriched with durable cross-session metadata
ok 305 - provider truth is enriched with durable cross-session metadata
  ---
  duration_ms: 7.327556
  ...
# Subtest: enriched candidates remain valid inputs to the resolver
ok 306 - enriched candidates remain valid inputs to the resolver
  ---
  duration_ms: 15.610847
  ...
# Subtest: closed Goals are not resolution candidates
ok 307 - closed Goals are not resolution candidates
  ---
  duration_ms: 0.191886
  ...
# Subtest: context loading asks the semantic index and only open Goals for bounded candidates
ok 308 - context loading asks the semantic index and only open Goals for bounded candidates
  ---
  duration_ms: 0.732651
  ...
# Subtest: an explicit Goal id is retrieved directly instead of relying on recent ordering
ok 309 - an explicit Goal id is retrieved directly instead of relying on recent ordering
  ---
  duration_ms: 0.780671
  ...
# Subtest: a missing or closed explicit Goal stops before Task persistence
ok 310 - a missing or closed explicit Goal stops before Task persistence
  ---
  duration_ms: 0.832397
  ...
# Subtest: a Project supplies its canonical Goal context before semantic matching
ok 311 - a Project supplies its canonical Goal context before semantic matching
  ---
  duration_ms: 0.567595
  ...
# Subtest: conflicting explicit Goal and Project context stops before Task persistence
ok 312 - conflicting explicit Goal and Project context stops before Task persistence
  ---
  duration_ms: 1.110483
  ...
# Subtest: an unassigned Project cannot be combined with an unrelated explicit Goal
ok 313 - an unassigned Project cannot be combined with an unrelated explicit Goal
  ---
  duration_ms: 0.441812
  ...
# Subtest: semantic profile hits outside the provider window are hydrated by stable Task id
ok 314 - semantic profile hits outside the provider window are hydrated by stable Task id
  ---
  duration_ms: 0.793384
  ...
# Subtest: explicit prerequisites outside the provider window are fetched and validated
ok 315 - explicit prerequisites outside the provider window are fetched and validated
  ---
  duration_ms: 0.51156
  ...
# Subtest: a missing explicit prerequisite aborts resolution before creating a dangling edge
ok 316 - a missing explicit prerequisite aborts resolution before creating a dangling edge
  ---
  duration_ms: 0.406816
  ...
# Subtest: runtime executes one canonical update and persists explainability metadata
ok 317 - runtime executes one canonical update and persists explainability metadata
  ---
  duration_ms: 1.673831
  ...
# Subtest: duplicate reuse is auditable without creating an invalid self-edge
ok 318 - duplicate reuse is auditable without creating an invalid self-edge
  ---
  duration_ms: 1.219225
  ...
# Subtest: profile upsert preserves durable context while adding new resolution evidence
ok 319 - profile upsert preserves durable context while adding new resolution evidence
  ---
  duration_ms: 0.434398
  ...
# Subtest: resource and Goal upserts preserve stronger existing metadata
ok 320 - resource and Goal upserts preserve stronger existing metadata
  ---
  duration_ms: 0.50562
  ...
# Subtest: moving a Task to a different Goal never carries an incompatible Project link
ok 321 - moving a Task to a different Goal never carries an incompatible Project link
  ---
  duration_ms: 0.336095
  ...
# Subtest: moving a semantic profile to a different Goal clears its old Project
ok 322 - moving a semantic profile to a different Goal clears its old Project
  ---
  duration_ms: 0.346775
  ...
# Subtest: linking an unassigned Project clears an incompatible existing Goal
ok 323 - linking an unassigned Project clears an incompatible existing Goal
  ---
  duration_ms: 0.325695
  ...
# Subtest: a Project can be linked without inventing a Goal
ok 324 - a Project can be linked without inventing a Goal
  ---
  duration_ms: 0.296992
  ...
# Subtest: relationship persistence canonicalizes symmetric edges and rejects dependency cycles
ok 325 - relationship persistence canonicalizes symmetric edges and rejects dependency cycles
  ---
  duration_ms: 1.004176
  ...
1..325
# tests 325
# suites 0
# pass 317
# fail 6
# cancelled 0
# skipped 2
# todo 0
# duration_ms 1407.808505
```
