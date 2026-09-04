import test from "node:test";
import assert from "node:assert/strict";
import { goalPlanDispatchPayload, normalizeIntake } from "../supabase/functions/_shared/personal-os-intake.js";
import {
  completeGoalPatch,
  filterGoalsForRead,
  findExistingGoalMatch,
  mergeGoalPlanUpdate,
} from "../supabase/functions/_shared/goal-operations.js";

const baseDate = "2026-09-05T08:00:00+08:00";
const goalId = "11111111-1111-4111-8111-111111111111";
const summary = `随着业务流程和交付逐步自动化，财务岗位从传统执行岗位转型为“项目落地 + 客户财务沟通 + 销售拓展”的复合经营岗位。

财务人员一方面负责项目具体落地以及与客户财务部门沟通；另一方面承担销售任务，并主动开发新的业务项目。

对于财务人员新开发的项目，建立项目提成机制。

属于用户个人体系的新项目，不再默认向鲜伟等原有人员进行收益分配，而是按照项目归属及实际贡献重新设计利益分配。

基础薪酬可以考虑：公司承担 50%，用户个人承担 50%。

后续需要继续明确：岗位职责、销售指标、项目归属规则、项目提成比例、薪酬分摊、项目利润核算。`;

test("PRD conversation flow creates, updates, reads, separates Task, and completes one canonical Goal", () => {
  const create = normalizeIntake({
    raw_text: "我要把财务岗位转成销售+项目落地的复合岗位，把这个放进我的中期 Goal & Plan。",
    type: "goal",
    title: "财务岗位经营化转型",
    description: summary,
    horizon: "medium",
    status: "Planning",
    category: "Career",
  }, { baseDate });
  const created = { id: goalId, ...goalPlanDispatchPayload(create), updated_at: baseDate };
  assert.equal(created.horizon, "medium");
  assert.equal(created.status, "Planning");
  assert.equal(created.deadline, null);

  const followUp = normalizeIntake({ raw_text: "财务以后自己开发的新项目也要有提成。" }, { baseDate });
  const followUpPayload = goalPlanDispatchPayload(followUp);
  const match = findExistingGoalMatch({ ...followUpPayload, raw_text: followUp.raw_text }, [created]);
  assert.equal(match?.goal.id, goalId);
  const updated = { ...created, ...mergeGoalPlanUpdate(created, followUpPayload, followUp.explicit_fields) };
  assert.equal(updated.id, goalId);
  assert.equal(updated.horizon, "medium");

  const task = normalizeIntake({
    raw_text: "下周把财务销售提成方案整理出来。",
    goal_plan_id: goalId,
  }, { baseDate });
  assert.equal(task.type, "task");
  assert.equal(task.goal_plan_id, goalId);

  const read = filterGoalsForRead([updated], { horizon: "medium" });
  assert.deepEqual(read.map((goal) => goal.id), [goalId]);

  const completed = { ...updated, ...completeGoalPatch() };
  assert.equal(completed.id, goalId);
  assert.equal(completed.status, "Completed");
  assert.equal(completed.progress_percent, 100);
});
