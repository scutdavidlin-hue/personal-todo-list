import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanGoalWrite,
  goalContext,
  goalHorizonLabel,
  goalMatchesSection,
  goalTargetLabel,
  normalizeGoal,
} from "../src/goals.js";

test("target labels preserve date precision without inventing a deadline", () => {
  assert.equal(goalTargetLabel({ target_year: 2027 }), "2027 年");
  assert.equal(goalTargetLabel({ target_month: "2026-10" }), "2026 年 10 月");
  assert.equal(goalTargetLabel({ target_date: "2027-06-30" }), "2027年6月30日");
  assert.equal(goalTargetLabel({}), "未设目标时间");
});

test("goal horizon is normalized and shown using the existing UI model", () => {
  assert.equal(normalizeGoal({ horizon: "medium" }).horizon, "medium");
  assert.equal(normalizeGoal({ horizon: "unexpected" }).horizon, "medium");
  assert.equal(goalHorizonLabel("short"), "短期");
  assert.equal(goalHorizonLabel("medium"), "中期");
  assert.equal(goalHorizonLabel("long"), "长期");
});

test("financial and someday sections are semantic views", () => {
  assert.equal(goalMatchesSection({ type: "FinancialItem", status: "Active" }, "financial"), true);
  assert.equal(goalMatchesSection({ type: "Idea", status: "Thinking" }, "someday"), true);
  assert.equal(goalMatchesSection({ type: "Goal", status: "Completed" }, "completed"), true);
});

test("goal context counts only linked open Google Tasks", () => {
  const context = goalContext(
    "goal-1",
    [{ id: "p1", goal_plan_id: "goal-1", status: "Active" }, { id: "p2", goal_plan_id: "goal-2", status: "Active" }],
    [{ google_task_id: "t1", goal_plan_id: "goal-1" }, { google_task_id: "t2", goal_plan_id: "goal-1" }],
    [{ id: "t1", title: "下一步", status: "open", done: false }, { id: "t2", status: "completed", done: true }],
  );
  assert.equal(context.projectCount, 1);
  assert.equal(context.openTaskCount, 1);
  assert.equal(context.nextAction.title, "下一步");
});

test("normalization keeps a durable balance after task completion", () => {
  const goal = normalizeGoal({ amount_total: "30000.00", amount_completed: "10000.00", amount_remaining: "20000.00" });
  assert.equal(goal.amount_remaining, 20000);
});

test("writes omit generated fields and turn optional blanks into null", () => {
  assert.deepEqual(cleanGoalWrite({ title: "买房", target_date: "", amount_remaining: 10, description: "" }), {
    title: "买房",
    target_date: null,
    description: "",
  });
});
