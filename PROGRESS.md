# 开发进度

最后更新：2026-09-04

## 已完成

- [x] 从正式 `personal-todo-list` Git 仓库建立当前工作区，并合并已有 Google Tasks 草稿。
- [x] Google OAuth 复用 Supabase Auth；支持保留现有 Calendar scope 并追加 Tasks scope。
- [x] Google Tasks API：Task Lists、创建、筛选未完成、完成、恢复、修改、删除。
- [x] 优先复用 `Personal OS` 清单；不存在时创建。
- [x] 统一 Task Model 与 `originalIntent` 持久化。
- [x] 服务端语义去重；命中后更新原 Task，不复制。
- [x] Action Router：Task / Calendar Event / Project Data / Knowledge / GPT Job。
- [x] 桌面及手机页面：Today / Overdue / Upcoming / Completed。
- [x] 晨会、夕会、每日简报状态接口改读 Google Tasks。
- [x] 超时、授权失效、scope 缺失、API 未启用、限流、外部删除和同步失败处理。
- [x] 域名审核提醒已纳入 Router 与真实验收清单。
- [x] 清点 Gmail 晨会、夕会、每日简报与提案/待办关键词，按 Task / Calendar / Project Data / Note 分类。
- [x] 将 27 条有效行动写入现有 `Personal OS` Google Tasks；连同首批任务与 Issue #1 验收项共 31 条未完成事项，重复标题为 0。
- [x] 原行李 Task 追加“呼吸机”，没有为同一旅行准备事项创建第二条任务。
- [x] 新增统一 Personal OS Intake Gateway，覆盖五类输入并只对 Task 执行 Google Tasks 写入。
- [x] 新增数据库级 idempotency key、请求哈希冲突检测、响应重放与持久 Audit Log。
- [x] 新增基于 Supabase Auth OAuth 2.1 的远程 MCP `create_task` 工具与授权同意页。

## 最终验收

- [x] 最终自动回归（51 tests；0 fail）。
- [x] 现有 Google Cloud / Supabase 一次性配置、数据库迁移、Functions 部署与 OAuth consent。
- [x] 创建并核验 31 条真实未完成任务；完成日期、说明、originalIntent、去重、分流、完成与恢复的云端验收。
- [x] Mac 页面真实显示、checkbox 完成同步与恢复验收。
- [x] 在 ChatGPT Developer mode 注册并连接 MCP；App ID `asdk_app_6a9ab767459c8191934b1ec76be1378e`，`create_task` 工具发现成功。
- [x] ChatGPT 网页端真实调用 `create_task`，Google Tasks 回读到“完成 Personal OS V1 MCP 真实调用验收”（Due 2026-09-05）。
- [x] iPhone 真机确认 Google Tasks / Google Calendar 跨设备结果正确。

## V1.1｜智能排程 × Calendar 投影

- [x] 固化 `PRD_TASK_SCHEDULING_V1_1.md`，确认 Google Tasks 是唯一任务/完成状态真源。
- [x] 确认 Calendar Event 是时间投影，并以稳定 Event ID + `googleTaskId` 私有扩展属性保证幂等。
- [x] Phase 1：Schedule Metadata migration 已部署；`(owner_id, google_task_id)` 唯一，未复制 Task 状态。
- [x] Phase 2：`task-scheduler` 与稳定 Calendar Event ID 已部署；改期 upsert 同一 Event。
- [x] Phase 3：完成/恢复/改名/取消触发投影同步；失败保留 `sync_required`。
- [x] Phase 4：日期/时间/deadline/duration/priority/fixed_time Intake Parser 与 MCP schema。
- [x] Phase 5：Morning Scheduler 核心已实现并部署，避开 busy Event、限制 09:00–21:00、无日期留 Backlog。
- [x] Phase 6：`task-status` schema 3.0 提供 Today/Tomorrow/Next 3 Days/Backlog/Waiting 与夕会统计。
- [x] Phase 7：migration/functions 部署、Calendar OAuth、Mac 端 `☐→✓`、ChatGPT App tools 刷新、Web ChatGPT → Task → Calendar 与 iPhone 跨设备结果验收全部通过。

## V1.1 验证

- [x] `npm run verify`：51 tests，0 fail；静态检查与 Secret 扫描通过。
- [x] 6 个受影响 Edge Functions 通过 Deno 类型检查。
- [x] 线上 `task-status` schema 3.0 生效；2026-09-04 22:42 Personal OS 回读为 27 个 open Tasks（Today 2、未来/待安排 25、Overdue 0），已完成验收项不再进入未完成池。
- [x] Google Calendar API 已在现有 Google Cloud 项目启用；缺 API 与缺 scope 分别返回 `CALENDAR_API_DISABLED` / `CALENDAR_SCOPE_MISSING`，不伪造成功。
- [x] MCP 验收 Task 已投影到 2026-09-05 15:00–15:30；Calendar 中只有一个稳定 Event `pos18ea83471493168c9aa7bee962ae96f08765a4b1`。
- [x] 完成回调重新部署后，真实执行“恢复 → 完成”；同一 Calendar Event 自动完成 `✓ → ☐ → ✓`，Schedule 行保持 `sync_required=false`、`last_sync_error=null`。
- [x] ChatGPT Personal OS App 刷新成功；页面显示“操作已刷新”，`create_task` 已读取明确时间时传 `requested_date/requested_time` 并创建唯一 Calendar 投影的 V1.1 描述。
- [x] Web ChatGPT 真实创建 `验收 V1.1 ChatGPT 排程`（Task `OXJReEgwS25DRnVxS3p5dw`），排到 2026-09-05 16:00–17:00；Calendar 仅有 Event `pos8e2f3519d8021f1e3607ac0d9984fab1a9c4586c`，`sync_required=false`、`last_sync_error=null`。
- [x] 通过现有已认证 Personal OS 页面完成无人值守验收 Task `NWczWTZfS1JJdEJXNWNpWg`；Google Tasks 进入 Completed，同一 2026-09-04 23:00–23:30 Calendar Event `pos75397454c9c6f82a1c18d7415663180b0d2ff1f1` 原位显示 `✓`，未新建 Task/Event。
- [x] 原 ChatGPT Scheduled Task `5点GPT晨会邮件`（ID `6a950e48fcb081919192fc5b2357097f`）已核对：每天 05:00，现有提示词已严格先运行 `task-scheduler`、失败重试一次，再读取 `task-status`；没有新建或改动其他自动化。
- [x] 用户已在 iPhone Google Tasks 与 Google Calendar 真机确认未完成及已完成两组 Task/Event 的跨设备显示正确；V1.1 最终验收通过。

## 已确认限制

- V1.0 没有 Google Calendar 写入实现；V1.1 只新增 Task 的时间投影，不另建 Calendar App 或第二任务库。
- Google Tasks API 的 `due` 只保存日期；具体时刻由 Calendar Event 承担。
- ChatGPT 自定义 MCP App 官方目前仅支持网页端；iPhone 只验收 Google Tasks / Calendar 的跨端结果。
- `runtime-config.js` 只含公开的 Supabase URL 与 anon key；OAuth Client Secret、刷新令牌、加密密钥、service role key 和自动化 Token 均不在前端或 Git 中。
- Postgres 不再保存第二套任务池；Google Tasks 是唯一任务状态真源，Supabase 只保存每日小结和加密后的 OAuth 凭证。

## Goal & Plan 对话桥接 V1.0｜2026-09-05

- [x] 先完成 Existing Capability Map；确认只扩展现有 Goal/Plan、Intake、MCP 与 Goals Web UI。
- [x] 在现有 `goals_plans` 增量增加 `horizon`，未创建第二套 Goal 数据模型。
- [x] 对话分类支持显式 Goal/Plan 语义，用户明确要求入库时不重复确认。
- [x] Intake 改为 update-first：显式 `existing_goal_id` 优先，否则对 active goals 做保守语义匹配。
- [x] MCP 补齐真实 `get_goals`、`update_goal`、`complete_goal`，查询不依赖 GPT Memory。
- [x] Goal→Task 复用 Google Tasks 与 `task_context_links`，没有复制 Task 状态。
- [x] 写入反馈严格区分 created / updated / failed；失败不伪装成功。
- [x] `财务岗位经营化转型` 已真实创建并完成 Update、Read、Complete/Restore、Failure E2E。
- [x] 关联 Task `整理财务销售提成方案` 已进入现有 Google Tasks 流程并关联唯一 Goal。
- [x] 本地 Goals 页面与浏览器控制台验收通过。
- [x] 现有 GitHub Pages 已发布 Goals UI；已认证页面真实同步并显示目标、`中期` horizon 与关联下一步 Task。
- [x] 自动回归 85 tests / 0 fail，既有 Task、Calendar、晨会、夕会核心规则无 regression。
