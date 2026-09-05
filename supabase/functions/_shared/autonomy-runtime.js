import { evaluateAutonomy, confirmationForWrite } from "./autonomy-policy.js";

export async function prepareAutonomousIntake(input, adapter, options = {}) {
  const initial = evaluateAutonomy(input, options);
  if (initial.intent === "information" || initial.risk_level === "L3") return initial;
  const context = await adapter.resolveContext(input);
  return evaluateAutonomy({ ...input, context }, options);
}

export async function verifyTaskWrite(result, readTask) {
  const id = result?.task?.id;
  if (!id) throw new Error("Google Tasks write did not return an id");
  const readback = await readTask(id);
  const task = readback?.task;
  if (!task || task.id !== id || task.title !== result.task.title
    || (task.notes || "") !== (result.task.notes || "")
    || (task.dueDate || null) !== (result.task.dueDate || null)) {
    throw new Error("Google Tasks readback did not match the write");
  }
  for (const [key, expected] of Object.entries(result.expected_schedule || {})) {
    const actual = readback.schedule?.[key];
    const normalized = key === "scheduled_start" && typeof actual === "string" ? actual.slice(0, 5) : actual;
    if ((normalized ?? null) !== (expected ?? null)) throw new Error("Task schedule readback did not match the requested update");
  }
  return { task, verified: true, write_success: result.write_success === true };
}

export function intakeConfirmation(result) {
  if (result?.decision === "ask") return result.question;
  if (result?.intent === "information") return "这是信息查询，未创建任务。";
  if (result?.partial === true) return "部分写入完成，请按返回的对象 ID 继续处理未完成部分。";
  if (result?.code === "WRITE_UNVERIFIED" || (result?.write_success === true && result?.verified !== true)) return "写入结果尚未核实，请回读原任务，勿重复创建。";
  if (result?.operation === "reused" && result?.verified === true) return "现有任务已核对，无需重复创建。";
  return confirmationForWrite(result);
}
