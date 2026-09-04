# PRD｜Personal OS 智能任务排程 × Calendar 完成状态 V1.1

项目：`personal-todo-list`  
日期：2026-09-04  
前置版本：`PRD_TASK_SYNC_V1.md`

## 1. 目标

把已经可真实创建、完成和恢复的 Google Task 安排到可执行的日期与时间，并在 Google Calendar 中形成唯一时间投影：

`GPT 收任务 → Schedule Metadata → Calendar 投影 → Google Task 完成 → Calendar 显示 ✓ → 晨晚会复盘`

Google Tasks 始终是任务内容与完成状态的唯一真源。Calendar Event 只表达“什么时候做”和“当时是否完成”，不是第二份 Task。

## 2. 数据边界

### Google Tasks（唯一任务真源）

- `task id`
- `title`、`notes`、`originalIntent`
- `open / completed`、`completed_at`
- 用户真正的 checkbox 状态

### Schedule Metadata（Task 的一对一附属信息）

- `google_task_id`（同一用户唯一）
- `scheduled_date`、`scheduled_start`、`scheduled_end`
- `timezone`、`duration_minutes`
- `scheduling_status`、`scheduling_source`
- `calendar_id`、`calendar_event_id`
- `fixed_time`、`priority`、`deadline`
- `sync_required`、`last_sync_error`、`last_synced_at`

`scheduling_source`：`explicit_user / gpt_inferred / morning_plan / rescheduled`。

Schedule Metadata 不保存 Task title、notes、open/completed 等任务真值。

## 3. Calendar Projection

- 小时级排程不写入 Google Tasks `due`；Google Tasks `due` 只保存日期。
- 有具体时间的 Task 在 Google Calendar `primary` 中建立一个投影 Event。
- Event 使用私有 extended property 保存 `googleTaskId` 与 `personalOsProjection=v1`。
- Event ID 由 Task ID 稳定派生；重试、改期和恢复只能更新原 Event，禁止重复创建。
- open：`☐ 标题`；completed：`✓ 标题`；重新安排：`↪ 标题`。
- 已完成 Event 保留在原位置，不删除。
- 固定时间事项不得被自动 Scheduler 移动。

## 4. Intake 规则

每次识别行动事项同时解析：

- `title`、`originalIntent`
- `deadline`
- `requested_date`、`requested_time`
- `estimated_duration`
- `priority`
- `fixed_time`

规则：

1. 明确日期和时间：严格按用户时间创建 Task + Schedule。
2. 明确日期、无时间：写 Task 日期，进入晨会待排程池。
3. 有截止时间：保存 deadline，由 Scheduler 向前安排。
4. 无日期：进入 Backlog，不批量塞进 Today。
5. 航班、会议、预约、酒店等外部固定事项继续走原生 Calendar Event，不创建 Task 投影。

## 5. Morning Scheduler

每天 05:00 在晨会生成前运行。输入包括 open/overdue/昨日未完成/未来三天 Tasks、现有 Schedule 与 Calendar 占用时段。

优先级：固定时间 → deadline → 高优先级 → 等待/依赖 → 普通任务 → Backlog。

首版采用保守规则：

- 固定时间原样保留。
- 已有非固定投影优先原地保留；逾期且仍 open 时再寻找下一可用时段。
- 今天到期且尚无时刻的 Task，按 duration 放入当天空档；超出当日容量则顺延。
- 无日期 Task 保留 Backlog。
- 默认排程窗口为 09:00–21:00，并避开 Calendar 已有 Event。

## 6. 同步与幂等

- 创建/改期：upsert 同一 Schedule 行并 upsert 同一稳定 Event ID。
- 完成/恢复：先以 Google Tasks 写入结果为准，再更新同一 Event 前缀。
- 外部在 Google Tasks 完成的事项由 Scheduler reconciliation 补同步。
- Calendar 临时失败时保留 `sync_required=true` 和错误，后续重试；不得回滚真实 Task checkbox。
- 取消 Task 时保留历史 Event，并标记 `✕`，不制造新 Task。

## 7. 晨会 / 夕会

晨会输出：Today、Tomorrow、Next 3 Days、Backlog / Waiting，并显示 `✓ / ☐ / ↪ + 时间 + 事项`。

夕会输出：计划、完成、延期、取消数量；未完成事项进入下一次 Scheduler 判断，不复制 Task。

## 8. Phase

1. Schedule Metadata 数据模型。
2. Task ↔ Calendar Projection。
3. Task completion → Calendar ✓ 同步。
4. 日期/时间 Intake Parser。
5. Morning Scheduler。
6. 晨会 / 夕会重新排程闭环。
7. iPhone Google Tasks + Google Calendar 真机验收。

## 9. 验收标准

1. GPT 创建“明天下午 3 点做 A”后，Google Tasks 存在 A。
2. Calendar 明天 15:00 只出现一个 A 投影。
3. 完成 A 后，Calendar 原位置保留并显示 `✓`。
4. 晚会把 A 计为已完成，第二天不再进入未完成池。
5. 改时间只移动原 Event。
6. 无日期 Task 不全部进入 Today。
7. 航班/会议等固定时间不被 Scheduler 移动。
8. 重放相同 intake 或 schedule 请求不产生重复 Task/Event。

## 10. 非目标

- 不开发新的 Calendar App。
- 不复制 Google Tasks 成第二数据库。
- 不重做已通过验收的 Task completion 基础设施。
- 不以删除线效果阻塞稳定闭环。
- 不在本阶段建设复杂项目管理系统。

## 11. 平台限制

- Google Tasks API 的 `due` 会丢弃时间部分，因此具体时刻只能投影到 Calendar Event。
- 截至 2026-09-04，ChatGPT 自定义 MCP App 官方仍仅支持网页端；iPhone 验收范围是 Google Tasks / Google Calendar 的跨端结果，不包含在 iPhone ChatGPT 内直接调用自定义 MCP。
