const COMPLETE_STATUSES = new Set(["completed", "done"]);
const INACTIVE_STATUSES = new Set(["deleted", "cancelled", "archived"]);

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function idOf(task) {
  return clean(task?.task_id || task?.google_task_id || task?.id || task?.externalId);
}

function statusOf(task) {
  return clean(task?.status).toLowerCase() || (task?.done ? "completed" : "open");
}

function relationType(item) {
  return clean(item?.relationship_type || item?.type).toUpperCase();
}

function fromId(item) {
  return clean(item?.from_task_id || item?.source_task_id || item?.from);
}

function toId(item) {
  return clean(item?.to_task_id || item?.target_task_id || item?.to);
}

function activeRelation(item) {
  return item?.active !== false && item?.superseded_at == null;
}

function sorted(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true }));
}

function dependencyPairs(relationships) {
  return relationships
    .filter((item) => activeRelation(item) && relationType(item) === "DEPENDS_ON")
    .map((item) => ({ dependent: fromId(item), prerequisite: toId(item), relationship: item }))
    .filter((item) => item.dependent && item.prerequisite && item.dependent !== item.prerequisite);
}

function parentPairs(relationships) {
  return relationships
    .filter((item) => activeRelation(item) && relationType(item) === "PARENT_OF")
    .map((item) => ({ parent: fromId(item), child: toId(item), relationship: item }))
    .filter((item) => item.parent && item.child && item.parent !== item.child);
}

function conflictPairs(relationships) {
  return relationships
    .filter((item) => activeRelation(item) && relationType(item) === "CONFLICTS_WITH")
    .map((item) => ({ left: fromId(item), right: toId(item), relationship: item }))
    .filter((item) => item.left && item.right && item.left !== item.right);
}

function uniqueRelations(relationships = []) {
  const seen = new Set();
  const result = [];
  for (const item of relationships) {
    const type = relationType(item);
    const from = fromId(item);
    const to = toId(item);
    if (!type || !from || !to || from === to) continue;
    const symmetric = ["RELATED_TO", "POTENTIAL_RELATION", "CONFLICTS_WITH", "SHARES_RESOURCE"].includes(type);
    const endpoints = symmetric ? sorted([from, to]) : [from, to];
    const key = `${type}:${endpoints[0]}:${endpoints[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...item, relationship_type: type, from_task_id: from, to_task_id: to });
  }
  return result;
}

function pathExists(start, target, adjacency, visited = new Set()) {
  if (start === target) return true;
  if (visited.has(start)) return false;
  visited.add(start);
  for (const next of adjacency.get(start) || []) if (pathExists(next, target, adjacency, visited)) return true;
  return false;
}

export function relationshipWouldCreateCycle(relationships, dependentTaskId, prerequisiteTaskId) {
  const dependent = clean(dependentTaskId);
  const prerequisite = clean(prerequisiteTaskId);
  if (!dependent || !prerequisite || dependent === prerequisite) return true;
  const adjacency = new Map();
  for (const pair of dependencyPairs(uniqueRelations(relationships))) {
    if (!adjacency.has(pair.dependent)) adjacency.set(pair.dependent, new Set());
    adjacency.get(pair.dependent).add(pair.prerequisite);
  }
  return pathExists(prerequisite, dependent, adjacency);
}

export function validateTaskRelationship(relationship, existing = []) {
  const type = relationType(relationship);
  const from = fromId(relationship);
  const to = toId(relationship);
  if (!type || !from || !to) throw new Error("relationship_type, from_task_id, and to_task_id are required");
  if (from === to) throw new Error("A task cannot relate to itself");
  if (type === "DEPENDS_ON" && relationshipWouldCreateCycle(existing, from, to)) {
    throw new Error("Dependency would create a cycle");
  }
  return { ...relationship, relationship_type: type, from_task_id: from, to_task_id: to };
}

function transitiveDependencyMap(taskIds, dependencies) {
  const direct = new Map(taskIds.map((id) => [id, new Set()]));
  for (const pair of dependencies) {
    if (!direct.has(pair.dependent)) direct.set(pair.dependent, new Set());
    direct.get(pair.dependent).add(pair.prerequisite);
  }
  const closure = new Map();
  const walk = (id, visited = new Set()) => {
    if (visited.has(id)) return visited;
    visited.add(id);
    for (const prerequisite of direct.get(id) || []) walk(prerequisite, visited);
    return visited;
  };
  for (const id of taskIds) {
    const values = walk(id, new Set());
    values.delete(id);
    closure.set(id, values);
  }
  return closure;
}

function shareConflict(left, right, conflicts) {
  return conflicts.some((pair) => (pair.left === left && pair.right === right) || (pair.left === right && pair.right === left));
}

function writeResources(task) {
  return new Set(task?.write_resources || task?.writes || task?.semantic_profile?.write_resources || []);
}

function hasSharedWrite(left, right) {
  const a = writeResources(left);
  const b = writeResources(right);
  for (const value of a) if (b.has(value)) return true;
  return false;
}

export function canTasksRunInParallel(leftTask, rightTask, relationships = []) {
  const left = idOf(leftTask);
  const right = idOf(rightTask);
  if (!left || !right || left === right) return false;
  const unique = uniqueRelations(relationships);
  const dependencies = dependencyPairs(unique);
  const closure = transitiveDependencyMap([left, right, ...dependencies.flatMap((pair) => [pair.dependent, pair.prerequisite])], dependencies);
  if (closure.get(left)?.has(right) || closure.get(right)?.has(left)) return false;
  if (shareConflict(left, right, conflictPairs(unique))) return false;
  return !hasSharedWrite(leftTask, rightTask);
}

function topologicalLayers(taskIds, dependencies) {
  const ids = new Set(taskIds);
  const outgoing = new Map(taskIds.map((id) => [id, new Set()]));
  const indegree = new Map(taskIds.map((id) => [id, 0]));
  for (const { dependent, prerequisite } of dependencies) {
    if (!ids.has(dependent) || !ids.has(prerequisite)) continue;
    if (!outgoing.get(prerequisite).has(dependent)) {
      outgoing.get(prerequisite).add(dependent);
      indegree.set(dependent, (indegree.get(dependent) || 0) + 1);
    }
  }
  const layers = [];
  let frontier = sorted([...ids].filter((id) => indegree.get(id) === 0));
  const consumed = new Set();
  while (frontier.length) {
    layers.push(frontier);
    const next = new Set();
    for (const id of frontier) {
      consumed.add(id);
      for (const dependent of outgoing.get(id) || []) {
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) next.add(dependent);
      }
    }
    frontier = sorted(next);
  }
  return { layers, cyclic: sorted([...ids].filter((id) => !consumed.has(id))) };
}

function partitionParallel(taskIds, nodeById, relationships) {
  const groups = [];
  for (const id of taskIds) {
    const task = nodeById.get(id)?.task;
    let placed = false;
    for (const group of groups) {
      if (group.every((otherId) => canTasksRunInParallel(task, nodeById.get(otherId)?.task, relationships))) {
        group.push(id);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([id]);
  }
  return groups;
}

export function buildTaskExecutionGraph(tasks = [], relationships = []) {
  const unique = uniqueRelations(relationships);
  const nodeById = new Map();
  for (const task of tasks) {
    const id = idOf(task);
    if (!id || INACTIVE_STATUSES.has(statusOf(task))) continue;
    nodeById.set(id, {
      id,
      title: clean(task.title),
      status: statusOf(task),
      execution_status: "READY",
      blocked_by: [],
      depends_on: [],
      parent_task_id: null,
      child_task_ids: [],
      related_task_ids: [],
      conflict_task_ids: [],
      shared_resources: [],
      goal_plan_id: clean(task.goal_plan_id || task.goal_id) || null,
      project_id: clean(task.project_id) || null,
      canonical_task_id: clean(task.canonical_task_id) || id,
      task,
    });
  }

  const dependencies = dependencyPairs(unique);
  const parents = parentPairs(unique);
  const conflicts = conflictPairs(unique);
  for (const pair of dependencies) {
    const dependent = nodeById.get(pair.dependent);
    if (!dependent) continue;
    dependent.depends_on.push(pair.prerequisite);
    const prerequisite = nodeById.get(pair.prerequisite);
    if (!prerequisite || !COMPLETE_STATUSES.has(prerequisite.status)) dependent.blocked_by.push(pair.prerequisite);
  }
  for (const pair of parents) {
    const parent = nodeById.get(pair.parent);
    const child = nodeById.get(pair.child);
    if (parent) parent.child_task_ids.push(pair.child);
    if (child) child.parent_task_id = pair.parent;
  }
  for (const pair of conflicts) {
    const left = nodeById.get(pair.left);
    const right = nodeById.get(pair.right);
    if (left) left.conflict_task_ids.push(pair.right);
    if (right) right.conflict_task_ids.push(pair.left);
  }
  for (const item of unique) {
    const type = relationType(item);
    const from = nodeById.get(fromId(item));
    const to = nodeById.get(toId(item));
    if (["RELATED_TO", "POTENTIAL_RELATION"].includes(type)) {
      if (from) from.related_task_ids.push(toId(item));
      if (to) to.related_task_ids.push(fromId(item));
    }
    if (type === "SHARES_RESOURCE") {
      const resource = clean(item?.metadata?.resource || item?.resource_key);
      if (resource && from) from.shared_resources.push(resource);
      if (resource && to) to.shared_resources.push(resource);
    }
  }

  for (const node of nodeById.values()) {
    node.blocked_by = sorted(new Set(node.blocked_by));
    node.depends_on = sorted(new Set(node.depends_on));
    node.child_task_ids = sorted(new Set(node.child_task_ids));
    node.related_task_ids = sorted(new Set(node.related_task_ids));
    node.conflict_task_ids = sorted(new Set(node.conflict_task_ids));
    node.shared_resources = sorted(new Set(node.shared_resources));
    if (COMPLETE_STATUSES.has(node.status)) node.execution_status = "COMPLETED";
    else if (node.blocked_by.length) node.execution_status = "BLOCKED";
    else if (node.conflict_task_ids.some((id) => {
      const other = nodeById.get(id);
      return other && !COMPLETE_STATUSES.has(other.status);
    })) node.execution_status = "CONFLICT";
    else if (node.status === "waiting") node.execution_status = "WAITING";
    else node.execution_status = "READY";
  }

  const openIds = [...nodeById.values()]
    .filter((node) => !COMPLETE_STATUSES.has(node.status))
    .map((node) => node.id);
  const topology = topologicalLayers(openIds, dependencies);
  const executionLayers = topology.layers.map((ids, index) => ({
    index,
    task_ids: ids,
    parallel_groups: partitionParallel(ids, nodeById, unique),
  }));
  const nodes = [...nodeById.values()].map(({ task: _task, ...node }) => node)
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    nodes,
    relationships: unique,
    execution_layers: executionLayers,
    ready_task_ids: nodes.filter((node) => node.execution_status === "READY").map((node) => node.id),
    blocked_task_ids: nodes.filter((node) => node.execution_status === "BLOCKED").map((node) => node.id),
    waiting_task_ids: nodes.filter((node) => node.execution_status === "WAITING").map((node) => node.id),
    conflict_task_ids: nodes.filter((node) => node.execution_status === "CONFLICT").map((node) => node.id),
    completed_task_ids: nodes.filter((node) => node.execution_status === "COMPLETED").map((node) => node.id),
    cyclic_task_ids: topology.cyclic,
    valid_dag: topology.cyclic.length === 0,
  };
}
