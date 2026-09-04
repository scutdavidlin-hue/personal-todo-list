export const GOAL_TYPES = Object.freeze([
  "Goal",
  "Plan",
  "LongTermItem",
  "FinancialItem",
  "Idea",
  "LifePlan",
  "BusinessPlan",
  "FamilyPlan",
]);

export const GOAL_CATEGORIES = Object.freeze([
  "Career",
  "Business",
  "Finance",
  "Family",
  "Health",
  "Travel",
  "Learning",
  "Property",
  "Personal",
  "Relationship",
  "Other",
]);

export const GOAL_STATUSES = Object.freeze([
  "Inbox",
  "Thinking",
  "Planning",
  "Active",
  "Paused",
  "Completed",
  "Dropped",
  "Archived",
]);

export const GOAL_HORIZONS = Object.freeze(["short", "medium", "long"]);

const GOAL_HORIZON_LABELS = Object.freeze({
  short: "短期",
  medium: "中期",
  long: "长期",
});

export const FINANCIAL_TYPES = Object.freeze([
  "Receivable",
  "Payable",
  "Budget",
  "SavingGoal",
  "InvestmentGoal",
]);

const SECTION_STATUSES = Object.freeze({
  active: new Set(["Active"]),
  planning: new Set(["Inbox", "Thinking", "Planning"]),
  someday: new Set(["Paused"]),
  completed: new Set(["Completed", "Dropped", "Archived"]),
});

export function normalizeGoal(row = {}) {
  return {
    ...row,
    id: String(row.id || ""),
    title: String(row.title || "").trim(),
    description: String(row.description || ""),
    why: String(row.why || ""),
    notes: String(row.notes || ""),
    original_input: String(row.original_input || ""),
    horizon: GOAL_HORIZONS.includes(row.horizon) ? row.horizon : "medium",
    progress_percent: Math.max(0, Math.min(100, Number(row.progress_percent) || 0)),
    amount_total: row.amount_total === null || row.amount_total === undefined ? null : Number(row.amount_total),
    amount_completed: Number(row.amount_completed) || 0,
    amount_remaining: row.amount_remaining === null || row.amount_remaining === undefined
      ? (row.amount_total === null || row.amount_total === undefined ? null : Number(row.amount_total) - (Number(row.amount_completed) || 0))
      : Number(row.amount_remaining),
  };
}

export function goalHorizonLabel(goalOrHorizon) {
  const horizon = typeof goalOrHorizon === "string" ? goalOrHorizon : goalOrHorizon?.horizon;
  return GOAL_HORIZON_LABELS[horizon] || GOAL_HORIZON_LABELS.medium;
}

export function goalMatchesSection(goal, section) {
  if (section === "financial") return goal.type === "FinancialItem" || Boolean(goal.financial_type);
  if (section === "someday") return SECTION_STATUSES.someday.has(goal.status)
    || (goal.type === "Idea" && !["Completed", "Dropped", "Archived"].includes(goal.status));
  return SECTION_STATUSES[section]?.has(goal.status) || false;
}

export function goalTargetLabel(goal) {
  if (goal.target_date) {
    const date = new Date(`${goal.target_date}T00:00:00`);
    if (!Number.isNaN(date.valueOf())) return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  }
  if (/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(goal.target_month || "")) {
    const [year, month] = goal.target_month.split("-");
    return `${year} 年 ${Number(month)} 月`;
  }
  if (goal.target_year) return `${goal.target_year} 年`;
  return "未设目标时间";
}

export function formatGoalMoney(value, currency = "CNY") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  try {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value));
  } catch {
    return `${Number(value).toLocaleString("zh-CN")} ${currency}`;
  }
}

export function goalContext(goalId, projects = [], links = [], tasks = []) {
  const relatedProjects = projects.filter((project) => project.goal_plan_id === goalId && project.status !== "Archived");
  const relatedLinks = links.filter((link) => link.goal_plan_id === goalId);
  const taskIds = new Set(relatedLinks.map((link) => link.google_task_id));
  const relatedTasks = tasks.filter((task) => taskIds.has(task.id));
  const openTasks = relatedTasks.filter((task) => !task.done && task.status !== "completed" && task.status !== "cancelled");
  return {
    projects: relatedProjects,
    tasks: relatedTasks,
    openTasks,
    projectCount: relatedProjects.length,
    openTaskCount: openTasks.length,
    nextAction: openTasks[0] || null,
  };
}

export function cleanGoalWrite(input = {}) {
  const clean = {};
  const allowed = [
    "title", "description", "why", "type", "category", "status", "horizon", "priority", "progress_percent",
    "target_date", "target_month", "target_year", "start_date", "review_date", "deadline",
    "amount_total", "amount_completed", "currency", "counterparty", "financial_type",
    "client_id", "contact_id", "company_id", "notes", "original_input", "archived_at",
  ];
  for (const key of allowed) {
    if (Object.hasOwn(input, key)) clean[key] = input[key] === "" ? null : input[key];
  }
  for (const key of ["description", "why", "notes"]) if (clean[key] === null) clean[key] = "";
  return clean;
}
