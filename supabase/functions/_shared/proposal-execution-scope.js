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
export function taskExecutionScope(intake, policy) {
  if (intake.type !== "task" || intake.existing_task_id || intake.update_patch || policy?.preference_text || policy?.intent === "mixed") {
    throw new ProposalError("PROPOSAL_NEW_TASK_ONLY");
  }
  return { contract: "new-task-v1", operation: "create", payload: taskDispatchPayload(intake) };
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
export async function proposalGuardError(guard, intake, identity, ownerId, policy) {
  if (guard === undefined) return null;
  if (!guard || typeof guard !== "object" || Array.isArray(guard)
    || Object.keys(guard).sort().join(",") !== "account_subject,owner_id,proposal_id,scope_digest,version"
    || !proposalUUID(guard.proposal_id) || !proposalUUID(guard.owner_id) || !proposalDigest(guard.scope_digest)
    || !Number.isSafeInteger(guard.version) || guard.version < 1 || typeof guard.account_subject !== "string") return "PROPOSAL_GUARD_INVALID";
  if (guard.owner_id !== ownerId || guard.account_subject !== identity?.account_subject) return "PROPOSAL_ACCOUNT_CHANGED";
  try { return await scopeHash(taskExecutionScope(intake, policy)) === guard.scope_digest ? null : "PROPOSAL_SCOPE_CHANGED"; }
  catch { return "PROPOSAL_SCOPE_CHANGED"; }
}
