import { normalizeScheduleInput } from "./schedule-core.js";

/** Translate a confirmed conversation proposal to the existing create contract. */
export function taskConversationCreatePayload(changes, idempotencyKey) {
  const scheduledDate = changes.requested_date ?? changes.schedule?.scheduled_date ?? changes.dueDate ?? changes.due ?? changes.date ?? null;
  const scheduledStart = changes.requested_time ?? changes.schedule?.scheduled_start ?? null;
  const schedule = normalizeScheduleInput({
    ...changes,
    ...(changes.schedule || {}),
    scheduled_date: scheduledDate,
    scheduled_start: scheduledStart,
    task_type: changes.task_type || "task",
    parent_task_id: changes.parent_task_id || null,
    follow_up_of: changes.follow_up_of || null,
    follow_up_sequence: changes.follow_up_sequence ?? (changes.task_type === "follow_up" ? 2 : 1),
    scheduling_source: changes.scheduling_source || (scheduledDate || scheduledStart ? "explicit_user" : "gpt_inferred"),
  });
  return {
    ...changes,
    // Google Tasks only accepts a date; exact time and links belong to Schedule.
    dueDate: scheduledDate,
    // Keep an undated Schedule too, so next-action parent linkage is durable.
    schedule,
    idempotency_key: idempotencyKey,
  };
}
