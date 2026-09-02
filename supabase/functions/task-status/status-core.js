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
  const futureLimit = shiftDate(targetDate, 3);
  const tasks = rows.map(publicTask);
  const isOpen = (task) => task.status === "open";
  const isDone = (task) => task.status === "done";
  const completedDate = (task) => task.completed_at ? shanghaiDate(new Date(task.completed_at)) : null;
  const byCompletedDesc = (left, right) => String(right.completed_at || "").localeCompare(String(left.completed_at || ""));

  const todayOpen = tasks.filter((task) => isOpen(task) && task.date === targetDate && !task.carried_from_date);
  const carryoverOpen = tasks.filter((task) => isOpen(task) && task.date === targetDate && Boolean(task.carried_from_date));
  const todayDone = tasks.filter((task) => isDone(task) && task.date === targetDate);
  const yesterdayCompleted = tasks.filter((task) => isDone(task) && completedDate(task) === yesterday);
  const recentCompleted = tasks.filter(isDone).sort(byCompletedDesc).slice(0, 20);
  const upcoming = tasks.filter((task) => isOpen(task) && task.date > targetDate && task.date <= futureLimit);

  return {
    schema_version: "1.0",
    generated_at: generatedAt.toISOString(),
    timezone: "Asia/Shanghai",
    date: targetDate,
    counts: {
      today_open: todayOpen.length,
      today_done: todayDone.length,
      carryover_open: carryoverOpen.length,
      yesterday_completed: yesterdayCompleted.length,
      upcoming: upcoming.length,
    },
    today_open: todayOpen,
    today_done: todayDone,
    carryover_open: carryoverOpen,
    yesterday_completed: yesterdayCompleted,
    recent_completed: recentCompleted,
    upcoming,
  };
}
