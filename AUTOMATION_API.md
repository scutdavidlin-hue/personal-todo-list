# GPT / 晨晚会自动化 API

Edge Function：

`https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status`

所有响应均为 JSON，`Cache-Control: no-store`。Token 只放请求头，不放 URL、邮件正文或前端代码。

## 读取任务状态

```bash
curl --fail-with-body \
  -H "Authorization: Bearer YOUR_AUTOMATION_READ_TOKEN" \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status?date=2026-09-03"
```

不传 `date` 时，服务端按 `Asia/Shanghai` 当天计算。读取前会先执行幂等延续。

返回字段：

```json
{
  "schema_version": "1.0",
  "generated_at": "2026-09-03T00:00:00.000Z",
  "timezone": "Asia/Shanghai",
  "date": "2026-09-03",
  "counts": {
    "today_open": 2,
    "today_done": 1,
    "carryover_open": 1,
    "yesterday_completed": 3,
    "upcoming": 2
  },
  "today_open": [],
  "today_done": [],
  "carryover_open": [],
  "yesterday_completed": [],
  "recent_completed": [],
  "upcoming": []
}
```

任务对象包含：`id`、`title`、`date`、`time`、`category`、`priority`、`duration`、`notes`、`status`、`done`、`completed_at`、`created_at`、`updated_at`、`source`、`carried_from_date`。不会返回 `owner_id`。

## GPT/自动化新增任务

POST 必须使用独立的写 Token；读 Token 无权新增。

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer YOUR_AUTOMATION_WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "跟进客户报价",
    "date": "2026-09-03",
    "time": "10:30",
    "category": "工作",
    "priority": "high",
    "duration": 30,
    "notes": "来自 GPT 晨会"
  }' \
  "https://YOUR_PROJECT_REF.supabase.co/functions/v1/task-status"
```

服务端会强制 `owner_id=OWNER_USER_ID`、`source=gpt`、`status=open`，不会接受客户端覆盖这些安全字段。

## 晨会与晚会编排

- 05:00 晨会：GET 状态 → 使用 `carryover_open`、`today_open`、`yesterday_completed`、`upcoming` 生成邮件 → 邮件按钮指向正式 `today.html`。
- 21:00 晚会：GET 状态 → 使用 `today_done`、`today_open` 与 `recent_completed` 收口。
- GPT 对话识别出明确行动项：用户确认后使用写 Token POST；不要把 Token 暴露给模型输出、日志或网页。

推荐让 Gmail/定时器所在的自动化平台把 Token 作为 Secret 注入 HTTP 请求。读写 Token 可独立轮换，不影响用户网页登录。

## 状态码

- `200`：读取成功。
- `201`：任务创建成功。
- `400`：日期或任务输入无效。
- `401`：Token 缺失或错误。
- `405`：方法不允许。
- `429`：基础速率限制触发。
- `503`：服务端配置不完整或数据库暂时不可用。

