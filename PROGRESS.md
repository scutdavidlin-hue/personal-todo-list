# 开发进度

最后更新：2026-09-05

## V1.2｜Goals & Plans

- [x] 新增 `goals_plans`、`projects`、`task_context_links`；Goal 删除不随 Task 完成发生，Google Tasks 仍是行动真源。
- [x] 支持 8 种长期事项类型、11 个类别、8 个状态和 priority / progress / review。
- [x] 支持 `target_date / target_month / target_year` 三种精度及独立 `deadline`，不再用 12 月 31 日伪装年度目标。
- [x] 支持 Receivable / Payable / Budget / SavingGoal / InvestmentGoal 与数据库自动余额。
- [x] 新增 Goals 一级导航、Active / Planning / Someday / Financial / Completed 分区和完整 Goal Detail。
- [x] Goal 可创建 Project、关联已有 Google Task、创建下一步 Task，并显示未完成 Task 数和下一行动。
- [x] GPT Router / Intake / MCP 支持 Task / Goal / Plan / LongTermItem / FinancialItem 自动分类并保留原始输入与 Why。
- [x] PWA manifest、四套安装图标、Service Worker、Standalone、Safe Area 和移动端底部导航。
- [x] 本地桌面与 390×844 iPhone 视口视觉验收通过，登录页控制台 0 error / 0 warning。
- [x] 最终回归 72 tests，0 fail；V1.2 三个入口通过 Deno 类型检查。
- [x] Supabase 预演确认只新增 `202609040003_goals_plans_v1_2.sql`，迁移已应用；现有 `202609040004_task_lifecycle_v1_2.sql` 未重放或改写。
- [x] `action-router`、`personal-os-intake`、`personal-os-mcp` 已部署并处于 ACTIVE；MCP 健康端点回报 `1.2.0`。
- [ ] 正式前端发布、ChatGPT App tools 刷新与 iPhone 添加到主屏幕最终验收。

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

- [x] V1.0/V1.1 自动回归（51 tests；0 fail）。
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
