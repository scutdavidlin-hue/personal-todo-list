import { createTaskConversation } from "./src/task-conversation.js";
import {
  escapeHtml,
  fromDatabaseTask,
  groupTasksByDue,
  groupTasksForToday,
  localDateISO,
  offsetDate,
  replaceTask,
} from "./src/core.js";
import { TaskCloudClient } from "./src/cloud-client.js";
import {
  GOAL_CATEGORIES,
  GOAL_HORIZONS,
  GOAL_STATUSES,
  GOAL_TYPES,
  formatGoalMoney,
  goalContext,
  goalHorizonLabel,
  goalMatchesSection,
  goalTargetLabel,
} from "./src/goals.js";

const client = new TaskCloudClient(window.TASK_SYNC_CONFIG || {});
const taskConversation = createTaskConversation({ client, onChanged: () => refreshTasks({ quiet: true }) });
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let tasks = [];
let schedules = [];
let goals = [];
let projects = [];
let taskContextLinks = [];
let currentUser = null;
let currentFilter = "all";
let currentGoalFilter = "active";
let selectedGoalId = null;
let pendingGoalLinkId = null;
let planningLoadError = "";
let pendingIds = new Set();
let reviewSaveTimer = null;
const firedReminders = new Set();

const GOAL_TYPE_LABELS = {
  Goal: "目标",
  Plan: "计划",
  LongTermItem: "持续事项",
  FinancialItem: "财务事项",
  Idea: "想法",
  LifePlan: "人生规划",
  BusinessPlan: "事业规划",
  FamilyPlan: "家庭规划",
};
const GOAL_CATEGORY_LABELS = {
  Career: "职业",
  Business: "事业",
  Finance: "财务",
  Family: "家庭",
  Health: "健康",
  Travel: "旅行",
  Learning: "学习",
  Property: "房产",
  Personal: "个人",
  Relationship: "关系",
  Other: "其他",
};
const GOAL_STATUS_LABELS = {
  Inbox: "待整理",
  Thinking: "思考中",
  Planning: "规划中",
  Active: "推进中",
  Paused: "已暂停",
  Completed: "已完成",
  Dropped: "已放弃",
  Archived: "已归档",
};

function formatDate(dateString) {
  if (!dateString) return "无截止日期";
  const date = new Date(`${dateString}T00:00:00`);
  return date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return "早上好，今天准备做什么？";
  if (hour < 14) return "中午好，看看上午的进展吧";
  if (hour < 18) return "下午好，继续稳稳地推进";
  return "晚上好，给今天收个尾吧";
}

function priorityLabel(value) {
  return { urgent: "紧急", high: "高优先", medium: "中优先", low: "低优先" }[value] || "中优先";
}

function emptyState(text = "今天还没有任务") {
  return `<div class="empty-state"><b>${text}</b><span>点击右上角“添加任务”开始安排。</span></div>`;
}

function setConnection(state, message) {
  const toolbar = $("#syncToolbar");
  toolbar.classList.remove("syncing", "offline", "error");
  if (state) toolbar.classList.add(state);
  $("#syncStatus").textContent = message;
  $("#sidebarSyncText").textContent = message;
}

function showToast(message, tone = "normal") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", tone === "error");
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3000);
}

function showCloudContent(show) {
  ["#todayView", "#tasksView", "#goalsView", "#statsView"].forEach((selector) => { $(selector).hidden = !show; });
  $("#syncToolbar").hidden = !show;
  updatePrimaryAction(show ? activeViewName() : "");
}

function activeViewName() {
  return $(".nav-item.active")?.dataset.view || "today";
}

function updatePrimaryAction(view = activeViewName()) {
  const visible = Boolean(currentUser);
  $("#addTaskButton").hidden = !visible || view === "goals";
  $("#addGoalButton").hidden = !visible || view !== "goals";
}

function renderTaskItem(task) {
  const syncing = pendingIds.has(task.id);
  const schedule = schedules.find((item) => item.google_task_id === task.id);
  const contextLink = taskContextLinks.find((item) => item.google_task_id === task.id);
  const linkedGoal = goals.find((item) => item.id === contextLink?.goal_plan_id);
  return `
    <div class="task-item ${task.done ? "done" : ""} ${syncing ? "syncing" : ""}" data-id="${task.id}">
      <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} ${syncing ? "disabled" : ""} aria-label="完成 ${escapeHtml(task.title)}">
      <div class="task-copy">
        <button class="conversation-open" data-converse="${escapeHtml(task.id)}">${escapeHtml(task.title)}</button>
        <small>
          ${task.carriedFromDate ? `<span class="carry-chip">↪ ${escapeHtml(task.carriedFromDate)} 延续</span>` : ""}
          ${schedule?.scheduled_start ? `<span class="carry-chip">${schedule.scheduling_status === "rescheduled" ? "↪" : "◷"} ${escapeHtml(schedule.scheduled_date)} ${escapeHtml(schedule.scheduled_start.slice(0, 5))}</span>` : ""}
          ${linkedGoal ? `<span class="goal-link-chip">目标 · ${escapeHtml(linkedGoal.title)}</span>` : ""}
          <span>Google Tasks</span>
        </small>
      </div>
      <div class="task-menu">
        <button aria-label="任务操作" ${syncing ? "disabled" : ""}>···</button>
        <div class="task-actions">
          <button data-action="edit">编辑</button>
          <button data-action="tomorrow">移到明天</button>
          <button class="danger" data-action="delete">删除任务</button>
        </div>
      </div>
    </div>`;
}

function renderToday() {
  const today = localDateISO();
  let todayTasks = tasks.filter((task) => task.date === today && task.status !== "cancelled");
  if (currentFilter === "open") todayTasks = todayTasks.filter((task) => !task.done);
  if (currentFilter === "done") todayTasks = todayTasks.filter((task) => task.done);
  $("#todayTaskList").innerHTML = todayTasks.length
    ? todayTasks.map(renderTaskItem).join("")
    : emptyState(currentFilter === "done" ? "今天还没有已完成任务" : "这里暂时空空的");

  const allToday = tasks.filter((task) => task.date === today && task.status !== "cancelled");
  const completed = allToday.filter((task) => task.done).length;
  const percent = allToday.length ? Math.round(completed / allToday.length * 100) : 0;
  $("#progressPercent").textContent = `${percent}%`;
  $("#completedCount").textContent = completed;
  $("#importantCount").textContent = allToday.filter((task) => !task.done).length;
  $("#remainingMinutes").textContent = allToday.length;
  $("#ringText").textContent = `${completed}/${allToday.length}`;
  $("#progressRing").style.setProperty("--progress", `${percent * 3.6}deg`);

  const focus = allToday.find((task) => !task.done);
  $("#focusTitle").textContent = focus?.title || "今天的任务已完成";
  $("#focusMeta").textContent = focus
    ? `${formatDate(focus.date)}${focus.notes ? ` · ${focus.notes}` : ""}`
    : "做得很好。可以休息一下，或者提前安排明天。";
  $("#completeFocusButton").dataset.id = focus?.id || "";
  $("#completeFocusButton").textContent = focus ? "标记完成" : "全部完成";
  $("#completeFocusButton").disabled = !focus || pendingIds.has(focus?.id);
}

function renderAllTasks() {
  const query = ($("#taskSearch")?.value || "").trim().toLowerCase();
  const list = tasks
    .filter((task) => task.status !== "cancelled")
    .filter((task) => task.title.toLowerCase().includes(query) || task.notes.toLowerCase().includes(query));
  const groups = groupTasksByDue(list, localDateISO());
  const taskRow = (task) => {
    const contextLink = taskContextLinks.find((item) => item.google_task_id === task.id);
    const linkedGoal = goals.find((item) => item.id === contextLink?.goal_plan_id);
    return `
    <div class="task-row ${pendingIds.has(task.id) ? "syncing" : ""}" data-id="${task.id}">
      <div class="task-row-main">
        <input class="task-check" type="checkbox" ${task.done ? "checked" : ""} ${pendingIds.has(task.id) ? "disabled" : ""} aria-label="完成 ${escapeHtml(task.title)}">
        <span>${escapeHtml(task.title)}</span>
      </div>
      <span>${formatDate(task.dueDate)}</span>
      <span class="category-chip">${linkedGoal ? escapeHtml(linkedGoal.title) : escapeHtml(task.category)}</span>
      <span class="status-chip ${task.done ? "done" : "open"}">${task.done ? "已完成" : "进行中"}</span>
    </div>`;
  };
  const sections = [
    ["overdue", "Overdue", "已逾期"],
    ["today", "Today", "今天"],
    ["upcoming", "Upcoming", "未来 / 待安排"],
    ["completed", "Completed", "已完成"],
  ];
  $("#allTaskList").innerHTML = list.length
    ? sections.map(([key, eyebrow, title]) => `
      <section class="task-group">
        <div class="task-group-title"><span><small>${eyebrow}</small><strong>${title}</strong></span><b>${groups[key].length}</b></div>
        <div>${groups[key].length ? (key === "completed" ? groups[key].slice(0, 50) : groups[key]).map(taskRow).join("") : '<div class="group-empty">暂无</div>'}</div>
      </section>`).join("")
    : emptyState("没有找到相关任务");
}

function renderStats() {
  const active = tasks.filter((task) => task.status !== "cancelled");
  const completed = active.filter((task) => task.done);
  const rate = active.length ? Math.round(completed.length / active.length * 100) : 0;
  $("#weeklyRate").textContent = `${rate}%`;
  $("#weeklyMessage").textContent = rate >= 80 ? "你的完成节奏很好，记得也给自己留一点余地。" : rate >= 50 ? "进展不错，优先把最重要的事情做完。" : "从一件小事开始，慢慢建立自己的节奏。";
  $("#totalCompleted").textContent = `${completed.length} 件`;

  const completedDays = new Set(completed.map((task) => (task.completedAt || "").slice(0, 10)));
  let streak = 0;
  const cursor = new Date();
  while (completedDays.has(localDateISO(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  $("#streakCount").textContent = `${streak} 天`;

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (6 - index));
    const iso = localDateISO(date);
    const count = completed.filter((task) => (task.completedAt || "").slice(0, 10) === iso).length;
    return { iso, label: date.toLocaleDateString("zh-CN", { weekday: "short" }).replace("周", ""), count };
  });
  const max = Math.max(1, ...days.map((day) => day.count));
  $("#barChart").innerHTML = days.map((day) => `
    <div class="bar-column ${day.iso === localDateISO() ? "today" : ""}">
      <b>${day.count || ""}</b><div class="bar" style="height:${Math.max(5, day.count / max * 155)}px"></div><span>${day.label}</span>
    </div>`).join("");

  const categoryNames = [...new Set(["工作", "学习", "生活", "健康", ...active.map((task) => task.category)])];
  const categoryCounts = categoryNames.map((name) => ({ name, count: active.filter((task) => task.category === name).length }));
  const categoryMax = Math.max(1, ...categoryCounts.map((item) => item.count));
  $("#categoryStats").innerHTML = categoryCounts.map((item) => `
    <div class="category-stat"><span>${escapeHtml(item.name)}</span><div class="category-track"><div class="category-fill" style="width:${item.count / categoryMax * 100}%"></div></div><b>${item.count}</b></div>`).join("");
}

function formatUpdated(value) {
  if (!value) return "刚刚更新";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "最近更新";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function goalCard(goal) {
  const context = goalContext(goal.id, projects, taskContextLinks, tasks);
  const financial = goal.type === "FinancialItem" || goal.financial_type;
  return `<article class="goal-card ${financial ? "financial" : ""}">
    <button type="button" class="goal-card-open" data-open-goal="${escapeHtml(goal.id)}" aria-label="打开 ${escapeHtml(goal.title)}">
      <div class="goal-card-heading">
        <span class="goal-kind">${escapeHtml(GOAL_TYPE_LABELS[goal.type] || goal.type)} · ${escapeHtml(GOAL_CATEGORY_LABELS[goal.category] || goal.category)} · ${escapeHtml(goalHorizonLabel(goal))}</span>
        <span class="goal-status status-${escapeHtml(String(goal.status || "").toLowerCase())}">${escapeHtml(GOAL_STATUS_LABELS[goal.status] || goal.status)}</span>
      </div>
      <h3>${escapeHtml(goal.title)}</h3>
      <p>${escapeHtml(goal.description || goal.why || "尚未补充说明")}</p>
      ${financial ? `<div class="financial-balance"><span>剩余</span><strong>${formatGoalMoney(goal.amount_remaining, goal.currency)}</strong><small>${escapeHtml(goal.counterparty || "未设置对方")}</small></div>` : ""}
      <div class="goal-progress" aria-label="进度 ${goal.progress_percent}%"><span style="width:${goal.progress_percent}%"></span></div>
      <div class="goal-card-meta">
        <span>${escapeHtml(goalHorizonLabel(goal))}</span>
        <span>${escapeHtml(goalTargetLabel(goal))}</span>
        <span>${context.projectCount} 个项目</span>
        <span>${context.openTaskCount} 个下一步</span>
      </div>
      <div class="goal-next-action">
        <span>下一步</span>
        <strong>${escapeHtml(context.nextAction?.title || "暂未创建明确动作")}</strong>
        <small>${formatUpdated(goal.updated_at)}</small>
      </div>
    </button>
  </article>`;
}

function renderGoals() {
  const today = localDateISO();
  $("#activeGoalCount").textContent = goals.filter((goal) => goal.status === "Active").length;
  $("#reviewGoalCount").textContent = goals.filter((goal) => goal.review_date && goal.review_date <= today && !["Completed", "Dropped", "Archived"].includes(goal.status)).length;
  $("#receivableGoalCount").textContent = goals.filter((goal) => goal.financial_type === "Receivable" && !["Completed", "Dropped", "Archived"].includes(goal.status)).length;

  const loadMessage = $("#goalsLoadMessage");
  loadMessage.hidden = !planningLoadError;
  if (planningLoadError) loadMessage.innerHTML = `<div><strong>Goals 暂时只读或尚未部署</strong><p>${escapeHtml(planningLoadError)}</p></div>`;

  const query = ($("#goalSearch")?.value || "").trim().toLowerCase();
  const visible = goals
    .filter((goal) => goalMatchesSection(goal, currentGoalFilter))
    .filter((goal) => [goal.title, goal.description, goal.why, goal.counterparty].some((value) => String(value || "").toLowerCase().includes(query)));
  $("#goalsList").innerHTML = visible.length
    ? visible.map(goalCard).join("")
    : `<div class="goals-empty"><h3>${query ? "没有找到匹配内容" : "这个视图还没有长期事项"}</h3><p>${query ? "换一个关键词，或切换上方视图。" : "先保存方向，不必为了填满系统而虚构下一步。"}</p>${planningLoadError ? "" : '<button class="primary-button" type="button" data-create-goal>添加第一个 Goal</button>'}</div>`;
}

function renderRecentGoals() {
  const visible = goals
    .filter((goal) => ["Active", "Planning"].includes(goal.status))
    .slice(0, 3);
  $("#recentGoals").innerHTML = visible.length
    ? visible.map((goal) => {
      const context = goalContext(goal.id, projects, taskContextLinks, tasks);
      return `<button type="button" class="recent-goal" data-open-goal="${escapeHtml(goal.id)}">
        <span>${escapeHtml(GOAL_CATEGORY_LABELS[goal.category] || goal.category)} · ${escapeHtml(goalHorizonLabel(goal))}</span>
        <strong>${escapeHtml(goal.title)}</strong>
        <small>${context.nextAction ? `下一步：${escapeHtml(context.nextAction.title)}` : `${escapeHtml(goalTargetLabel(goal))} · 暂无下一步`}</small>
      </button>`;
    }).join("")
    : `<div class="recent-goals-empty"><strong>长期方向还没有进入这里</strong><span>在 Goals 中保存目标、计划或持续事项。</span></div>`;
}

function goalDateRow(label, value) {
  return `<div><dt>${label}</dt><dd>${escapeHtml(value || "未设置")}</dd></div>`;
}

function renderGoalDetail() {
  const goal = goals.find((item) => item.id === selectedGoalId);
  if (!goal) return;
  const context = goalContext(goal.id, projects, taskContextLinks, tasks);
  const availableTasks = tasks.filter((task) => {
    if (task.done || task.status === "cancelled") return false;
    const link = taskContextLinks.find((item) => item.google_task_id === task.id);
    return !link || link.goal_plan_id === goal.id;
  });
  const projectOptions = context.projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.title)}</option>`).join("");
  const taskOptions = availableTasks.map((task) => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title)}</option>`).join("");

  $("#goalDetailKind").textContent = `${GOAL_TYPE_LABELS[goal.type] || goal.type} · ${goalHorizonLabel(goal)} · ${GOAL_STATUS_LABELS[goal.status] || goal.status}`;
  $("#goalDetailTitle").textContent = goal.title;
  $("#goalDetailContent").innerHTML = `<div class="goal-detail-layout">
    <div class="goal-detail-main">
      <section class="detail-section">
        <h3>Overview</h3>
        <p class="detail-description">${escapeHtml(goal.description || "尚未补充目标内容。")}</p>
        <div class="why-block"><span>Why / 原始动机</span><p>${escapeHtml(goal.why || "尚未记录；系统不会替你编造动机。")}</p></div>
      </section>

      <section class="detail-section">
        <div class="detail-section-heading"><div><h3>Projects</h3><p>为这个方向开展的阶段性工作</p></div><button class="text-button" type="button" data-detail-action="new-project">添加项目</button></div>
        <div class="project-list">${context.projects.length ? context.projects.map((project) => `<div class="project-row"><div><strong>${escapeHtml(project.title)}</strong><span>${escapeHtml(project.description || "暂无说明")}</span></div><b>${escapeHtml(project.status)}</b></div>`).join("") : '<div class="detail-empty">尚未创建 Project。Goal 可以先独立存在。</div>'}</div>
      </section>

      <section class="detail-section">
        <div class="detail-section-heading"><div><h3>Tasks</h3><p>真正需要执行的下一步，状态来自 Google Tasks</p></div><button class="text-button" type="button" data-detail-action="new-task">新建下一步</button></div>
        <div class="goal-task-list">${context.tasks.length ? context.tasks.map((task) => `<div class="goal-task-row ${task.done ? "done" : ""}" data-id="${escapeHtml(task.id)}"><input class="goal-task-check" type="checkbox" data-detail-action="toggle-task" ${task.done ? "checked" : ""} aria-label="${task.done ? "恢复" : "完成"} ${escapeHtml(task.title)}"><div><strong>${escapeHtml(task.title)}</strong><span>${task.done ? "已完成" : task.dueDate ? `到期 ${escapeHtml(task.dueDate)}` : "未安排日期"}</span></div><button type="button" data-detail-action="unlink-task" data-task-id="${escapeHtml(task.id)}">解除关联</button></div>`).join("") : '<div class="detail-empty">还没有关联 Task。没有明确动作时，这是正常状态。</div>'}</div>
        <div class="task-linker">
          <select id="existingTaskSelect" aria-label="选择已有任务" ${availableTasks.length ? "" : "disabled"}><option value="">${availableTasks.length ? "选择一个未完成 Task" : "没有可关联的未完成 Task"}</option>${taskOptions}</select>
          <select id="existingProjectSelect" aria-label="关联项目"><option value="">直接关联 Goal</option>${projectOptions}</select>
          <button class="secondary-button" type="button" data-detail-action="link-task" ${availableTasks.length ? "" : "disabled"}>关联已有 Task</button>
        </div>
      </section>

      <section class="detail-section">
        <h3>Notes / Thinking</h3>
        <p class="pre-line">${escapeHtml(goal.notes || "尚未记录后续思考。")}</p>
        <div class="original-input"><span>保留的原始输入</span><blockquote>${escapeHtml(goal.original_input)}</blockquote></div>
      </section>
    </div>

    <aside class="goal-detail-side">
      <section class="progress-block"><span>当前进展</span><strong>${goal.progress_percent}%</strong><div class="goal-progress"><i style="width:${goal.progress_percent}%"></i></div></section>
      <dl class="goal-facts">
        ${goalDateRow("时间层级", goalHorizonLabel(goal))}
        ${goalDateRow("目标时间", goalTargetLabel(goal))}
        ${goalDateRow("开始日期", goal.start_date)}
        ${goalDateRow("下次复查", goal.review_date)}
        ${goalDateRow("硬截止", goal.deadline)}
        ${goalDateRow("优先级", priorityLabel(goal.priority))}
      </dl>
      ${(goal.type === "FinancialItem" || goal.financial_type) ? `<section class="detail-financial"><h3>Financial</h3><dl>${goalDateRow("总金额", formatGoalMoney(goal.amount_total, goal.currency))}${goalDateRow("已完成", formatGoalMoney(goal.amount_completed, goal.currency))}${goalDateRow("剩余", formatGoalMoney(goal.amount_remaining, goal.currency))}${goalDateRow("对方", goal.counterparty || "未设置")}</dl></section>` : ""}
      <div class="detail-meta">最近更新 ${formatUpdated(goal.updated_at)}</div>
    </aside>
  </div>`;
}

function render() {
  $("#dateLabel").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  if ($("#todayView").classList.contains("active")) $("#pageTitle").textContent = greeting();
  renderToday();
  renderAllTasks();
  renderGoals();
  renderRecentGoals();
  renderStats();
  if (selectedGoalId && $("#goalDetailDialog").open) renderGoalDetail();
  bindDynamicEvents();
}

function bindDynamicEvents() {
  $$ ("[data-converse]").forEach((button) => button.addEventListener("click", () => taskConversation.open(tasks.find((task) => task.id === button.dataset.converse))));
  $$(".task-check").forEach((input) => input.addEventListener("change", (event) => {
    const row = event.target.closest("[data-id]");
    if (row) toggleTask(row.dataset.id, event.target.checked);
  }));
  $$(".task-menu > button").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = button.closest(".task-menu");
    $$(".task-menu").filter((item) => item !== menu).forEach((item) => item.classList.remove("open"));
    menu.classList.toggle("open");
  }));
  $$(".task-actions button").forEach((button) => button.addEventListener("click", () => {
    const id = button.closest(".task-item").dataset.id;
    if (button.dataset.action === "edit") openTaskDialog(tasks.find((task) => task.id === id));
    if (button.dataset.action === "tomorrow") moveToTomorrow(id);
    if (button.dataset.action === "delete") cancelTask(id);
  }));
  $$('[data-open-goal]').forEach((button) => button.addEventListener("click", () => openGoalDetail(button.dataset.openGoal)));
  $$('[data-create-goal]').forEach((button) => button.addEventListener("click", () => openGoalDialog()));
}

function updateCachedTasks() {
  if (currentUser) client.cacheTasks(currentUser.id, tasks);
}

function updateCachedPlanning() {
  if (currentUser) client.cachePlanning(currentUser.id, { goals, projects, links: taskContextLinks });
}

function populateGoalOptions() {
  $("#goalType").innerHTML = GOAL_TYPES.map((value) => `<option value="${value}">${GOAL_TYPE_LABELS[value] || value}</option>`).join("");
  $("#goalCategory").innerHTML = GOAL_CATEGORIES.map((value) => `<option value="${value}">${GOAL_CATEGORY_LABELS[value] || value}</option>`).join("");
  $("#goalStatus").innerHTML = GOAL_STATUSES.map((value) => `<option value="${value}">${GOAL_STATUS_LABELS[value] || value}</option>`).join("");
  $("#goalHorizon").innerHTML = GOAL_HORIZONS.map((value) => `<option value="${value}">${goalHorizonLabel(value)}</option>`).join("");
}

function setTargetPrecision(value) {
  $$('[data-target-field]').forEach((label) => { label.hidden = label.dataset.targetField !== value; });
}

function selectGoalFilter(filter) {
  currentGoalFilter = filter;
  $$(".goal-tab").forEach((item) => {
    const active = item.dataset.goalFilter === filter;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
}

function sectionForGoal(goal) {
  if (goal.type === "FinancialItem" || goal.financial_type) return "financial";
  if (["Inbox", "Thinking", "Planning"].includes(goal.status)) return "planning";
  if (goal.status === "Paused" || goal.type === "Idea") return "someday";
  if (["Completed", "Dropped", "Archived"].includes(goal.status)) return "completed";
  return "active";
}

function openGoalDialog(goal = null) {
  $("#goalDialogTitle").textContent = goal ? "编辑长期目标或计划" : "添加长期目标或计划";
  $("#goalId").value = goal?.id || "";
  $("#goalTitle").value = goal?.title || "";
  $("#goalType").value = goal?.type || "Goal";
  $("#goalCategory").value = goal?.category || "Personal";
  $("#goalStatus").value = goal?.status || "Planning";
  $("#goalHorizon").value = goal?.horizon || "medium";
  $("#goalDescription").value = goal?.description || "";
  $("#goalWhy").value = goal?.why || "";
  $("#goalStartDate").value = goal?.start_date || "";
  $("#goalReviewDate").value = goal?.review_date || "";
  $("#goalDeadline").value = goal?.deadline || "";
  $("#goalPriority").value = goal?.priority || "medium";
  $("#goalProgress").value = goal?.progress_percent || 0;
  $("#goalFinancialType").value = goal?.financial_type || "";
  $("#goalAmountTotal").value = goal?.amount_total ?? "";
  $("#goalAmountCompleted").value = goal?.amount_completed ?? 0;
  $("#goalCurrency").value = goal?.currency || "CNY";
  $("#goalCounterparty").value = goal?.counterparty || "";
  $("#goalOriginalInput").value = goal?.original_input || "";
  $("#goalNotes").value = goal?.notes || "";

  const precision = goal?.target_date ? "date" : goal?.target_month ? "month" : goal?.target_year ? "year" : "none";
  $("#goalTargetPrecision").value = precision;
  $("#goalTargetDate").value = goal?.target_date || "";
  $("#goalTargetMonth").value = goal?.target_month || "";
  $("#goalTargetYear").value = goal?.target_year || "";
  setTargetPrecision(precision);
  $("#financialDetails").open = goal?.type === "FinancialItem" || Boolean(goal?.financial_type);
  $("#goalDialog").showModal();
  setTimeout(() => $("#goalTitle").focus(), 50);
}

function goalFormPayload() {
  const precision = $("#goalTargetPrecision").value;
  const total = $("#goalAmountTotal").value;
  const completed = $("#goalAmountCompleted").value;
  return {
    title: $("#goalTitle").value.trim(),
    type: $("#goalType").value,
    category: $("#goalCategory").value,
    status: $("#goalStatus").value,
    horizon: $("#goalHorizon").value,
    description: $("#goalDescription").value.trim(),
    why: $("#goalWhy").value.trim(),
    target_date: precision === "date" ? $("#goalTargetDate").value || null : null,
    target_month: precision === "month" ? $("#goalTargetMonth").value || null : null,
    target_year: precision === "year" && $("#goalTargetYear").value ? Number($("#goalTargetYear").value) : null,
    start_date: $("#goalStartDate").value || null,
    review_date: $("#goalReviewDate").value || null,
    deadline: $("#goalDeadline").value || null,
    priority: $("#goalPriority").value,
    progress_percent: Number($("#goalProgress").value || 0),
    financial_type: $("#goalFinancialType").value || null,
    amount_total: total === "" ? null : Number(total),
    amount_completed: completed === "" ? 0 : Number(completed),
    currency: $("#goalCurrency").value.trim().toUpperCase() || "CNY",
    counterparty: $("#goalCounterparty").value.trim() || null,
    original_input: $("#goalOriginalInput").value.trim() || $("#goalTitle").value.trim(),
    notes: $("#goalNotes").value.trim(),
    archived_at: $("#goalStatus").value === "Archived" ? new Date().toISOString() : null,
  };
}

async function saveGoal(event) {
  event.preventDefault();
  if (!$("#goalForm").reportValidity()) return;
  const payload = goalFormPayload();
  if (payload.amount_total !== null && payload.amount_completed > payload.amount_total) {
    showToast("已完成金额不能大于总金额", "error");
    return;
  }
  const id = $("#goalId").value;
  const button = $("#saveGoalButton");
  button.disabled = true;
  setConnection("syncing", "正在保存长期规划…");
  try {
    const saved = id ? await client.updateGoal(id, payload) : await client.createGoal(payload);
    goals = id ? goals.map((goal) => goal.id === saved.id ? saved : goal) : [saved, ...goals];
    selectedGoalId = selectedGoalId === id ? saved.id : selectedGoalId;
    selectGoalFilter(sectionForGoal(saved));
    planningLoadError = "";
    updateCachedPlanning();
    $("#goalDialog").close();
    render();
    setConnection("", "长期规划已同步");
    showToast(id ? "Goal 修改已保存" : "已保存到 Goals & Plans；尚未创建 Task");
  } catch (error) {
    setConnection("error", "Goal 保存失败");
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function openGoalDetail(id) {
  const goal = goals.find((item) => item.id === id);
  if (!goal) return;
  selectedGoalId = id;
  renderGoalDetail();
  if (!$("#goalDetailDialog").open) $("#goalDetailDialog").showModal();
}

function openProjectDialog() {
  if (!selectedGoalId) return;
  $("#projectForm").reset();
  $("#projectGoalId").value = selectedGoalId;
  $("#projectStatus").value = "Planning";
  $("#projectDialog").showModal();
  setTimeout(() => $("#projectTitle").focus(), 50);
}

async function saveProject(event) {
  event.preventDefault();
  if (!$("#projectForm").reportValidity()) return;
  const button = $("#saveProjectButton");
  button.disabled = true;
  try {
    const project = await client.createProject({
      goal_plan_id: $("#projectGoalId").value,
      title: $("#projectTitle").value.trim(),
      description: $("#projectDescription").value.trim(),
      status: $("#projectStatus").value,
      target_date: $("#projectTargetDate").value || null,
      original_input: $("#projectTitle").value.trim(),
    });
    projects = [project, ...projects];
    updateCachedPlanning();
    $("#projectDialog").close();
    render();
    showToast("Project 已关联到当前 Goal");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function linkExistingTask() {
  const taskId = $("#existingTaskSelect")?.value;
  const projectId = $("#existingProjectSelect")?.value || null;
  if (!taskId || !selectedGoalId) return;
  try {
    const link = await client.linkTaskContext(taskId, selectedGoalId, projectId);
    taskContextLinks = [link, ...taskContextLinks.filter((item) => item.google_task_id !== taskId)];
    updateCachedPlanning();
    render();
    showToast("已有 Task 已关联；完成它不会删除 Goal");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function unlinkTask(taskId) {
  try {
    await client.unlinkTaskContext(taskId);
    taskContextLinks = taskContextLinks.filter((item) => item.google_task_id !== taskId);
    updateCachedPlanning();
    render();
    showToast("已解除关联；Google Task 本身没有被删除");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function handleGoalDetailAction(event) {
  const control = event.target.closest("[data-detail-action]");
  if (!control) return;
  const action = control.dataset.detailAction;
  if (action === "new-project") openProjectDialog();
  if (action === "new-task") openTaskDialog(null, selectedGoalId);
  if (action === "link-task") linkExistingTask();
  if (action === "unlink-task") unlinkTask(control.dataset.taskId);
  if (action === "toggle-task" && event.type === "change") {
    const row = control.closest("[data-id]");
    if (row) toggleTask(row.dataset.id, control.checked);
  }
}

async function mutateTask(id, changes, successMessage) {
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((row) => row.classList.add("syncing"));
  setConnection("syncing", "正在保存到云端…");
  try {
    const updated = await client.updateTask(id, changes);
    tasks = replaceTask(tasks, updated);
    const changedDate = changes.dueDate ?? changes.date;
    if (changedDate) {
      const currentSchedule = schedules.find((item) => item.google_task_id === id);
      const scheduleResult = currentSchedule
        ? await client.rescheduleTask(id, { ...currentSchedule, scheduled_date: changedDate })
        : await client.scheduleTask(id, { scheduled_date: changedDate, scheduling_source: "explicit_user" });
      if (scheduleResult.schedule) schedules = [...schedules.filter((item) => item.google_task_id !== id), scheduleResult.schedule];
    }
    updateCachedTasks();
    setConnection("", `已同步 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    showToast(successMessage);
  } catch (error) {
    setConnection("error", "保存失败，云端状态未改变");
    showToast(`${error.message}；操作已撤回`, "error");
  } finally {
    pendingIds.delete(id);
    render();
  }
}

function toggleTask(id, done) {
  return mutateTask(id, {
    status: done ? "completed" : "open",
    completed_at: done ? new Date().toISOString() : null,
  }, done ? "已保存：完成一件，做得好。" : "已保存：任务恢复为未完成");
}

function moveToTomorrow(id) {
  return mutateTask(id, { date: offsetDate(1) }, "已保存：任务已安排到明天");
}

async function cancelTask(id) {
  if (!window.confirm("这会从 Google Tasks 永久删除任务。确定删除吗？")) return;
  if (pendingIds.has(id)) return;
  pendingIds.add(id);
  setConnection("syncing", "正在从 Google Tasks 删除…");
  try {
    await client.cancelTask(id);
    tasks = tasks.filter((task) => task.id !== id);
    if (taskContextLinks.some((item) => item.google_task_id === id)) {
      try { await client.unlinkTaskContext(id); } catch { /* Stale context is harmless and can be reconciled later. */ }
      taskContextLinks = taskContextLinks.filter((item) => item.google_task_id !== id);
      updateCachedPlanning();
    }
    updateCachedTasks();
    setConnection("", "已同步到云端");
    showToast("任务已从 Google Tasks 删除");
  } catch (error) {
    setConnection("error", "删除失败，任务仍然保留");
    showToast(error.message, "error");
  } finally {
    pendingIds.delete(id);
    render();
  }
}

function openTaskDialog(task = null, goalId = null) {
  pendingGoalLinkId = task ? null : goalId;
  const schedule = task ? schedules.find((item) => item.google_task_id === task.id) : null;
  $("#dialogTitle").textContent = task ? "编辑这件事" : "添加一件要做的事";
  $("#taskId").value = task?.id || "";
  $("#taskTitle").value = task?.title || "";
  $("#taskDate").value = task?.date || localDateISO();
  $("#taskNotes").value = task?.notes || "";
  $("#taskTime").value = schedule?.scheduled_start?.slice(0, 5) || "";
  $("#taskDuration").value = schedule?.duration_minutes || 30;
  $("#taskFixedTime").checked = schedule?.fixed_time === true;
  $("#taskDialog").showModal();
  setTimeout(() => $("#taskTitle").focus(), 50);
}

async function saveTask(event) {
  event.preventDefault();
  if (!$("#taskForm").reportValidity()) return;
  const button = $("#saveTaskButton");
  button.disabled = true;
  setConnection("syncing", "正在保存到云端…");
  const id = $("#taskId").value;
  const formData = {
    title: $("#taskTitle").value.trim(),
    dueDate: $("#taskDate").value || null,
    notes: $("#taskNotes").value.trim(),
  };
  const schedule = {
    scheduled_date: formData.dueDate,
    scheduled_start: $("#taskTime").value || null,
    duration_minutes: Number($("#taskDuration").value || 30),
    scheduling_source: "explicit_user",
    fixed_time: $("#taskFixedTime").checked,
  };
  let deduplicated = false;
  let relationWarning = "";
  try {
    if (id) {
      const updated = await client.updateTask(id, formData);
      tasks = replaceTask(tasks, updated);
      const currentSchedule = schedules.find((item) => item.google_task_id === id);
      const scheduleResult = schedule.scheduled_start
        ? await (currentSchedule ? client.rescheduleTask(id, schedule) : client.scheduleTask(id, schedule))
        : currentSchedule?.scheduled_start
          ? await client.unscheduleTask(id, schedule)
          : await client.scheduleTask(id, schedule);
      if (scheduleResult.schedule) schedules = [...schedules.filter((item) => item.google_task_id !== id), scheduleResult.schedule];
    } else {
      const created = await client.createTask({ ...formData, schedule, status: "open", source: "manual", originalIntent: formData.title });
      deduplicated = created.metadata?.deduplicated === true;
      if (deduplicated) tasks = replaceTask(tasks, created);
      else tasks.push(fromDatabaseTask(created));
      if (pendingGoalLinkId) {
        try {
          const link = await client.linkTaskContext(created.id, pendingGoalLinkId);
          taskContextLinks = [link, ...taskContextLinks.filter((item) => item.google_task_id !== created.id)];
          updateCachedPlanning();
        } catch (error) {
          relationWarning = `Task 已创建，但关联 Goal 失败：${error.message}`;
        }
      }
    }
    pendingGoalLinkId = null;
    updateCachedTasks();
    $("#taskDialog").close();
    render();
    setConnection("", "已同步到云端");
    showToast(relationWarning || (id ? "任务修改已保存" : deduplicated ? "已识别为现有任务并更新" : "新任务已保存到 Google Tasks"), relationWarning ? "error" : "normal");
  } catch (error) {
    setConnection("error", "保存失败");
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function loadReview() {
  try {
    const review = await client.getReview(localDateISO());
    $("#dailyNote").value = review.note || "";
    $$('[data-mood]').forEach((button) => button.classList.toggle("active", String(review.mood) === button.dataset.mood));
  } catch (error) {
    showToast(`今日小结读取失败：${error.message}`, "error");
  }
}

async function saveReview() {
  clearTimeout(reviewSaveTimer);
  try {
    await client.saveReview(localDateISO(), {
      note: $("#dailyNote").value,
      mood: Number($("[data-mood].active")?.dataset.mood) || null,
    });
    setConnection("", "今日小结已同步");
  } catch (error) {
    setConnection("error", "今日小结保存失败");
    showToast(error.message, "error");
  }
}

function scheduleReviewSave() {
  setConnection("syncing", "正在保存今日小结…");
  clearTimeout(reviewSaveTimer);
  reviewSaveTimer = setTimeout(saveReview, 700);
}

async function refreshTasks({ quiet = false } = {}) {
  if (!currentUser) return;
  setConnection("syncing", "正在同步 Tasks 与 Goals…");
  $("#refreshButton").disabled = true;
  const [taskResult, planningResult] = await Promise.allSettled([
    Promise.all([client.getTasks(), client.listSchedules()]),
    Promise.all([client.listGoals(), client.listProjects(), client.listTaskContextLinks()]),
  ]);

  let taskState = "online";
  if (taskResult.status === "fulfilled") {
    tasks = taskResult.value[0];
    schedules = taskResult.value[1].schedules || [];
    updateCachedTasks();
  } else {
    const cached = client.readCachedTasks(currentUser.id);
    if (Array.isArray(cached?.tasks)) {
      tasks = cached.tasks;
      taskState = "offline";
    } else {
      taskState = "error";
      tasks = [];
    }
  }

  if (planningResult.status === "fulfilled") {
    [goals, projects, taskContextLinks] = planningResult.value;
    planningLoadError = "";
    updateCachedPlanning();
  } else {
    const cached = client.readCachedPlanning(currentUser.id);
    if (Array.isArray(cached?.goals)) {
      goals = cached.goals;
      projects = cached.projects || [];
      taskContextLinks = cached.links || [];
      planningLoadError = "当前显示上次同步的长期规划缓存；恢复网络后可继续编辑。";
    } else {
      goals = [];
      projects = [];
      taskContextLinks = [];
      planningLoadError = `V1.2 长期规划数据暂不可用：${planningResult.reason?.message || "请先部署 Goals & Plans migration"}`;
    }
  }

  render();
  const time = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (taskState === "online" && planningResult.status === "fulfilled") {
    setConnection("", `Tasks 与 Goals 已同步 · ${time}`);
    if (!quiet) showToast("已读取最新 Tasks 与 Goals");
  } else if (taskState === "online") {
    setConnection("offline", `Tasks 已同步 · Goals 暂时只读`);
    if (!quiet) showToast(planningLoadError, "error");
  } else if (taskState === "offline") {
    setConnection("offline", "离线只读 · 显示上次缓存");
    if (!quiet) showToast("网络不可用；当前为只读缓存，写操作不会假装成功", "error");
  } else {
    const message = taskResult.status === "rejected" ? taskResult.reason?.message : "云端任务读取失败";
    setConnection("error", "云端任务读取失败");
    showToast(message || "云端任务读取失败", "error");
  }
  $("#refreshButton").disabled = false;
}

function updateMigrationPanel() {
  const plan = client.legacyMigrationPlan();
  $("#migrationCount").textContent = plan.tasks.length;
  $("#migrationPanel").hidden = plan.completed || plan.tasks.length === 0;
}

async function migrateLegacy() {
  const button = $("#migrateButton");
  button.disabled = true;
  button.textContent = "正在导入…";
  try {
    const result = await client.migrateLegacyTasks();
    $("#migrationPanel").hidden = true;
    await refreshTasks({ quiet: true });
    showToast(`已安全导入 ${result.imported} 条旧任务`);
  } catch (error) {
    showToast(`导入失败：${error.message}。可稍后重试，不会产生重复任务。`, "error");
  } finally {
    button.disabled = false;
    button.textContent = "导入旧任务";
  }
}

async function requestLogin(event) {
  event.preventDefault();
  const button = $("#loginForm button");
  button.disabled = true;
  $("#loginMessage").textContent = "正在前往 Google 授权…";
  try {
    const redirectTo = `${location.origin}${location.pathname}`;
    client.requestGoogleLogin(redirectTo);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function connectGoogleTasks() {
  client.requestGoogleLogin(`${location.origin}${location.pathname}`);
}

async function signOut() {
  taskConversation.close();
  await client.signOut();
  currentUser = null;
  tasks = [];
  schedules = [];
  goals = [];
  projects = [];
  taskContextLinks = [];
  selectedGoalId = null;
  showCloudContent(false);
  $("#authPanel").hidden = false;
  $("#migrationPanel").hidden = true;
  showToast("已安全退出");
}

async function enableNotifications() {
  if (!("Notification" in window)) return showToast("当前浏览器不支持桌面提醒");
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    $("#notificationButton strong").textContent = "提醒已开启";
    $("#notificationButton small").textContent = "保持页面打开即可接收";
    new Notification("日程提醒已开启", { body: "到时间后，我会提醒你处理任务。" });
  } else showToast("没有获得通知权限", "error");
}

function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  tasks.filter((task) => task.date === localDateISO() && task.time === time && !task.done && !firedReminders.has(task.id)).forEach((task) => {
    new Notification(`该做：${task.title}`, { body: `${task.category} · 预计 ${task.duration} 分钟` });
    firedReminders.add(task.id);
  });
}

function switchView(view) {
  const button = $(`.nav-item[data-view="${view}"]`);
  if (!button) return;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `${view}View`));
  const titles = {
    today: greeting(),
    tasks: "把所有执行动作放在一个地方",
    goals: "长期方向，不必伪装成今日待办",
    stats: "看见自己的每一点进展",
  };
  $("#pageTitle").textContent = titles[view];
  updatePrimaryAction(view);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bindStaticEvents() {
  populateGoalOptions();
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$(".filter-pill").forEach((button) => button.addEventListener("click", () => {
    $$(".filter-pill").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    currentFilter = button.dataset.filter;
    renderToday();
    bindDynamicEvents();
  }));
  $("#addTaskButton").addEventListener("click", () => openTaskDialog());
  $("#addGoalButton").addEventListener("click", () => openGoalDialog());
  $("#taskForm").addEventListener("submit", saveTask);
  $("#closeTaskDialog").addEventListener("click", () => $("#taskDialog").close());
  $("#cancelTaskDialog").addEventListener("click", () => $("#taskDialog").close());
  $("#taskDialog").addEventListener("close", () => { pendingGoalLinkId = null; });
  $("#goalForm").addEventListener("submit", saveGoal);
  $("#closeGoalDialog").addEventListener("click", () => $("#goalDialog").close());
  $("#cancelGoalDialog").addEventListener("click", () => $("#goalDialog").close());
  $("#goalTargetPrecision").addEventListener("change", (event) => setTargetPrecision(event.target.value));
  $("#goalType").addEventListener("change", (event) => {
    if (event.target.value === "FinancialItem") {
      $("#goalCategory").value = "Finance";
      $("#financialDetails").open = true;
      if (!$("#goalFinancialType").value) $("#goalFinancialType").value = "Receivable";
    }
  });
  $("#goalDetailContent").addEventListener("click", handleGoalDetailAction);
  $("#goalDetailContent").addEventListener("change", handleGoalDetailAction);
  $("#editGoalButton").addEventListener("click", () => {
    const goal = goals.find((item) => item.id === selectedGoalId);
    if (goal) openGoalDialog(goal);
  });
  $("#closeGoalDetail").addEventListener("click", () => $("#goalDetailDialog").close());
  $("#projectForm").addEventListener("submit", saveProject);
  $("#closeProjectDialog").addEventListener("click", () => $("#projectDialog").close());
  $("#cancelProjectDialog").addEventListener("click", () => $("#projectDialog").close());
  $$(".goal-tab").forEach((button) => button.addEventListener("click", () => {
    selectGoalFilter(button.dataset.goalFilter);
    renderGoals();
    bindDynamicEvents();
  }));
  $("#goalSearch").addEventListener("input", () => { renderGoals(); bindDynamicEvents(); });
  $("#viewAllGoalsButton").addEventListener("click", () => switchView("goals"));
  $("#taskSearch").addEventListener("input", () => { renderAllTasks(); bindDynamicEvents(); });
  $("#completeFocusButton").addEventListener("click", (event) => event.currentTarget.dataset.id && toggleTask(event.currentTarget.dataset.id, true));
  $("#notificationButton").addEventListener("click", enableNotifications);
  $("#loginForm").addEventListener("submit", requestLogin);
  $("#connectGoogleButton").addEventListener("click", connectGoogleTasks);
  $("#refreshButton").addEventListener("click", () => refreshTasks());
  $("#signOutButton").addEventListener("click", signOut);
  $("#migrateButton").addEventListener("click", migrateLegacy);
  $("#dailyNote").addEventListener("input", scheduleReviewSave);
  $$('[data-mood]').forEach((button) => button.addEventListener("click", () => {
    $$('[data-mood]').forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    scheduleReviewSave();
  }));
  document.addEventListener("click", () => $$(".task-menu").forEach((item) => item.classList.remove("open")));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && currentUser) refreshTasks({ quiet: true });
  });
}

async function boot() {
  bindStaticEvents();
  $("#dateLabel").textContent = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
  $("#pageTitle").textContent = greeting();
  if (!client.isConfigured()) {
    $("#setupPanel").hidden = false;
    showCloudContent(false);
    return;
  }

  client.consumeAuthRedirect();
  try {
    currentUser = await client.getUser();
  } catch (error) {
    currentUser = client.session()?.user || null;
    if (!currentUser) {
      $("#authPanel").hidden = false;
      $("#loginMessage").textContent = error.message;
      return;
    }
  }
  if (!currentUser) {
    $("#authPanel").hidden = false;
    return;
  }

  try {
    const connection = await client.finalizeGoogleTasksConnection();
    if (connection.connected) showToast(`已连接：${connection.taskListTitle}`);
  } catch (error) {
    $("#loginMessage").textContent = error.message;
    showToast(error.message, "error");
  }

  $("#authPanel").hidden = true;
  $("#userEmail").textContent = currentUser.email || "已登录";
  showCloudContent(true);
  updateMigrationPanel();
  await Promise.all([refreshTasks({ quiet: true }), loadReview()]);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {
    // The app remains usable online if a browser or local preview blocks Service Workers.
  }));
}

boot();
setInterval(checkReminders, 30_000);
