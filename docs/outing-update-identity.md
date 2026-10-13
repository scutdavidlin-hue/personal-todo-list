# Outing update identity and confidence gate

## Problem

A new family Halloween outing for October 13 was classified as an additive update of an October 18 mountain outing. The original command supplied no existing task ID. The resolver returned UPDATE with confidence 0.2547 and the executor still patched the previous task.

The audited path treated assistant notes about checking arrangements as action `verify` for both tasks. The incoming profile had no recognized domain/entity, so `ellipticalIdentity` accepted the shared generic action. Both profiles containing October satisfied `monthExtension`, even though no month was being added. The word 一起 in a description of accompanying family supplied the additive cue. Lowering the returned confidence did not prevent execution.

## Changes

- Scope extension requires actual current-user scope wording, such as adding a month to an analysis, rather than generic accompaniment words or assistant notes.
- A month extension must introduce a month outside the previous scope; merely sharing a calendar month is insufficient.
- An ordinary creation/reminder command with a different existing execution date cannot be inferred as a reschedule without a positive update command.
- Weak additive UPDATE results expose CLARIFY and require clarification. The executor independently refuses UPDATE or MERGE below the existing 0.9 automatic threshold, including missing/non-finite confidence, before audit or provider mutations.
- Exact authorized task-ID updates and strong same-identity updates retain their existing paths. An underspecified low-confidence analytical scope change now requires target clarification instead of silently patching a weak match.

## Validation and delivery

Full repository verification: 487 tests, 485 passed, 2 skipped, 0 failed. Isolated tests reproduce the original wording and notes without adding independent/new boilerplate; same-date and cross-month distinct activities create separate actions. Executor tests verify one simulated create with the old task unchanged, no side effects for weak update confidence, and correct audit/metadata for an exact authorized date change. Existing negation, quote, duplicate and ambiguity tests remain.

This is a separate draft from the receipt PR. Its base is the already deployed v18 source commit `82ea513fecc8eee44d856ca2609b324428845015`, mirrored to a baseline branch so the PR diff contains only this fix. Production task-status and google-tasks remain v18; no deployment, credentials, permissions, Cron or real task edits were performed.
