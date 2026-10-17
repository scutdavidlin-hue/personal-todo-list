import { prepareAutonomousIntake } from "./autonomy-runtime.js";
import { normalizeIntake, taskDispatchPayload } from "./personal-os-intake.js";
import { frozenIntake } from "./request-recovery.js";

export class ProposalError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export const proposalUUID = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const proposalDigest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function canonicalJSON(value) {
  const stable = item => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])])) : item;
  return JSON.stringify(stable(value));
}
export async function scopeHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(typeof value === "string" ? value : canonicalJSON(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
const dispatchFields = ["task_type", "parent_task_id", "follow_up_of", "follow_up_sequence", "title", "notes", "dueDate", "originalIntent", "source",
  "goal_plan_id", "project_id", "resources", "read_resources", "write_resources", "resource_fields", "depends_on_task_ids", "schedule", "recurrence"];
export const dispatchExecutionScope = payload => ({ contract: "single-task-create-v2", operation: "create",
  resolution_policy: "single_independent_create",
  payload: Object.fromEntries(dispatchFields.filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]])) });
export function taskExecutionScope(intake, policy) {
  if (intake.type !== "task" || intake.existing_task_id || intake.update_patch || policy?.preference_text || policy?.intent === "mixed") {
    throw new ProposalError("PROPOSAL_NEW_TASK_ONLY");
  }
  return dispatchExecutionScope(taskDispatchPayload(intake));
}
const allowedInput = new Set(["raw_text", "title", "notes", "type", "due", "requested_date", "requested_time", "timezone",
  "reminder_policy", "reminder_policy_source", "reminder_at", "reminder_offset_minutes", "reminder_type", "reminders", "fixed_time", "estimated_duration"]);
export async function prepareNewTaskProposal(raw, { resolveContext, receivedAt = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !allowedInput.has(key))) throw new ProposalError("PROPOSAL_INPUT_INVALID", 400);
  if (raw.type && raw.type !== "task") throw new ProposalError("PROPOSAL_NEW_TASK_ONLY");
  const input = { ...raw, type: "task", source: "chatgpt" };
  const policy = await prepareAutonomousIntake(input, { resolveContext: resolveContext || (async () => ({})) }, { baseDate: receivedAt });
  if (policy.decision !== "execute" || policy.risk_level !== "L1") throw new ProposalError(policy.intent === "information" ? "INFORMATION_ONLY" : "PROPOSAL_REVIEW_REQUIRED");
  const intake = { ...normalizeIntake(frozenIntake(policy.input, receivedAt), { baseDate: receivedAt }),
    existing_task_id: policy.input.existing_task_id, update_patch: policy.input.update_patch };
  // Freeze relative execution dates before the human sees/approves the preview.
  const intakeInput = { ...raw, type: "task", due: intake.due, requested_date: intake.requested_date, requested_time: intake.requested_time };
  // Prepare exactly the absolute input the existing intake will receive. The
  // human approves this resolved date/scope, including its schedule provenance.
  const frozenPolicy = await prepareAutonomousIntake({ ...intakeInput, source: "chatgpt" },
    { resolveContext: resolveContext || (async () => ({})) }, { baseDate: receivedAt });
  if (frozenPolicy.decision !== "execute" || frozenPolicy.risk_level !== "L1") throw new ProposalError("PROPOSAL_REVIEW_REQUIRED");
  const frozen = { ...normalizeIntake(frozenIntake(frozenPolicy.input, receivedAt), { baseDate: receivedAt }),
    existing_task_id: frozenPolicy.input.existing_task_id, update_patch: frozenPolicy.input.update_patch };
  const scope = taskExecutionScope(frozen, frozenPolicy);
  return { scope, executionJSON: canonicalJSON(scope), digest: await scopeHash(scope), intakeInput, receivedAt };
}

// Client-supplied constraints only restrict a write; they NEVER authorize one.
// This runs after ordinary intent/risk checks and the canonical account read.
function guardIdentityError(guard, identity, ownerId) {
  if (guard === undefined) return null;
  if (!guard || typeof guard !== "object" || Array.isArray(guard)
    || Object.keys(guard).sort().join(",") !== "account_subject,owner_id,proposal_id,scope_digest,version"
    || !proposalUUID(guard.proposal_id) || !proposalUUID(guard.owner_id) || !proposalDigest(guard.scope_digest)
    || !Number.isSafeInteger(guard.version) || guard.version < 1 || typeof guard.account_subject !== "string") return "PROPOSAL_GUARD_INVALID";
  if (guard.owner_id !== ownerId || guard.account_subject !== identity?.account_subject) return "PROPOSAL_ACCOUNT_CHANGED";
  return null;
}
export async function proposalGuardError(guard, intake, identity, ownerId, policy) {
  const error = guardIdentityError(guard, identity, ownerId);
  if (error || guard === undefined) return error;
  try { return await scopeHash(taskExecutionScope(intake, policy)) === guard.scope_digest ? null : "PROPOSAL_SCOPE_CHANGED"; }
  catch { return "PROPOSAL_SCOPE_CHANGED"; }
}

// Check the actual request and token's canonical Google subject inside the
// writer. The access token checked here is the one its provider adapter uses.
export async function proposalWriterGuardError(input, identity, ownerId) {
  if (!Object.hasOwn(input, "proposal_guard")) return null;
  const error = guardIdentityError(input.proposal_guard, identity, ownerId);
  if (error || input.proposal_guard === undefined) return error || "PROPOSAL_GUARD_INVALID";
  if (Object.keys(input).some(key => ![...dispatchFields, "proposal_guard", "intake_audit_id", "resolution_idempotency_key"].includes(key))) return "PROPOSAL_SCOPE_CHANGED";
  return await scopeHash(dispatchExecutionScope(input)) === input.proposal_guard.scope_digest ? null : "PROPOSAL_SCOPE_CHANGED";
}

// The new-task preview approves ONE independent create. Resolver decisions
// involving existing targets or inferred relationships need a new preview.
export function assertProposalMutationPlan(incoming, plan) {
  if (!Object.hasOwn(incoming, "proposal_guard")) return;
  const operation = plan.operations[0];
  if (plan.decision !== "NEW" || plan.operations.length !== 1 || operation?.type !== "create"
    || operation.parent_temp_id || operation.task.parent_task_id || operation.task.follow_up_of
    || plan.relationships.length || plan.goal_link || operation.task.goal_plan_id || operation.task.project_id
    || operation.task.goal_id || operation.task.projectId || operation.task.depends_on_task_ids?.length) throw new ProposalError("PROPOSAL_SCOPE_CHANGED");
}
