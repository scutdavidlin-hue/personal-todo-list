# GPT / 晨会 / 夕会 API

所有接口都返回 JSON，并使用独立的自动化 Token。Token 只能放请求头或 Secret，不能放进网页、邮件正文或日志。

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

Task 会直接写入 Google Tasks。`calendar_event`、`project_data` 和 `note` 只返回分类结果，交给现有对应服务处理；不会误建 Google Task。

## 读取晨夕会状态

```bash
curl --fail-with-body \
  -H "Authorization: Bearer YOUR_AUTOMATION_READ_TOKEN" \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status?date=2026-09-04"
```

响应 `schema_version` 为 `2.0`，主要字段：

- `today_open`：今日未完成。
- `overdue_open`：逾期未完成。
- `priority_open`：高优先级未完成。
- `personally_required`：OAuth、验证码、登录、付款、最终审批等需本人处理事项。
- `today_completed`：今天真正勾选完成。
- `yesterday_completed`：昨天完成。
- `upcoming`：未来七天。
- `unscheduled`：未设置 Due Date。

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

- 晨会读取 `today_open`、`overdue_open`、`priority_open`、`personally_required` 和 `upcoming`。
- 夕会读取 `today_completed`、`today_open` 与 `overdue_open`；未完成任务保留原 ID，不重复创建。
- 每日简报只展示数量和摘要，点击后进入同一 Tasks 页面。
