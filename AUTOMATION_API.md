# GPT / 晨会 / 夕会 API

所有接口都返回 JSON，并使用独立的自动化 Token。Token 只能放请求头或 Secret，不能放进网页、邮件正文或日志。

## Personal OS 统一写入入口

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer YOUR_AUTOMATION_WRITE_TOKEN" \
  -H "Idempotency-Key: chatgpt-CONVERSATION-TURN" \
  -H "Content-Type: application/json" \
  -d '{
    "source":"chatgpt",
    "raw_text":"明天提醒我安排小青蛙寄养。",
    "type":"task",
    "title":"安排小青蛙寄养",
    "notes":"联系乔治安排寄养。",
    "due":"2026-09-05",
    "timezone":"Asia/Shanghai"
  }' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/personal-os-intake"
```

只有 Google Tasks 返回真实对象后才会得到 `success:true`。相同 idempotency key 与相同请求会重放首次响应；同一个 key 用于不同请求会返回 `409`。每次请求都写入仅 service role 可访问的 `personal_os_intake_audit`。

普通 Task 已接通 `Google Tasks + 可选 Schedule/Calendar 投影`。其他四类会正确分类并明确返回 `success:false`、`ADAPTER_NOT_CONFIGURED`，不会伪造已写入。

明确时刻的 Task 可附加：

```json
{
  "requested_date": "2026-09-05",
  "requested_time": "15:00",
  "estimated_duration": 30,
  "priority": "high",
  "fixed_time": true
}
```

只有 Task 与 Calendar 投影都成功时，带具体时刻的 intake 才返回 `success:true`。Calendar 临时失败会留下 `sync_required=true` 供重试，不会复制 Task。

## 自然语言分流

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer YOUR_AUTOMATION_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"周日提醒我收拾东北旅行的行李"}' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/action-router"
```

统一输出：

```json
{
  "type": "task",
  "confidence": 0.97,
  "payload": {
    "title": "收拾东北旅行的行李",
    "dueDate": "2026-09-06",
    "originalIntent": "周日提醒我收拾东北旅行的行李"
  },
  "dispatched": true,
  "result": {
    "task": {},
    "deduplicated": false
  }
}
```

Task 会直接写入 Google Tasks。`calendar_event`、`project_data`、`knowledge` 和 `gpt_job` 只返回分类结果，交给现有对应服务处理；不会误建 Google Task。

## 读取晨夕会状态

```bash
curl --fail-with-body \
  -H "Authorization: Bearer YOUR_AUTOMATION_READ_TOKEN" \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status?date=2026-09-04"
```

响应 `schema_version` 为 `3.0`。除 V1 字段外新增：

- `today_open`：今日未完成。
- `overdue_open`：逾期未完成。
- `priority_open`：高优先级未完成。
- `personally_required`：OAuth、验证码、登录、付款、最终审批等需本人处理事项。
- `today_completed`：今天真正勾选完成。
- `yesterday_completed`：昨天完成。
- `upcoming`：未来七天。
- `unscheduled`：未设置 Due Date。
- `today_plan`：今天有 Schedule 的计划，包含完成项。
- `tomorrow`：明天计划。
- `next_three_days`：后两日至未来三天计划。
- `backlog` / `waiting`：未占用 Calendar 的事项。
- `evening_summary`：今天 planned / completed / rescheduled / cancelled。

任务对象使用统一模型：`id`、`externalId`、`provider`、`taskListId`、`title`、`notes`、`status`、`dueDate`、`completedAt`、`originalIntent`、`priority` 和 `metadata`。状态只使用 `open / completed / cancelled`。

## 直接创建任务

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer YOUR_AUTOMATION_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"查看域名审核结果",
    "dueDate":"2026-09-13",
    "notes":"域名审核预计需要 3～5 个工作日，届时确认审核状态。",
    "originalIntent":"域名可能下周末完成审核，到时候提醒我查看。"
  }' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status"
```

创建前会检查未完成任务。标题语义、日期与状态确认是同一事项时，更新原 Task 并返回 `deduplicated: true`。

## 编排规则

- 现有 05:00 晨会流程先 `POST task-scheduler`：`{"action":"run","date":"YYYY-MM-DD"}`，再读取 `task-status`。
- 晨会优先读取 `today_plan`、`tomorrow`、`next_three_days`、`backlog` 和 `waiting`；兼容字段继续保留。
- 夕会读取 `evening_summary`、`today_plan` 与 `overdue_open`；未完成任务保留原 ID，不重复创建。
- 每日简报只展示数量和摘要，点击后进入同一 Tasks 页面。

直接排程/改期使用 `task-scheduler`：

```bash
curl --fail-with-body -X POST \
  -H "Authorization: Bearer YOUR_AUTOMATION_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"schedule","task_id":"GOOGLE_TASK_ID","schedule":{"scheduled_date":"2026-09-05","scheduled_start":"15:00","duration_minutes":30,"scheduling_source":"explicit_user","fixed_time":true}}' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-scheduler"
```
