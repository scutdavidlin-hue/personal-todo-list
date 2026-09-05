# Smart Reminder Policy Engine V1.0｜架构与实现

## 结论

选择 `EXTEND`：复用既有 Google Tasks 真源、`task_schedule_metadata`、确定性 Calendar Event ID、Task Scheduler、统一 Intake 与 MCP。提醒是 Schedule 上的策略元数据，最终成为同一 Google Calendar Event 的 `reminders.overrides`。

未引入新服务、依赖、Task 表、Reminder 表、Cron、APNs 或第二通知源。完整选型证据见 `docs/reuse-first-smart-reminder-policy.json`。

## 数据流

```text
Natural Language / Frontend / MCP
            │
            ▼
   Resolve Before Create
            │
            ▼
  canonical Google Task ID
            │
            ▼
 normalizeScheduleInput
            │
            ├─ execution / deadline anchor
            └─ resolveReminderPolicy
                    │
                    ├─ explicit user override
                    ├─ semantic smart inference
                    └─ no-reminder spam guard
            │
            ▼
 task_schedule_metadata UPSERT
 (owner_id, google_task_id unique)
            │
            ▼
 Calendar PATCH stable event ID
            │
            └─ reminders.useDefault=false
               reminders.overrides=0..3
```

## 策略核心

`supabase/functions/_shared/reminder-policy-core.js` 是无依赖、Node/Deno 共用的纯逻辑层：

- 解析用户明确的提醒时刻或提前量；
- 识别明确的“不提醒”；
- 识别 meeting、flight、train、follow-up、deadline 与普通 Todo；
- 提取起床、早餐、运动、洗漱、换衣、材料、设备与行李等前置行动；
- 推断 metro、bus、taxi、drive、walk、train、airport 或通用 transit；
- 计算 preparation / departure / event offsets；
- 排序、去重并限制最多 3 个提醒；
- 生成可审计的 reason/context 和 Calendar overrides。
- 把压缩后的行动提示附到同一个 Calendar Event summary，完整指引保留在 description，以提高锁屏通知可见性。

显式用户时间的优先级高于所有语义默认。Offset 是 Calendar 投影的规范值；`reminder_at` 是便于查询和解释的本地墙钟快照。

## Schedule 扩展

迁移 `202609050003_smart_reminder_policy_v1.sql` 只 ALTER 现有表。原唯一约束保持不变：

```sql
unique (owner_id, google_task_id)
```

主提醒字段保存最早需要行动的 reminder；`reminders` 保存最多三个 overrides。`reminder_context` 只保存执行上下文，不保存 Task title 或完成状态。

## Update-first 与 ID 稳定

`update_task_reminder` / `update_reminder`：

1. GET 已有 Google Task，不调用 Task insert。
2. 读取同一 `(owner_id, google_task_id)` Schedule。
3. merge reminder input 后 UPSERT 同一 Schedule row。
4. 运行时检查已有 `schedule_id` 未变化。
5. 以 Task ID 派生同一 `calendar_event_id`。
6. PATCH 同一 Event；只有 Event 不存在时才用同一指定 ID 恢复插入。
7. 返回 `google_tasks_count_delta: 0` 与三个 identity flags。

任何 ID 意外变化都会以 `SCHEDULE_IDENTITY_CHANGED` 或 `CALENDAR_EVENT_IDENTITY_CHANGED` 失败，不会静默复制。

## Deadline 投影

若有执行区间，Calendar Event 投影执行区间。若仅有精确 Deadline，唯一 Event 以 Deadline 为 5 分钟锚点，Title 标注“截止”。两种情况都使用同一个稳定 Event ID。

Google Calendar 的 override 是相对 Event start 的提前分钟数。若同一 Task 同时有更早执行区间和更晚 Deadline，V1 保留真实执行 Event；它不能通过 Calendar override 表达 Event 开始之后的截止提醒，也不会创建第二个虚假 Event。需要该能力时应设计经批准的独立投递通道，而不是破坏 `1 Task → 1 Schedule → 1 Event`。

## 通知状态语义

- `not_required`：普通 Todo 或没有精确时间。
- `pending_projection`：策略已算出，等待 Calendar 写入。
- `projected`：Google Calendar API 已接受 Event payload。
- `projection_failed`：Calendar 写入失败，可重试。
- `disabled`：用户明确关闭或事项已取消。

Google Task 完成时也按 `disabled` 投影并清空 Event overrides，避免已经完成的事项继续通知；重新打开后，同一 Schedule 上的原策略可再次投影。

这里没有 `delivered`：Google Calendar Events API 不提供 iPhone 锁屏实际送达回执。

## 安全与隐私

- 继续使用现有 Google OAuth `calendar.events` 和 Tasks scope。
- 不新增 OAuth scope、Secret、设备 token 或第三方网络目的地。
- Schedule 表继续只允许 service role 写入；前端不能绕过策略直接改私有元数据。
- Calendar Event private extended properties 仅保存 canonical `googleTaskId` 和投影版本/策略标记。

## 验证

自动化覆盖：

- 明确提醒优先；
- 机场与通勤推断；
- 普通 Todo spam protection；
- 当前祥晖案例；
- Task/Schedule/Event ID 不变量；
- Google Tasks 数量不增加；
- popup Calendar payload；
- Deadline 分离；
- 重排时间后 offset 稳定、`reminder_at` 重算；
- migration 不创建 Task/Reminder 表。

本地结果：`npm run verify` 191/191；57 个必需文件与 95 个仓库文件静态/Secret 扫描；6 个 Edge Function 入口通过 TypeScript 语法检查；Reuse First acceptance gate 与 registry 回读通过。

Supabase remote migration dry-run 已调用 CLI 2.116.0，但当前隔离工作区没有 CLI access token，因此在认证前退出且没有生产写入。发布前仍须在已登录环境完成 dry-run。

真实 iPhone 到达属于部署后 E2E：需要 migration、Edge Functions、MCP tool refresh、Google Calendar App 通知权限以及一次未来时刻的真机观察。
