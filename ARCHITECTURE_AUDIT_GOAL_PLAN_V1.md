# Personal OS Goal & Plan｜Existing Capability Map

审计日期：2026-09-05
范围：现有 Personal OS Web App、Supabase migrations / Edge Functions、Google Tasks、Google Calendar、Personal OS Intake 与 ChatGPT MCP。

## 结论

本需求可以通过扩展现有 Personal OS 链路完成，不需要第二套 Goal/Plan 数据库、页面、API、同步服务或自动化。Task 继续以 Google Tasks 为唯一真源，Calendar 继续只做时间投影。

## 现有能力回答

1. **Goal & Plan 当前存在哪里？** 现有 V1.2 工作稿已经选择 Supabase/PostgreSQL 的 `public.goals_plans` 作为长期规划唯一真源；GPT Memory 不属于正式数据。
2. **当前数据库表是什么？** `goals_plans` 保存 Goal/Plan；`projects` 保存阶段项目；`task_context_links` 只保存 Google Task 与 Goal/Project 的关系。任务正文和完成状态不复制进这三张表。
3. **前端从哪里读取？** `src/cloud-client.js` 的 `listGoals()` 通过现有 Supabase PostgREST `/rest/v1/goals_plans` 读取；`app.js` 的 `refreshTasks()` 与 Task 同步并行加载并渲染既有 `#goalsView`。
4. **是否已经存在 create/update/delete？** Web 客户端已有 `createGoal()` 与 `updateGoal()`；Complete/Archive 复用 status 更新。Goal 没有既有 Delete 权限或 UI，本 P0 不新增硬删除。
5. **是否已经存在 API？** 有。浏览器复用 Supabase PostgREST CRUD；自然语言写入复用 `personal-os-intake` Edge Function；ChatGPT 复用 `personal-os-mcp`。不需要新建 API 服务。
6. **GPT 当前能够调用哪些 Personal OS 写入接口？** 已部署基线包含 `create_task`；V1.2 工作稿已有 `capture_personal_os_item`，但审计时它只会新增 Goal。当前补丁在同一 MCP 内补齐真实 `get_goals`、`update_goal`、`complete_goal`，并把 capture 改为 update-first。
7. **Goal & Plan 和 Task 当前是什么关系？** `Goal / Plan → Project → Google Task → Calendar projection`。`task_context_links.google_task_id` 关联 `goal_plan_id` / `project_id`，Task 状态仍只来自 Google Tasks。
8. **是否已经存在 status / priority / horizon 等字段？** 已有 `status`、`priority`、`progress_percent`、`target_date/month/year`、`start_date`、`review_date`、`deadline`；审计时没有 `horizon`。增量 migration 只在原表增加 `short / medium / long`。
9. **是否存在重复数据模型？** 没有第二套 Goal 模型。旧 Postgres Task 表已撤销客户端权限，Google Tasks 是任务真源。多个本机 Git worktree 是开发隔离，不是业务数据源。
10. **实现本需求最少需要修改哪些文件？** 数据库：原 `goals_plans` 的增量 migration；语义：`action-router.js`、`personal-os-intake.js`、共享 Goal operation；写入：现有 `personal-os-intake/index.ts`；GPT：现有 `personal-os-mcp/index.ts`；前端：`src/goals.js`、`app.js`、`index.html`；验证：现有 test/verify 与部署文档。

## 已确认复用边界

- 不创建新 Goal/Plan 表。
- 不创建新 Task 表或复制 Google Task 状态。
- 不创建新页面；沿用 Goals 页面及其 Active / Planning / Someday / Financial / Completed 视图。
- 不创建 ChatGPT Scheduled Task。
- 不改变 Date 与 Deadline 语义。
- `source=chatgpt` 继续留在现有 Intake Audit；不为了 source 单独扩表。
- 同一请求重试继续由 `personal_os_intake_audit` 的 idempotency key 保护；跨对话同目标由保守语义匹配和显式 `existing_goal_id` 共同保护。

## 最小数据流

```text
Conversation
  → existing personal-os-mcp
  → existing personal-os-intake
  → match active goals (update first)
  → existing goals_plans table
  → existing PostgREST read
  → existing Goals Web UI
```
