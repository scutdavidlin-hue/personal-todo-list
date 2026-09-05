# Intelligent Task Resolution Layer V1

## WHY

Personal OS currently protects repeated API calls and recognizes a narrow same-title duplicate, but it cannot reliably distinguish a duplicate from an update, related action, dependency, hierarchy, Goal association, or shared-resource conflict. Repeated natural-language intake can therefore create fragmented Task state.

## GOAL

Put one explainable `TaskResolutionEngine` in front of every Task create path while keeping Google Tasks as the only active Task content/completion source. Persist only semantic profiles, graph edges, resource access, and audit evidence in Supabase.

## ACCEPTANCE CRITERIA

- All nine decisions are represented: `NEW`, `DUPLICATE`, `UPDATE`, `MERGE`, `RELATED`, `DEPENDENCY`, `PARENT_CHILD`, `GOAL_LINK`, and `CONFLICT`.
- Confidence `>= 0.90` may update/reuse automatically; `0.70–0.90` prefers safe links; lower confidence preserves the new atomic action and records only a potential relation.
- Parent-child creation uses native Google Tasks parent IDs.
- Dependency edges drive `READY`, `BLOCKED`, and `WAITING` execution status without copying Task completion state into Supabase.
- Shared resources are visible but never act as a merge rule by themselves.
- Every resolution is cross-session, idempotent, non-destructive, and explainable.
- The ten PRD scenarios have automated regression coverage.

## IMPLEMENTATION

```text
Personal OS intake / MCP / Web create
                  |
                  v
        persisted candidate retrieval
        - open Google Tasks
        - overdue/future Tasks
        - recently completed Tasks
        - matching Goal/Project context
        - pg_trgm semantic profiles
                  |
                  v
         task-resolution-engine.js
        normalize -> extract -> score
        -> classify -> safety policy
                  |
         +--------+---------+
         |                  |
   mutation plan        audit plan
         |                  |
         v                  v
 Google Tasks API      Supabase metadata
 create/update/parent  profile/edge/resource/audit
         |
         v
 Calendar projection + Task execution graph
```

### Data ownership

| Concern | Canonical owner |
| --- | --- |
| Task title, notes, due date, completion | Google Tasks |
| Goal and Plan content | `goals_plans` |
| Task-to-Goal/Project link | `task_context_links` |
| Calendar projection | `task_schedule_metadata` + Google Calendar |
| Semantic candidate profile | `task_resolution_profiles` (non-authoritative metadata) |
| Task DAG edge | `task_relationships` |
| Read/write resource declaration | `task_resource_bindings` |
| Resolution explanation | `task_resolution_audit` |
| API retry safety | existing intake/lifecycle idempotency ledgers |

### Decision semantics

| Decision | Provider write | Graph/audit behavior |
| --- | --- | --- |
| `DUPLICATE` | Reuse canonical Task; optional metadata enrichment | Record source intent → canonical identity in audit; never create a self-edge or delete |
| `UPDATE` | Patch canonical Task | Record before/after and source intent |
| `MERGE` | Patch canonical Task only at high confidence/explicit deliverable evidence | Preserve the merged source in audit; create no invalid self-edge |
| `RELATED` | Create independent Task | Add `RELATED_TO` |
| `DEPENDENCY` | Create independent Task | Add directed `DEPENDS_ON` |
| `PARENT_CHILD` | Create parent then native Google subtasks | Add `PARENT_OF` edges |
| `GOAL_LINK` | Create Task | Upsert existing `task_context_links`; never create a Goal |
| `CONFLICT` | Preserve independent Task | Add `CONFLICTS_WITH`; scheduler must not parallelize |
| `NEW` | Create Task | Optionally add low-confidence `POTENTIAL_RELATION` |

## TEST

Automated tests cover the ten PRD cases plus explicit merge, write/write conflict, schema-before-UI dependency, cycle rejection, readiness release, resource-aware parallelism, normalization, and semantic profile persistence.

## RESULT

Implementation status is tracked in `PROGRESS.md`. Selection evidence and the mature-capability comparison are stored in `docs/reuse-first-task-resolution.json`.
