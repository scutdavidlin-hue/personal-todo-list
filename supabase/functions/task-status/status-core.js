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

export function buildStatus(rows, targetDate, generatedAt = new Date()) {
  const yesterday = shiftDate(targetDate, -1);
  const futureLimit = shiftDate(targetDate, 7);
  const tasks = rows.map(publicTask);
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

  return {
    schema_version: "2.0",
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
  };
}
