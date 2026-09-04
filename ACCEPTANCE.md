# Personal OS × Google Tasks 验收记录

日期：2026-09-05

`PASS (cloud)` 表示已在目标 Google / Supabase 账号真实调用验证；`PASS (local)` 表示自动测试或本地实现验证；`PASS (device)` 表示用户已在 iPhone 真机确认。

## V1.2 Goals & Plans 验收

| # | 验收项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 新增 Goals 页面 | PASS (local + visual) | 一级导航、五个分区、搜索、统计卡片和详情页均已实现。 |
| 2 | 可创建 Goal / Plan | PASS (local + cloud schema) | 表单与写入客户端已实现；`goals_plans` migration 已部署。 |
| 3 | Goal 可以关联 Task | PASS (local + cloud schema) | `task_context_links` 关联 Google Task ID；不复制 Task 内容或状态。 |
| 4 | Goal 可以关联 Project | PASS (local + cloud schema) | 可在 Goal Detail 创建 Project，归属校验由数据库触发器保证。 |
| 5 | 支持 target date，不强制 Deadline | PASS (local + cloud schema) | 日期、月份、年份互斥；Deadline 独立且可为空。 |
| 6 | 支持 Financial Item | PASS (local + cloud schema) | 总额、已完成金额、币种、对手方、类型和自动余额均已实现。 |
| 7 | 应收显示总额、已收与余额 | PASS (local + visual) | 卡片与详情均显示财务进度，余额为数据库生成列。 |
| 8 | Task 完成不会删除 Goal | PASS (local + schema) | Task 真源与 Goal 分离；关系行没有任何级联删除 Goal 的路径。 |
| 9 | 手机端正常显示 | PASS (local + visual) | 390×844 视口通过；底部导航、卡片、详情无横向溢出。 |
| 10 | 支持安装为 iPhone PWA | PASS (local) / PENDING (device) | manifest、图标、Service Worker、Standalone 和 Safe Area 完成；待正式 HTTPS 地址上做真机安装。 |
| 11 | GPT 支持 Task / Goal / Plan 自动分类 | PASS (local + cloud deploy) / PENDING (ChatGPT refresh) | Router 回归通过，MCP `1.2.0` 已部署；现有 App 需刷新工具清单。 |
| 12 | 保留用户原始输入与 Why | PASS (local + cloud schema) | `original_input` 与 `why` 独立保存，MCP 明确禁止编造 Why。 |

数据库部署预演只列出 `202609040003_goals_plans_v1_2.sql`；应用后相关三个 Edge Functions 均为 ACTIVE，公开健康端点返回 `{"name":"personal-os","version":"1.2.0","mcp":"/mcp"}`。

| # | 验收项 | 结果 | 说明 |
|---|---|---|---|
| 1 | 创建“收拾东北旅行行李”进入 Google Tasks | PASS (cloud) | 已由统一 Task API 写入 Google Tasks。 |
| 2 | Due 为 2026-09-06 | PASS (cloud) | 回读结果日期正确，Notes 与 originalIntent 均保留。 |
| 3 | Personal OS 页面显示任务 | PASS (cloud + visual) | Mac 页面真实显示三条 Google Tasks 与正确日期。 |
| 4 | Personal OS 打勾后 Google Tasks Completed | PASS (cloud + visual) | 在页面真实点击 checkbox 后，Google 回读为 `completed` 并带完成时间。 |
| 5 | Personal OS 打勾后 Task / Calendar 同步 | PASS (cloud + visual + device) | Personal OS 写入 `open/completed` 后，Google Task 与同一 Calendar 投影真实执行 `✓ → ☐ → ✓`；iPhone 目视交叉检查已通过。 |
| 6 | “2026年9月8日上午11点飞哈尔滨”进入 Calendar 分类 | PASS (cloud) | 线上 Router 输出 `calendar_event`、11:00，并且未创建 Task。 |
| 7 | 再说“周日记得收拾东北旅行的行李”不重复创建 | PASS (cloud) | 线上 Router 命中原任务，`deduplicated=true`；同标题任务仅 1 条。 |
| 8 | “下周末提醒我查看域名审核结果”进入 Tasks | PASS (cloud) | 已创建 Task，Due 为 2026-09-13。 |

## 本地验证

- `npm run verify`：通过；72 tests pass，0 fail。
- 6 个受影响 Edge Functions 已通过 Deno 类型检查。
- 本地桌面页与 iPhone 页面加载成功，浏览器控制台 0 error / 0 warning。
- Router、统一 Task Model、Task Lists、筛选、CRUD、去重、晨夕会状态均有自动测试。
- 仓库 Secret 扫描覆盖 JS、TS、SQL、HTML、CSS、JSON、TOML 和 Markdown。
- Mac 页面已显示 3 条真实任务；页面 checkbox 到 Google Completed 的真实同步已通过。

## V1.1 排程验收

| 项目 | 结果 | 说明 |
|---|---|---|
| Schedule Metadata migration | PASS (cloud) | 已部署；表不保存 Task title、notes 或完成状态。 |
| Calendar 投影稳定 ID | PASS (cloud + local) | Task ID 生成同一 Calendar-safe Event ID；线上两条带具体时间的 Calendar 投影均为一 Task 一 Event，无重复 Task ID 或 Event ID。 |
| Intake 日期/时间/duration/deadline | PASS (local) | “明天下午3点做…”与“出发之前…”均有回归测试。 |
| Morning Scheduler | PASS (local) | 避开 busy slot、固定事项不移动、无日期进入 Backlog。 |
| V1.1 Edge Functions | PASS (cloud) | migration 与 6 个受影响 Functions 已部署；`task-status` schema 3.0 生效。 |
| 现有 open Tasks 初始归类 | PASS (cloud) | `today_plan=0`、`backlog=31`；已完成的验收 Task 未进入未完成池，没有批量塞入 Today。 |
| Task → 15:00 Calendar | PASS (cloud + visual) | 2026-09-05 15:00–15:30 显示一个 `☐ 完成 Personal OS V1 MCP 真实调用验收`，Schedule 已同步且无错误。 |
| Complete → Calendar `✓` | PASS (cloud + visual) | 恢复后原 Event 变 `☐`，再次完成后原 Event 自动变 `✓`；Event ID 始终为 `pos18ea83471493168c9aa7bee962ae96f08765a4b1`。 |
| ChatGPT App tools 刷新 | PASS (visual) | 页面显示“操作已刷新”；`create_task` 描述已要求明确时间时传 `requested_date/requested_time` 并创建唯一 Calendar 投影。 |
| Web ChatGPT → Task → Calendar | PASS (cloud + visual) | Web ChatGPT 真实创建 `验收 V1.1 ChatGPT 排程`（Task `OXJReEgwS25DRnVxS3p5dw`）；2026-09-05 16:00–17:00 只有一个 `☐` Event `pos8e2f3519d8021f1e3607ac0d9984fab1a9c4586c`，Schedule 无同步错误。 |
| 无人值守 Task → Complete → Calendar `✓` | PASS (cloud + visual) | 在现有已认证 Personal OS 页面完成 Task `NWczWTZfS1JJdEJXNWNpWg`；Completed 区只保留一条，同一 2026-09-04 23:00–23:30 Event `pos75397454c9c6f82a1c18d7415663180b0d2ff1f1` 原位显示 `✓`。 |
| 05:00 晨会 Scheduler 接入 | PASS (visual) | 原 Scheduled Task `5点GPT晨会邮件`（`6a950e48fcb081919192fc5b2357097f`）仍为每天 05:00；提示词已包含 `task-scheduler → task-status`、一次失败重试、Tasks 真源与禁止复制规则，未增加自动化数量。 |
| iPhone Tasks + Calendar | PASS (device + visual) | 用户已在 iPhone 真机确认：未完成 Task 及其 `☐` Calendar 投影、已完成 Task 及其 `✓` Calendar 投影均与云端结果一致；移动端范围不包含直接调用网页端自定义 MCP App。 |

即时 `☐/✓` 同步已验证的是 Personal OS / 服务端写入路径。Google Tasks API 没有为本实现提供完成状态 webhook；若直接在 Google Tasks 原生界面修改，现有 Morning Scheduler 会在下一次 reconciliation 读取真源并修正 Calendar 投影。

## 云端真实任务池

OAuth 已完成。2026-09-04 又对 Gmail 中的晨会、夕会、每日简报、提案关键词和待办关键词做了集中清点；安全提醒、测试邮件、新闻、行情和已有监控没有转成 Task。

- 2026-09-04 22:42 Personal OS 页面回读：未完成 27 条，其中 Today 2、未来/待安排 25、Overdue 0；Completed 显示 10 条。
- 两条带时刻的 V1.1 验收链路均为一 Task 一 Calendar Event；没有为重试或完成动作创建重复对象。
- `验收 V1.1 ChatGPT 排程` 由 Web ChatGPT 真实创建，Due `2026-09-05`，并在 16:00–17:00 形成唯一 Calendar 投影。
- `验收 Personal OS 无人值守环境 V1` 已从 Today 移入 Completed；原 23:00–23:30 Calendar Event 保留并显示 `✓`。
- 2026-09-04，用户确认 iPhone Google Tasks 与 Google Calendar 的两组跨设备验收结果正确，Phase 7 与 V1.1 最终验收完成。
- `收拾东北旅行行李` 仍为原 Task，Due `2026-09-06`，清单已补入“呼吸机”，未新建重复任务。
- `东北旅行行李最终检查` Due `2026-09-07`。
- `查看域名审核结果` Due `2026-09-13`；`完成 Google OAuth 正式发布` 同日作为后续可勾选动作。
- Calendar 中的飞机、高铁、会面、接送时段与固定行程原样保留，没有被批量删除或复制。
- 袁老师渠道关系、企业名单和联系人资料仍属于项目数据；只把“确认联系人”“资源池入库”等可完成动作写入 Tasks。
