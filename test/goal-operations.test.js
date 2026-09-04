import test from "node:test";
import assert from "node:assert/strict";
import {
  completeGoalPatch,
  filterGoalsForRead,
  findExistingGoalMatch,
  goalMatchScore,
  isPersistedObjectResult,
  mergeGoalPlanUpdate,
} from "../supabase/functions/_shared/goal-operations.js";

const financeRoleGoal = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "财务岗位经营化转型",
  description: "随着业务流程和交付逐步自动化，财务岗位从传统执行岗位转型为项目落地、客户财务沟通和销售拓展的复合经营岗位。财务人员自己开发的新项目建立项目提成机制。",
  type: "Goal",
  category: "Career",
  status: "Planning",
  horizon: "medium",
  notes: "",
};

test("semantic matching updates the existing finance-role goal", () => {
  const incoming = {
    title: "财务以后自己开发的新项目也要有提成",
    description: "财务以后自己开发的新项目也要有提成。",
    raw_text: "财务以后自己开发的新项目也要有提成。",
    type: "Goal",
    category: "Personal",
    horizon: "long",
  };
  assert.ok(goalMatchScore(incoming, financeRoleGoal) >= 0.58);
  assert.equal(findExistingGoalMatch(incoming, [financeRoleGoal])?.goal.id, financeRoleGoal.id);
});

test("matching rejects unrelated goals and closed records", () => {
  const travel = { ...financeRoleGoal, id: "travel", title: "东北家庭旅行", description: "规划哈尔滨行程", category: "Travel" };
  const closed = { ...financeRoleGoal, id: "closed", status: "Completed" };
  const incoming = { title: "财务项目提成", description: "销售与财务项目提成", type: "Goal", category: "Career", horizon: "medium" };
  assert.equal(findExistingGoalMatch(incoming, [travel, closed]), null);
});

test("update-first merge preserves canonical identity and horizon unless explicitly changed", () => {
  const update = mergeGoalPlanUpdate(financeRoleGoal, {
    title: "财务以后自己开发的新项目也要有提成",
    description: "新开发项目的提成比例需要继续明确。",
    type: "Goal",
    category: "Personal",
    status: "Planning",
    horizon: "long",
    priority: "medium",
    notes: "",
  }, { horizon: false, status: false, priority: false });
  assert.equal(update.horizon, undefined);
  assert.equal(update.status, undefined);
  assert.match(update.description, /提成比例需要继续明确/);
  assert.equal("title" in update, false);
});

test("real database reads can filter medium-term goals without returning completed goals", () => {
  const goals = [
    financeRoleGoal,
    { ...financeRoleGoal, id: "long", title: "长期健康", horizon: "long" },
    { ...financeRoleGoal, id: "done", status: "Completed" },
  ];
  assert.deepEqual(filterGoalsForRead(goals, { horizon: "medium", query: "财务岗位转型" }).map((goal) => goal.id), [financeRoleGoal.id]);
});

test("complete operation changes state without creating a record", () => {
  assert.deepEqual(completeGoalPatch(), { status: "Completed", progress_percent: 100, archived_at: null });
});

test("failed or incomplete writes can never be reported as persisted", () => {
  assert.equal(isPersistedObjectResult(false, { success: true, id: "goal-1" }), false);
  assert.equal(isPersistedObjectResult(true, { success: false, id: "goal-1" }), false);
  assert.equal(isPersistedObjectResult(true, { success: true }), false);
  assert.equal(isPersistedObjectResult(true, { success: true, id: "goal-1" }), true);
});
