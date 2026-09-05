# Personal OS Architecture Principles

These rules govern every current and future Personal OS intake path. They are product invariants, not prompt suggestions.

1. **Resolve Before Create** — Search and resolve an incoming intent against existing canonical objects before any create write.
2. **Update First** — When new information extends one existing object, patch that object instead of creating a second version.
3. **Relationship Before Merge** — Similarity is not permission to merge. Classify duplicate, update, related, dependency, parent/child, Goal link, and conflict first.
4. **Preserve Atomic Actions** — Keep independently completable actions independently completable, even when they share a project or data source.
5. **Non-Destructive First** — Uncertain matches create a separate object plus a potential relation. Automatic merge/update requires at least `0.90` confidence.
6. **Human Expresses, System Structures** — The user describes reality and intent; Personal OS maintains canonical identity, hierarchy, dependencies, and context.
7. **Cross-Session Intelligence** — Resolution uses persisted Personal OS and provider data, never only the current conversation window.
8. **Reuse Before Build** — Inspect the repository, installed capabilities, official APIs, and mature open source before introducing a new implementation or service.
9. **One Canonical Object** — One real-world object has one canonical representation, with all source intents and superseded IDs traceable to it.
10. **Explainable Automation** — Every automatic resolution records the original intent, candidates, decision, confidence, reason, before/after state, and related object IDs.
11. **Separate Occurrence, Execution, and Reminder** — Task date, scheduled execution, exact deadline, and notification time are distinct fields with distinct responsibilities.
12. **Reminder Is Metadata, Not an Object** — A reminder attaches to the canonical Schedule / Calendar Event; it never creates another Google Task or a synthetic Event.
13. **Minimum Necessary Notification** — Explicit user timing wins; otherwise infer only the smallest useful reminder set, and default ordinary Todos to no extra alert.

## Required intake sequence

```text
User intent
  -> normalize and extract action/object/entity/time/resource
  -> retrieve bounded persisted candidates
  -> classify semantic relationship
  -> apply confidence and non-destructive policy
  -> CREATE / UPDATE / MERGE / LINK / DEPEND / IGNORE
  -> resolve execution, deadline, and reminder policy independently
  -> persist canonical object, one Schedule, one Calendar projection, graph edges, and audit evidence
```

Technical idempotency and semantic resolution are independent safeguards. The first prevents retry duplication; the second recognizes the same real-world intent across different requests and conversations. Every write path must retain both.
