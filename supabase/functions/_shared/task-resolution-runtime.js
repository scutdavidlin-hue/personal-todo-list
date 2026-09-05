import { validateTaskRelationship } from "./task-graph-core.js";
import { executeTaskResolution } from "./task-resolution-executor.js";
import { extractIntentProfile, resolveTaskIntent } from "./task-resolution-engine.js";

const CLOSED_GOAL_STATUSES = new Set(["completed", "dropped", "archived"]);
const COMPLETE_TASK_STATUSES = new Set(["completed", "done"]);
const SYMMETRIC_RELATIONSHIPS = new Set([
  "RELATED_TO",
  "POTENTIAL_RELATION",
  "CONFLICTS_WITH",
  "SHARES_RESOURCE",
]);

function clean(value, maxLength = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function taskId(task) {
  return clean(task?.task_id || task?.google_task_id || task?.id || task?.externalId, 1_024);
}

function statusOf(task) {
  return clean(task?.status, 40).toLowerCase() || (task?.done ? "completed" : "open");
}

function timestampOf(task) {
  for (const value of [task?.completedAt, task?.completed_at, task?.updatedAt, task?.updated_at, task?.createdAt, task?.created_at]) {
    const parsed = Date.parse(String(value || ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => clean(String(value), 1_024)).filter(Boolean))];
}

function mergedResourceAccess(left, right) {
  const values = new Set([left, right].filter(Boolean));
  if (values.has("read_write") || (values.has("read") && values.has("write"))) return "read_write";
  return values.has("write") ? "write" : "read";
}

function canonicalRelationship(item) {
  const relationship = {
    ...item,
    relationship_type: clean(item?.relationship_type || item?.type, 80).toUpperCase(),
    from_task_id: clean(item?.from_task_id || item?.from, 1_024),
    to_task_id: clean(item?.to_task_id || item?.to, 1_024),
  };
  if (SYMMETRIC_RELATIONSHIPS.has(relationship.relationship_type)
    && relationship.from_task_id.localeCompare(relationship.to_task_id) > 0) {
    [relationship.from_task_id, relationship.to_task_id] = [relationship.to_task_id, relationship.from_task_id];
  }
  return relationship;
}

function resolutionAuditPayload(ownerId, audit, plan, options) {
  return {
    owner_id: ownerId,
    intake_audit_id: options.intakeAuditId || null,
    idempotency_key: options.resolutionIdempotencyKey || null,
    original_intent: clean(audit.original_intent, 10_000),
    normalized_intent: audit.normalized_intent || {},
    decision: audit.decision,
    confidence: audit.confidence,
    automatic_action: clean(plan.automatic_action, 80)
      || plan.operations.map((item) => item.type).join("+").toUpperCase().slice(0, 80)
      || "CREATE",
    existing_task_id: audit.existing_task_id || null,
    candidate_snapshot: audit.candidate_snapshot || [],
    related_object_ids: audit.related_object_ids || {},
    reason: clean(audit.reason, 4_000),
    status: "processing",
  };
}

/**
 * Keep retrieval bounded before semantic scoring. Open Tasks are always eligible;
 * only recently completed Tasks are retained as historical candidates.
 */
export function selectTaskCandidateWindow(tasks = [], options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const completedSince = now.valueOf() - Math.max(1, Number(options.recentCompletedDays || 90)) * 86_400_000;
  const openLimit = Math.max(1, Math.min(5_000, Number(options.openLimit || 400)));
  const completedLimit = Math.max(0, Math.min(500, Number(options.completedLimit ?? 100)));
  const seen = new Set();
  const eligible = tasks.filter((task) => {
    const id = taskId(task);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    const completed = COMPLETE_TASK_STATUSES.has(statusOf(task));
    return !completed || timestampOf(task) >= completedSince;
  });
  const open = eligible.filter((task) => !COMPLETE_TASK_STATUSES.has(statusOf(task)))
    .sort((left, right) => timestampOf(right) - timestampOf(left))
    .slice(0, openLimit);
  const completed = eligible.filter((task) => COMPLETE_TASK_STATUSES.has(statusOf(task)))
    .sort((left, right) => timestampOf(right) - timestampOf(left))
    .slice(0, completedLimit);
  return [...open, ...completed];
}

/** Join durable semantic metadata to freshly read provider truth. */
export function enrichTaskCandidates(tasks = [], profiles = []) {
  const profileByTask = new Map(profiles.map((profile) => [String(profile.google_task_id), profile]));
  return tasks.map((task) => {
    const profile = profileByTask.get(taskId(task));
    if (!profile) return task;
    const inferred = extractIntentProfile(task);
    return {
      ...task,
      canonical_task_id: profile.canonical_task_id || taskId(task),
      normalized_text: profile.normalized_title || inferred.normalized_text,
      semantic_key: profile.semantic_key || inferred.semantic_key,
      action: profile.action || inferred.action,
      entities: profile.entities?.length ? profile.entities : inferred.entities,
      topics: profile.topics?.length ? profile.topics : inferred.topics,
      months: inferred.months,
      resources: profile.resources?.length ? profile.resources : inferred.resources,
      read_resources: profile.read_resources?.length ? profile.read_resources : inferred.read_resources,
      write_resources: profile.write_resources?.length ? profile.write_resources : inferred.write_resources,
      resource_fields: profile.resource_fields?.length ? profile.resource_fields : inferred.resource_fields,
      goal_plan_id: profile.goal_plan_id || null,
      project_id: profile.project_id || null,
      due: task?.dueDate || task?.due || task?.date || null,
      additive: false,
      explicit_merge: false,
      explicit_update: false,
      dependency_cue: false,
      parent_child_cue: false,
    };
  });
}

export function selectGoalCandidateWindow(goals = [], limit = 100) {
  return goals
    .filter((goal) => goal?.id && !CLOSED_GOAL_STATUSES.has(clean(goal.status, 40).toLowerCase()))
    .sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 100)));
}

export function buildTaskResolutionContext(tasks = [], profiles = [], goals = [], options = {}) {
  return {
    tasks: enrichTaskCandidates(selectTaskCandidateWindow(tasks, options), profiles),
    goals: selectGoalCandidateWindow(goals, options.goalLimit || 100),
    candidate_limit: Math.max(1, Math.min(50, Number(options.candidateLimit || 20))),
  };
}

export async function loadTaskResolutionContext(configuration = {}) {
  const {
  serviceRest,
  ownerId,
  incoming,
  providerTasks = [],
  providerGetTask,
  options = {},
  } = configuration;
  if (typeof serviceRest !== "function") throw new Error("serviceRest is required");
  const owner = clean(ownerId, 100);
  if (!owner) throw new Error("ownerId is required");
  const profile = extractIntentProfile(incoming || {});
  let projectGoalId = null;
  if (profile.project_id) {
    const projectQuery = new URLSearchParams({
      owner_id: `eq.${owner}`,
      id: `eq.${profile.project_id}`,
      select: "id,goal_plan_id",
      limit: "1",
    });
    const project = (await serviceRest(`projects?${projectQuery}`))?.[0];
    if (!project?.id) throw new Error(`Project was not found: ${profile.project_id}`);
    projectGoalId = project.goal_plan_id || null;
    if (profile.goal_plan_id && profile.goal_plan_id !== projectGoalId) {
      throw new Error("Project does not belong to the supplied Goal");
    }
  }
  const effectiveGoalId = profile.goal_plan_id || projectGoalId;
  const goalQuery = new URLSearchParams({
    owner_id: `eq.${owner}`,
    status: "not.in.(Completed,Dropped,Archived)",
    select: "id,title,description,why,notes,status,updated_at",
    order: "updated_at.desc",
    limit: String(Math.max(1, Math.min(200, Number(options.goalLimit || 100)))),
  });
  if (effectiveGoalId) goalQuery.set("id", `eq.${effectiveGoalId}`);
  const [profiles, goals] = await Promise.all([
    serviceRest("rpc/search_task_resolution_profiles", {
      method: "POST",
      body: JSON.stringify({
        target_owner: owner,
        query_text: profile.normalized_text,
        query_entities: profile.entities,
        query_topics: profile.topics,
        query_resources: profile.resources,
        match_count: Math.max(1, Math.min(50, Number(options.profileLimit || 20))),
      }),
    }),
    serviceRest(`goals_plans?${goalQuery}`),
  ]);
  if (effectiveGoalId && !goals?.some((goal) => String(goal.id) === effectiveGoalId)) {
    throw new Error(`Goal was not found or is closed: ${effectiveGoalId}`);
  }
  const knownIds = new Set(providerTasks.map(taskId));
  const hydrated = [];
  const explicitDependencyIds = uniqueStrings(incoming?.depends_on_task_ids || incoming?.dependsOnTaskIds || []);
  const missingExplicitIds = explicitDependencyIds.filter((id) => !knownIds.has(id));
  if (missingExplicitIds.length && typeof providerGetTask !== "function") {
    throw new Error("providerGetTask is required to validate explicit Task dependencies");
  }
  for (const id of missingExplicitIds) {
    const task = await providerGetTask(id);
    if (!taskId(task)) throw new Error(`Explicit prerequisite Task was not found: ${id}`);
    hydrated.push(task);
    knownIds.add(taskId(task));
  }
  const missingProfileIds = uniqueStrings((profiles || []).map((item) => item.google_task_id))
    .filter((id) => !knownIds.has(id));
  if (missingProfileIds.length && typeof providerGetTask === "function") {
    const results = await Promise.allSettled(missingProfileIds.map((id) => providerGetTask(id)));
    for (const result of results) {
      if (result.status === "fulfilled" && taskId(result.value)) hydrated.push(result.value);
    }
  }
  return {
    ...buildTaskResolutionContext([...providerTasks, ...hydrated], profiles || [], goals || [], options),
    project_goal_id: projectGoalId,
  };
}

/**
 * PostgREST-backed metadata adapter. Provider Task reads/writes stay injectable so
 * Google Tasks remains the canonical content and completion store.
 */
export function createTaskResolutionAdapter(options = {}) {
  const ownerId = clean(options.ownerId, 100);
  const taskListId = clean(options.taskListId, 1_024) || null;
  const serviceRest = options.serviceRest;
  const provider = options.provider || {};
  if (!ownerId) throw new Error("ownerId is required");
  if (typeof serviceRest !== "function") throw new Error("serviceRest is required");
  for (const method of ["getTask", "createTask", "updateTask"]) {
    if (typeof provider[method] !== "function") throw new Error(`provider.${method} is required`);
  }

  const patchOuterAudit = async (changes) => {
    if (!options.intakeAuditId) return;
    const query = new URLSearchParams({ id: `eq.${options.intakeAuditId}`, owner_id: `eq.${ownerId}` });
    await serviceRest(`personal_os_intake_audit?${query}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(changes),
    });
  };

  const upsertContextLink = async (googleTaskId, goalPlanId = null, projectId = null) => {
    const existingQuery = new URLSearchParams({
      owner_id: `eq.${ownerId}`,
      google_task_id: `eq.${googleTaskId}`,
      select: "goal_plan_id,project_id",
      limit: "1",
    });
    const current = (await serviceRest(`task_context_links?${existingQuery}`))?.[0] || {};
    const requestedProjectId = projectId || options.projectId || null;
    const requestedGoalId = goalPlanId || options.projectGoalId || null;
    const resolvedGoalId = requestedProjectId
      ? requestedGoalId
      : requestedGoalId || current.goal_plan_id || null;
    const resolvedProjectId = requestedProjectId
      || (current.goal_plan_id === resolvedGoalId ? current.project_id : null)
      || null;
    if (!resolvedGoalId && !resolvedProjectId) return null;
    const rows = await serviceRest("task_context_links?on_conflict=owner_id%2Cgoogle_task_id&select=*", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        owner_id: ownerId,
        google_task_id: googleTaskId,
        goal_plan_id: resolvedGoalId,
        project_id: resolvedProjectId,
      }),
    });
    return rows?.[0] || null;
  };

  return {
    getTask: (id) => provider.getTask(id),
    async findExistingResolution() {
      if (!options.resolutionIdempotencyKey) return null;
      const query = new URLSearchParams({ owner_id: `eq.${ownerId}`, idempotency_key: `eq.${options.resolutionIdempotencyKey}`, select: "*", limit: "1" });
      return (await serviceRest(`task_resolution_audit?${query}`))?.[0] || null;
    },
    createTask: (task, metadata) => provider.createTask(task, metadata),
    updateTask: (id, changes, metadata) => provider.updateTask(id, changes, metadata),

    async startResolutionAudit(audit, plan) {
      const rows = await serviceRest("task_resolution_audit?select=*", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(resolutionAuditPayload(ownerId, audit, plan, options)),
      });
      if (!rows?.[0]?.id) throw new Error("Resolution audit insert returned no id");
      return rows[0];
    },

    async completeResolutionAudit(id, changes) {
      const query = new URLSearchParams({ id: `eq.${id}`, owner_id: `eq.${ownerId}` });
      const rows = await serviceRest(`task_resolution_audit?${query}&select=*`, {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(changes),
      });
      await patchOuterAudit({
        resolution_audit_id: id,
        resolution_decision: rows?.[0]?.decision || null,
        resolution_confidence: rows?.[0]?.confidence ?? null,
        resolution_reason: rows?.[0]?.reason || null,
      });
      return rows?.[0] || null;
    },

    async failResolutionAudit(id, changes) {
      const query = new URLSearchParams({ id: `eq.${id}`, owner_id: `eq.${ownerId}` });
      await serviceRest(`task_resolution_audit?${query}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(changes),
      });
      await patchOuterAudit({ resolution_audit_id: id });
    },

    async upsertTaskProfile(profile, metadata = {}) {
      const profileQuery = new URLSearchParams({
        owner_id: `eq.${ownerId}`,
        google_task_id: `eq.${profile.google_task_id}`,
        select: "canonical_task_id,entities,topics,resources,read_resources,write_resources,resource_fields,source_intent_ids,goal_plan_id,project_id,created_from",
        limit: "1",
      });
      const current = (await serviceRest(`task_resolution_profiles?${profileQuery}`))?.[0] || {};
      const sourceIntentIds = uniqueStrings([
        ...(current.source_intent_ids || []),
        ...(profile.source_intent_ids || []),
        metadata.resolution_audit_id,
      ]);
      const requestedProjectId = profile.project_id || options.projectId || null;
      const requestedGoalId = profile.goal_plan_id || (requestedProjectId ? options.projectGoalId || null : null);
      const resolvedGoalId = requestedProjectId
        ? requestedGoalId
        : requestedGoalId || current.goal_plan_id || null;
      const goalChanged = Boolean(requestedGoalId && requestedGoalId !== current.goal_plan_id);
      const mergedProfile = {
        ...profile,
        canonical_task_id: profile.canonical_task_id || current.canonical_task_id || profile.google_task_id,
        entities: uniqueStrings([...(current.entities || []), ...(profile.entities || [])]),
        topics: uniqueStrings([...(current.topics || []), ...(profile.topics || [])]),
        resources: uniqueStrings([...(current.resources || []), ...(profile.resources || [])]),
        read_resources: uniqueStrings([...(current.read_resources || []), ...(profile.read_resources || [])]),
        write_resources: uniqueStrings([...(current.write_resources || []), ...(profile.write_resources || [])]),
        resource_fields: uniqueStrings([...(current.resource_fields || []), ...(profile.resource_fields || [])]),
        goal_plan_id: resolvedGoalId,
        project_id: requestedProjectId || (goalChanged ? null : current.project_id) || null,
      };
      const rows = await serviceRest("task_resolution_profiles?on_conflict=owner_id%2Cgoogle_task_id&select=*", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          owner_id: ownerId,
          task_list_id: taskListId,
          created_from: current.created_from || options.createdFrom || "personal_os_intake",
          ...mergedProfile,
          source_intent_ids: sourceIntentIds,
        }),
      });
      const scheduleQuery = new URLSearchParams({ owner_id: `eq.${ownerId}`, google_task_id: `eq.${profile.google_task_id}` });
      await serviceRest(`task_schedule_metadata?${scheduleQuery}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          canonical_task_id: profile.canonical_task_id || profile.google_task_id,
          resolution_confidence: profile.resolution_confidence ?? null,
          resolution_reason: profile.resolution_reason || null,
          created_from: current.created_from || options.createdFrom || "personal_os_intake",
          last_semantic_resolution_at: profile.last_semantic_resolution_at,
        }),
      });
      return rows?.[0] || null;
    },

    async upsertRelationships(relationships, metadata = {}) {
      const query = new URLSearchParams({
        owner_id: `eq.${ownerId}`,
        active: "eq.true",
        superseded_at: "is.null",
        select: "*",
        limit: "1000",
      });
      const existing = await serviceRest(`task_relationships?${query}`) || [];
      const accepted = [];
      for (const relationship of relationships.map(canonicalRelationship)) {
        const validated = validateTaskRelationship(relationship, [...existing, ...accepted]);
        accepted.push({
          owner_id: ownerId,
          ...validated,
          source_intent_id: validated.source_intent_id || metadata.resolution_audit_id || null,
          active: true,
          superseded_at: null,
        });
      }
      if (!accepted.length) return [];
      return serviceRest("task_relationships?on_conflict=owner_id%2Cfrom_task_id%2Cto_task_id%2Crelationship_type&select=*", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(accepted),
      });
    },

    async upsertResourceBindings(bindings, metadata = {}) {
      if (!bindings.length) return [];
      const taskIds = uniqueStrings(bindings.map((binding) => binding.google_task_id));
      const existing = [];
      for (const googleTaskId of taskIds) {
        const query = new URLSearchParams({
          owner_id: `eq.${ownerId}`,
          google_task_id: `eq.${googleTaskId}`,
          select: "google_task_id,resource_key,access_type,fields",
        });
        existing.push(...((await serviceRest(`task_resource_bindings?${query}`)) || []));
      }
      const byKey = new Map(existing.map((binding) => [
        `${binding.google_task_id}:${binding.resource_key}`,
        binding,
      ]));
      return serviceRest("task_resource_bindings?on_conflict=owner_id%2Cgoogle_task_id%2Cresource_key&select=*", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(bindings.map((binding) => {
          const current = byKey.get(`${binding.google_task_id}:${binding.resource_key}`) || {};
          return {
            owner_id: ownerId,
            ...binding,
            access_type: mergedResourceAccess(current.access_type, binding.access_type),
            fields: uniqueStrings([...(current.fields || []), ...(binding.fields || [])]),
            source_intent_id: binding.source_intent_id || metadata.resolution_audit_id || null,
          };
        })),
      });
    },

    linkContext: upsertContextLink,
    linkGoal: (googleTaskId, goalPlanId) => upsertContextLink(googleTaskId, goalPlanId, options.projectId || null),
  };
}

export async function resolveAndExecuteTask(incoming, context, adapter) {
  const previous = typeof adapter.findExistingResolution === "function" ? await adapter.findExistingResolution() : null;
  if (previous) {
    const ids = previous.result_task_ids || [];
    if (previous.status !== "succeeded" || !ids.length) {
      const error = new Error("Previous write requires reconciliation; do not create another task");
      error.code = "RESOLUTION_RECOVERY_REQUIRED";
      error.task_ids = ids;
      throw error;
    }
    const tasks = await Promise.all(ids.map((id) => adapter.getTask(id)));
    if (tasks.some((task, index) => taskId(task) !== ids[index])) throw new Error("Previous resolution task cannot be verified");
    return {
      success: true, task: tasks[0], tasks, created: false, updated: false, reused: true, replayed: true,
      resolution: { decision: "DUPLICATE", original_decision: previous.decision, audit_id: previous.id, confidence: previous.confidence, reason: "Verified replay of the existing resolution result" },
      relationships: [], goal_link: null, context_link: null,
    };
  }
  const resolution = resolveTaskIntent(incoming, context);
  return executeTaskResolution(incoming, resolution, adapter);
}

export function taskResolutionPreview(incoming, context) {
  const resolution = resolveTaskIntent(incoming, context);
  return {
    ...resolution,
    normalized_intent: extractIntentProfile(incoming),
    preview: true,
    persisted: false,
  };
}
