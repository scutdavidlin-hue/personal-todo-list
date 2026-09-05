# Personal OS — Intelligent Task Resolution Layer V1.0

**Priority:** P0 / foundational infrastructure

**Date:** 2026-09-05
**Scope:** Personal OS, Google Tasks, Goals & Plans, Calendar Projection, and future object intake adapters

## Product contract

Personal OS must resolve every incoming Task, Goal, Plan, or Action against persisted context before writing. `CREATE` is one possible outcome, never the default.

```text
Intent -> understand -> retrieve -> resolve relationship -> decide -> persist
```

The supported Task decisions are `NEW`, `DUPLICATE`, `UPDATE`, `MERGE`, `RELATED`, `DEPENDENCY`, `PARENT_CHILD`, `GOAL_LINK`, and `CONFLICT`.

The system preserves independently completable actions, uses non-destructive links when uncertain, keeps one canonical object, and records enough evidence to answer “why was this updated or merged?” across conversations.

## Confidence policy

- `>= 0.90`: automatic reuse/update/explicit merge is allowed.
- `0.70–0.90`: use low-risk `RELATED`, dependency, or Goal links; do not destructively collapse Tasks.
- `< 0.70`: create the independent Task and optionally record `POTENTIAL_RELATION`.

## Required persistence

Canonical identity, source intent IDs, parent/child edges, dependencies, related links, Goal/Project context, shared resource access, conflicts, confidence, reason, before/after state, and semantic-resolution timestamps must be durable. Raw source data is never deleted merely because a model predicts duplication.

## Acceptance suite

1. Repeated “明天整理财务数据” wording produces one canonical Task.
2. “八月份也一起分析” updates the June/July analysis Task.
3. “成本出来后分析利润” creates a second Task that depends on the cost Task.
4. A complete analysis with enumerated components creates a parent and atomic children.
5. Related but independently completable actions remain separate and linked.
6. Sharing `financial_records` is detected without becoming a merge rule.
7. Task Semantic Resolution links the existing Personal OS product Goal instead of creating another Goal.
8. Low-confidence similarity never triggers destructive merge.
9. Replaying one API request still produces one write through the existing idempotency key.
10. A task rephrased three days later is resolved from persisted data, not current chat memory.

The detailed engineering design and source-of-truth boundaries are in `ARCHITECTURE_TASK_RESOLUTION_V1.md`; the permanent governance rules are in `PERSONAL_OS_ARCHITECTURE_PRINCIPLES.md`.
