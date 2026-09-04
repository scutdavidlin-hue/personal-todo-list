export function shanghaiDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function validTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function publicTask(task) {
  const { owner_id: _owner, ...safe } = task;
  return safe;
}

export function buildStatus(rows, targetDate, generatedAt = new Date(), schedules = []) {
  const yesterday = shiftDate(targetDate, -1);
  const futureLimit = shiftDate(targetDate, 7);
  const tasks = rows.map(publicTask);
  const scheduleByTask = new Map(schedules.map((schedule) => [schedule.google_task_id, publicTask(schedule)]));
  const withSchedule = (task) => ({ ...task, schedule: scheduleByTask.get(task.id) || null });
  const isOpen = (task) => task.status === "open";
  const isDone = (task) => task.status === "completed" || task.status === "done";
  const dueDate = (task) => task.dueDate || task.date || null;
  const completedAt = (task) => task.completedAt || task.completed_at || null;
  const completedDate = (task) => completedAt(task) ? shanghaiDate(new Date(completedAt(task))) : null;
  const byCompletedDesc = (left, right) => String(completedAt(right) || "").localeCompare(String(completedAt(left) || ""));
  const requiresUser = (task) => /(?:oauth|验证码|登录|付款|支付|最终审批|本人|授权)/i.test(`${task.title || ""} ${task.notes || ""}`);

  const todayOpen = tasks.filter((task) => isOpen(task) && dueDate(task) === targetDate);
  const overdueOpen = tasks.filter((task) => isOpen(task) && dueDate(task) && dueDate(task) < targetDate);
  const priorityOpen = tasks.filter((task) => isOpen(task) && task.priority === "high");
  const personallyRequired = tasks.filter((task) => isOpen(task) && requiresUser(task));
  const todayCompleted = tasks.filter((task) => isDone(task) && completedDate(task) === targetDate);
  const yesterdayCompleted = tasks.filter((task) => isDone(task) && completedDate(task) === yesterday);
  const recentCompleted = tasks.filter(isDone).sort(byCompletedDesc).slice(0, 20);
  const upcoming = tasks.filter((task) => isOpen(task) && dueDate(task) > targetDate && dueDate(task) <= futureLimit);
  const unscheduled = tasks.filter((task) => isOpen(task) && !dueDate(task));
  const scheduledTasks = tasks.map(withSchedule).filter((task) => task.schedule);
  const tomorrowDate = shiftDate(targetDate, 1);
  const thirdDay = shiftDate(targetDate, 3);
  const todayPlan = scheduledTasks.filter((task) => task.schedule.scheduled_date === targetDate && task.schedule.scheduling_status !== "cancelled");
  const tomorrow = scheduledTasks.filter((task) => isOpen(task) && task.schedule.scheduled_date === tomorrowDate && task.schedule.scheduling_status !== "cancelled");
  const nextThreeDays = scheduledTasks.filter((task) => isOpen(task) && task.schedule.scheduled_date > tomorrowDate && task.schedule.scheduled_date <= thirdDay && task.schedule.scheduling_status !== "cancelled");
  const backlog = tasks.map(withSchedule).filter((task) => isOpen(task) && (!task.schedule || task.schedule.scheduling_status === "backlog" || (!task.schedule.scheduled_date && task.schedule.scheduling_status === "unscheduled")));
  const waiting = scheduledTasks.filter((task) => isOpen(task) && task.schedule.scheduling_status === "waiting");
  const rescheduledToday = scheduledTasks.filter((task) => task.schedule.previous_scheduled_date === targetDate && task.schedule.scheduling_status === "rescheduled");
  const cancelledToday = scheduledTasks.filter((task) => task.schedule.previous_scheduled_date === targetDate && task.schedule.scheduling_status === "cancelled");
  const completedPlan = todayPlan.filter(isDone);

  return {
    schema_version: "3.0",
    generated_at: generatedAt.toISOString(),
    timezone: "Asia/Shanghai",
    date: targetDate,
    counts: {
      today_open: todayOpen.length,
      overdue_open: overdueOpen.length,
      priority_open: priorityOpen.length,
      personally_required: personallyRequired.length,
      today_completed: todayCompleted.length,
      yesterday_completed: yesterdayCompleted.length,
      upcoming: upcoming.length,
      unscheduled: unscheduled.length,
      today_planned: todayPlan.length,
      today_plan_completed: completedPlan.length,
      today_rescheduled: rescheduledToday.length,
      today_cancelled: cancelledToday.length,
    },
    today_open: todayOpen,
    overdue_open: overdueOpen,
    priority_open: priorityOpen,
    personally_required: personallyRequired,
    today_completed: todayCompleted,
    yesterday_completed: yesterdayCompleted,
    recent_completed: recentCompleted,
    upcoming,
    unscheduled,
    today_plan: todayPlan,
    tomorrow,
    next_three_days: nextThreeDays,
    backlog,
    waiting,
    evening_summary: {
      planned: todayPlan.length,
      completed: completedPlan.length,
      rescheduled: rescheduledToday.length,
      cancelled: cancelledToday.length,
    },
  };
}
