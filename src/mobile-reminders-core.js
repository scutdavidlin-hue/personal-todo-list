// Derived device projection only. Never writes Google Tasks, Schedule or Calendar.
export const LIVE_ACTIVITY_LEAD_SECONDS = 3600;
export const MAX_DEVICE_PLANS = 20;

function partsAt(epochMs, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// Resolve wall clocks independently of the browser's timezone. Reject DST gaps
// and folds: a guessed instant would be worse than requiring clarification.
export function wallClockEpoch(value, timezone) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    throw new Error("提醒时刻格式无效");
  }
  const local = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?/)[0];
  const wall = local.length === 16 ? `${local}:00` : local;
  if (new Date(`${wall}Z`).toISOString().slice(0, 19) !== wall) throw new Error("提醒日期无效");
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) throw new Error("提醒时区偏移无效");
    return instant / 1000;
  }
  const wallMs = Date.parse(`${wall}Z`);
  // Sample zone offsets on both sides of a possible DST transition.
  const offsets = new Set([-48, -24, 0, 24, 48].map(hours => {
    const sample = wallMs + hours * 3600_000;
    return Date.parse(`${partsAt(sample, timezone)}Z`) - sample;
  }));
  const candidates = [...offsets].map(offset => wallMs - offset)
    .filter(instant => partsAt(instant, timezone) === wall);
  if (candidates.length !== 1) throw new Error("该时区的时刻不存在或有歧义，请核实时刻");
  return candidates[0] / 1000;
}

export function devicePlan(task, schedule, now = Date.now() / 1000) {
  if (!task?.id || !task.title?.trim()) throw new Error("任务身份或标题缺失");
  if (schedule && schedule.google_task_id !== task.id) throw new Error("Schedule 与任务身份不一致");
  const base = { taskId: task.id, title: task.title.trim(), timezone: schedule?.timezone || "Asia/Shanghai" };
  const disabled = task.done === true || ["completed", "done", "cancelled"].includes(task.status)
    || !schedule || schedule.scheduling_status === "cancelled" || schedule.notification_status === "disabled"
    || schedule.reminder_policy === "none";
  if (disabled) return { ...base, enabled: false, eventAt: null, liveActivityStartAt: null, reminderAt: [] };
  if (!schedule.scheduled_date || !schedule.scheduled_start) throw new Error("任务缺少执行日期或时刻");
  const taskDate = task.date || task.dueDate;
  if (taskDate && taskDate !== schedule.scheduled_date) throw new Error("Task 日期与 Schedule 不一致，请先同步核实");
  const eventAt = wallClockEpoch(`${schedule.scheduled_date}T${schedule.scheduled_start}`, base.timezone);
  if (eventAt <= now) throw new Error("执行时刻已过去，请读取最新任务");
  const configured = Array.isArray(schedule.reminders) && schedule.reminders.length
    ? schedule.reminders.map(item => item.at) : schedule.reminder_at ? [schedule.reminder_at] : [];
  if (!configured.length) throw new Error("Schedule 尚未配置明确的提醒时刻");
  const reminderAt = [...new Set(configured.map(at => wallClockEpoch(at, base.timezone)))].sort((a, b) => a - b);
  if (reminderAt.length > 3 || reminderAt.some(at => at > eventAt)) throw new Error("提醒配置超出设备支持范围");
  return { ...base, enabled: true, eventAt, liveActivityStartAt: eventAt - LIVE_ACTIVITY_LEAD_SECONDS, reminderAt };
}

export function makeDeviceSnapshot(tasks, schedules, now = Date.now() / 1000) {
  if (!tasks.length || tasks.length > MAX_DEVICE_PLANS) throw new Error("请选择 1–20 条任务");
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error("任务 ID 重复");
  const plans = tasks.map(task => {
    const matches = schedules.filter(row => row.google_task_id === task.id);
    if (matches.length > 1) throw new Error("任务存在重复 Schedule，请先核实");
    return devicePlan(task, matches[0], now);
  });
  return { version: 1, source: "personal-os", generatedAt: Math.floor(now), plans };
}

export function countdownPhase(plan, now = Date.now() / 1000) {
  if (!plan.enabled) return "disabled";
  if (now < plan.liveActivityStartAt) return "waiting";
  if (now >= plan.eventAt) return "elapsed";
  return "active";
}

export function formatDeviceTime(epoch, timezone = "Asia/Shanghai") {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(epoch * 1000));
}
