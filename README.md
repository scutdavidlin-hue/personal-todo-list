# Personal OS · Google Tasks × Calendar 排程

一个保留原有界面、以手机为主要入口的个人任务系统。所有需要完成并打勾的行动以 **Google Tasks** 为唯一真源；Supabase 只负责账号会话、加密 OAuth 凭证、每日小结和服务端代理。

V1.1 增加一对一 Schedule Metadata 与 Google Calendar 时间投影。Calendar 不保存第二份任务状态：它只显示什么时候做，并在 Google Task 完成后把同一个 Event 更新为 `✓`。

## 已实现

- Google OAuth 登录一次完成 Tasks + Calendar Event 授权；scope 为 `tasks` 与 `calendar.events`。
- Google Tasks API v1：创建、查询未完成、完成/恢复、修改标题/说明/日期、删除。
- Task Lists API：列出清单；优先使用 `Personal OS`，不存在时自动创建。
- 清晰客户端 API：`listTaskLists`、`createTask`、`listOpenTasks`、`completeTask`、`reopenTask`、`updateTask`、`deleteTask`。
- 统一 Task Model：保留 `externalId`、`taskListId`、`dueDate`、`completedAt`、`originalIntent`、项目关联与 metadata 扩展位。
- Action Router：自然语言统一分类为 `task / calendar_event / project_data / note`；Task 自动写入 Google Tasks。
- Personal OS Intake Gateway：统一接收 `task / calendar_event / project_data / knowledge / gpt_job`，Task 成功写入 Google 后才返回 `success:true`。
- 数据库级 idempotency key 与持久 Audit Log；重试复用原响应，不会重复创建 Task。
- 远程 MCP：通过 `personal-os-mcp/mcp` 暴露聚焦的 `create_task` 工具，使用 Supabase Auth OAuth 2.1 验证 ChatGPT 用户。
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

- `index.html`：完整桌面/响应式管理页。
- `today.html`：Gmail 中“☑️ 打开今日任务”应指向的手机页。

## 本地检查

```bash
npm run verify
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 `http://127.0.0.1:4173/` 或手机页 `http://127.0.0.1:4173/today.html`。

## 文档

- [正式需求](PRD_TASK_SYNC_V1.md)
- [V1.1 排程需求](PRD_TASK_SCHEDULING_V1_1.md)
- [实施计划](IMPLEMENTATION_PLAN.md)
- [部署说明](DEPLOYMENT.md)
- [自动化 API](AUTOMATION_API.md)
- [验收记录](ACCEPTANCE.md)
- [开发进度](PROGRESS.md)
- [需用户介入事项](OPEN_QUESTIONS.md)
- [ChatGPT MCP 接入](MCP_INTEGRATION.md)

## 安全说明

`runtime-config.js` 中的 Supabase Project URL 与 anon/publishable key 是公开客户端配置，不是管理员密钥。绝不能把 Google OAuth Client Secret、刷新令牌、`GOOGLE_TOKEN_ENCRYPTION_KEY`、service role key、自动化 Token 或 GitHub PAT 写入前端源码或 Git。
