# Personal OS · Goals & Plans × Google Tasks × Calendar

一个以聊天为输入、以手机为主要入口的个人行动与长期规划系统。所有需要完成并打勾的行动仍以 **Google Tasks** 为唯一真源；Goals & Plans 在 Supabase 中保存长期方向、计划、持续事项和财务事项，Calendar 只投影有明确执行时间的 Task。

V1.1 增加一对一 Schedule Metadata 与 Google Calendar 时间投影。Calendar 不保存第二份任务状态：它只显示什么时候做，并在 Google Task 完成后把同一个 Event 更新为 `✓`。

V1.2 新增 Goals & Plans 长期规划层：`Goal / Plan → Project → Task → Calendar`。Goal 本身不会因为 Task 完成而消失，也不会因为只给出年份或月份就被伪造成截止日。

## 已实现

- 一级 Goals 页面：Active、Planning、Someday、Financial、Completed 分区，支持搜索、创建、编辑和详情。
- `goals_plans` 数据层：Goal、Plan、LongTermItem、FinancialItem、Idea、LifePlan、BusinessPlan 与 FamilyPlan。
- 精确区分 `target_date / target_month / target_year / review_date / deadline`，未声明硬截止时不生成 Deadline。
- 财务持续事项保存总额、已完成金额、自动余额、币种、对手方和 Receivable / Payable / Budget / SavingGoal / InvestmentGoal。
- Goal 可关联多个 Project 和 Google Task；关联只保存外部 Task ID，不复制 Google Tasks 的内容或完成状态。
- Goal Detail 展示 Overview、Why、进度、Projects、Tasks、Notes 和 Financial；可直接创建或关联下一步行动。
- PWA manifest、应用图标、Service Worker、离线 App Shell、Standalone、Safe Area 和 iPhone 响应式底部导航。
- Google OAuth 登录一次完成 Tasks + Calendar Event 授权；scope 为 `tasks` 与 `calendar.events`。
- Google Tasks API v1：创建、查询未完成、完成/恢复、修改标题/说明/日期、删除。
- Task Lists API：列出清单；优先使用 `Personal OS`，不存在时自动创建。
- 清晰客户端 API：`listTaskLists`、`createTask`、`listOpenTasks`、`completeTask`、`reopenTask`、`updateTask`、`deleteTask`。
- 统一 Task Model：保留 `externalId`、`taskListId`、`dueDate`、`completedAt`、`originalIntent`、项目关联与 metadata 扩展位。
- Action Router：自然语言可识别 `task / goal / plan / long_term_item / financial_item / contact / client / calendar_event / project_data / knowledge / gpt_job`；只有 Task 自动写入 Google Tasks。
- Personal OS Intake Gateway：`task` 写入 Google Tasks；`goal / plan / long_term_item / financial_item` 写入 Goals & Plans；未配置的其他 Adapter 明确失败，不伪造成功。
- 数据库级 idempotency key 与持久 Audit Log；重试复用原响应，不会重复创建 Task。
- 远程 MCP：通过 `personal-os-mcp/mcp` 暴露 `create_task` 与 `capture_personal_os_item`；后者自动判断 Task、Goal、Plan、持续事项和财务事项，并保留原始输入。
- 智能 Intake 解析 `requested_date / requested_time / deadline / estimated_duration / priority / fixed_time`。
- `task_schedule_metadata` 只保存排程字段，以 `(owner_id, google_task_id)` 唯一绑定，不保存 Task title 或完成状态。
- `task-scheduler` 使用 Task ID 派生稳定 Calendar Event ID；创建、重试、改期都 upsert 同一 Event。
- Calendar 投影使用 `☐ / ✓ / ↪ / ✕`，完成 Event 保留；Personal OS 的 checkbox、恢复、改名和取消立即触发同步，Google Tasks 原生界面的外部修改由 Scheduler reconciliation 校正。
- Morning Scheduler 避开 Calendar 已有事件、尊重固定时间和每日容量；无日期 Task 保留 Backlog。
- 状态接口新增 Today Plan、Tomorrow、Next 3 Days、Backlog、Waiting 与 evening summary。
- 创建前语义去重：相同未完成事项更新原 Task，不重复创建。
- Google provider 刷新令牌仅在回调页短暂停留，随后由 Edge Function 使用 AES-256 加密保存；不进入 localStorage 或 Git。
- checkbox 真正写入云端；失败时恢复原状态并提示，杜绝“假完成”。
- 新增、编辑、删除、恢复未完成、移到明天。
- 桌面及手机页面按 Today、Overdue、Upcoming、Completed 展示，checkbox 适配 iPhone 点击。
- Google Tasks 日期只保存自然日，不伪装成固定时刻；会议、行程、预约和固定时间块仍属于 Google Calendar Event。
- 两套旧 localStorage 的一次性、可重试、去重迁移；已知 sampleTasks 自动排除。
- 最近云端快照只作离线只读缓存。
- 每日小结同步到云端。
- GPT/自动化 GET 状态接口与 POST 新任务接口，读写 Token 分离。
- 晨会与夕会读取今日、逾期、高优先级、需本人处理和当天完成状态，不维护第二套 Todo。
- 旧 Postgres `tasks` 表已撤销客户端权限，避免双真源；RLS、服务端 Secret 边界、基础限流与全仓 Secret 扫描继续保留。

## 页面

- `index.html`：Today、Tasks、Goals、Progress 的完整桌面/响应式管理页。
- `today.html`：Gmail 中“☑️ 打开今日任务”应指向的手机页。
- `manifest.webmanifest` + `sw.js`：HTTPS 部署后可从 iPhone Safari 添加到主屏幕。

## 本地检查

```bash
npm run verify
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4173/` 或手机页 `http://127.0.0.1:4173/today.html`。

## 文档

- [正式需求](PRD_TASK_SYNC_V1.md)
- [V1.1 排程需求](PRD_TASK_SCHEDULING_V1_1.md)
- [V1.2 Goals & Plans 需求](PRD_GOALS_PLANS_V1_2.md)
- [产品原则](PRODUCT.md)
- [实施计划](IMPLEMENTATION_PLAN.md)
- [部署说明](DEPLOYMENT.md)
- [自动化 API](AUTOMATION_API.md)
- [验收记录](ACCEPTANCE.md)
- [开发进度](PROGRESS.md)
- [需用户介入事项](OPEN_QUESTIONS.md)
- [ChatGPT MCP 接入](MCP_INTEGRATION.md)

## 安全说明

`runtime-config.js` 中的 Supabase Project URL 与 anon/publishable key 是公开客户端配置，不是管理员密钥。绝不能把 Google OAuth Client Secret、刷新令牌、`GOOGLE_TOKEN_ENCRYPTION_KEY`、service role key、自动化 Token 或 GitHub PAT 写入前端源码或 Git。
