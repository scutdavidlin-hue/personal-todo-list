import {
  INCOMING_TASK_REF,
  buildResolutionMutationPlan,
  replaceIncomingTaskRefs,
  resolutionProfileRecord,
} from "./task-resolution-engine.js";

function requireMethod(adapter, name) {
  if (typeof adapter?.[name] !== "function") throw new Error(`Resolution adapter must implement ${name}()`);
  return adapter[name].bind(adapter);
}

function taskId(task) {
  return String(task?.task_id || task?.google_task_id || task?.id || "").trim();
}

function resultTask(value) {
  return value?.task && typeof value.task === "object" ? value.task : value;
}

function resourceBindings(task, profile, sourceIntentId) {
  return profile.resources.map((resource) => {
    const reads = profile.read_resources.includes(resource);
    const writes = profile.write_resources.includes(resource);
    return {
      google_task_id: taskId(task),
      resource_key: resource,
      access_type: reads && writes ? "read_write" : writes ? "write" : "read",
      fields: profile.resource_fields,
      source_intent_id: sourceIntentId,
    };
  });
}

export async function executeTaskResolution(incoming, resolution, adapter) {
  if (resolution.requires_clarification === true) {
    const error = new Error(resolution.reason || "Multiple tasks match; choose the intended task");
    error.code = "TASK_TARGET_AMBIGUOUS";
    throw error;
  }
  const plan = buildResolutionMutationPlan(incoming, resolution);
  const startAudit = requireMethod(adapter, "startResolutionAudit");
  const completeAudit = requireMethod(adapter, "completeResolutionAudit");
  const failAudit = requireMethod(adapter, "failResolutionAudit");
  const getTask = requireMethod(adapter, "getTask");
  const createTask = requireMethod(adapter, "createTask");
  const updateTask = requireMethod(adapter, "updateTask");
  const upsertProfile = requireMethod(adapter, "upsertTaskProfile");
  const upsertRelationships = requireMethod(adapter, "upsertRelationships");
  const upsertResources = requireMethod(adapter, "upsertResourceBindings");
  const linkContext = typeof adapter.linkContext === "function" ? adapter.linkContext.bind(adapter) : null;
  const linkGoal = typeof adapter.linkGoal === "function" ? adapter.linkGoal.bind(adapter) : null;

  const audit = await startAudit(plan.audit, plan);
  const auditId = String(audit?.id || audit?.audit_id || audit || "").trim();
  if (!auditId) throw new Error("Resolution audit did not return an id");

  const createdByTempId = {};
  const resultingTasks = [];
  let previousState = null;
  try {
    for (const operation of plan.operations) {
      if (operation.type === "reuse") {
        const task = resultTask(await getTask(operation.task_id));
        if (!taskId(task)) throw new Error("Canonical task was not found during duplicate reuse");
        previousState = task;
        resultingTasks.push(task);
        continue;
      }
      if (operation.type === "update") {
        previousState = resultTask(await getTask(operation.task_id));
        const task = resultTask(await updateTask(operation.task_id, operation.changes, {
          decision: plan.decision,
          confidence: plan.confidence,
          resolution_audit_id: auditId,
        }));
        if (!taskId(task)) throw new Error("Task update did not return the canonical task");
        resultingTasks.push(task);
        continue;
      }
      if (operation.type === "create") {
        const parentTaskId = operation.parent_temp_id
          ? taskId(createdByTempId[operation.parent_temp_id])
          : null;
        if (operation.parent_temp_id && !parentTaskId) throw new Error("Parent task must be created before its child");
        const task = resultTask(await createTask(operation.task, {
          parent_task_id: parentTaskId,
          decision: plan.decision,
          confidence: plan.confidence,
          resolution_audit_id: auditId,
        }));
        if (!taskId(task)) throw new Error("Task creation did not return a provider id");
        createdByTempId[operation.temp_id] = task;
        resultingTasks.push(task);
      }
    }

    const primaryTask = createdByTempId[INCOMING_TASK_REF] || resultingTasks[0];
    const primaryTaskId = taskId(primaryTask);
    const childIds = Object.fromEntries(Object.entries(createdByTempId).map(([tempId, task]) => [tempId, taskId(task)]));
    const relationships = replaceIncomingTaskRefs(plan.relationships, primaryTaskId, childIds)
      .filter((item) => item.from_task_id !== item.to_task_id)
      .map((item) => ({ ...item, source_intent_id: auditId }));

    const contextLink = {
      goal_plan_id: plan.goal_link?.goal_id || incoming.goal_plan_id || incoming.goal_id || null,
      project_id: incoming.project_id || incoming.projectId || null,
    };
    if ((contextLink.goal_plan_id || contextLink.project_id) && (linkContext || linkGoal)) {
      for (const task of resultingTasks) {
        if (linkContext) {
          await linkContext(taskId(task), contextLink.goal_plan_id, contextLink.project_id, { resolution_audit_id: auditId });
        } else if (contextLink.goal_plan_id) {
          await linkGoal(taskId(task), contextLink.goal_plan_id, { resolution_audit_id: auditId });
        }
      }
    }

    for (const task of resultingTasks) {
      const profile = resolutionProfileRecord({
        ...task,
        canonical_task_id: resolution.canonical_task_id || task.canonical_task_id || taskId(task),
        goal_plan_id: plan.goal_link?.goal_id || task.goal_plan_id || incoming.goal_plan_id || incoming.goal_id || null,
        project_id: task.project_id || incoming.project_id || null,
        read_resources: task.read_resources || incoming.read_resources || incoming.reads || [],
        write_resources: task.write_resources || incoming.write_resources || incoming.writes || [],
        resource_fields: task.resource_fields || incoming.resource_fields || incoming.fields || [],
      }, resolution);
      profile.source_intent_ids = [auditId];
      await upsertProfile(profile, { resolution_audit_id: auditId });
      await upsertResources(resourceBindings(task, profile, auditId), { resolution_audit_id: auditId });
    }
    if (relationships.length) await upsertRelationships(relationships, { resolution_audit_id: auditId });

    const finalAudit = {
      status: "succeeded",
      previous_state: previousState,
      new_state: resultingTasks,
      result_task_ids: resultingTasks.map(taskId),
      canonical_task_id: resolution.canonical_task_id || primaryTaskId || resolution.existing_task_id || null,
      related_object_ids: {
        ...plan.audit.related_object_ids,
        task_ids: [...new Set([
          ...(plan.audit.related_object_ids.task_ids || []),
          ...resultingTasks.map(taskId),
        ])],
      },
    };
    await completeAudit(auditId, finalAudit);
    return {
      success: true,
      resolution: {
        decision: plan.decision,
        confidence: plan.confidence,
        reason: plan.reason,
        audit_id: auditId,
        non_destructive: true,
      },
      task: primaryTask,
      tasks: resultingTasks,
      relationships,
      goal_link: plan.goal_link,
      context_link: contextLink.goal_plan_id || contextLink.project_id ? contextLink : null,
      created: plan.operations.some((item) => item.type === "create"),
      updated: plan.operations.some((item) => item.type === "update"),
      reused: plan.operations.some((item) => item.type === "reuse"),
    };
  } catch (error) {
    const failure = {
      status: "failed",
      error: error instanceof Error ? error.message : "Task resolution execution failed",
      previous_state: previousState,
      new_state: resultingTasks,
      result_task_ids: resultingTasks.map(taskId),
    };
    try { await failAudit(auditId, failure); } catch { /* Preserve the original failure. */ }
    if (error && typeof error === "object") error.partial_result = failure;
    throw error;
  }
}
