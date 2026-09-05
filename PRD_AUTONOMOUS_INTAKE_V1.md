# 自然语言任务自动落库与低风险自主执行规则 V1.0

## WHY

用户表达清楚行动意图即可。减少为补全数据库字段反复追问的成本。Google Tasks 继续保存任务正文和完成状态，Calendar 只是时间投影；现有 Goals & Plans 保存长期方向与偏好。

## GOAL

统一执行理解 → 分类 → 上下文推断 → 语义去重 → 风险判断 → 写入 → 回读 → 简短反馈。L1 直接执行，L2 只问会显著改变结果的关键歧义，L3 重大资金、法律承诺、关键数据删除等进入关键参数确认，普通任务工具没有交易执行能力。

## ACCEPTANCE CRITERIA

1. “入住亚朵的时候提醒我多拿几个梳子。”直接进入一个 Task，不问酒店名称或几点。
2. “翔辉下午三点过来。”与同日“15:00 翔辉到公司”复用同一个任务。
3. 有当前任务 ID 时，“改成四点。”更新 16:00；“还是三点。”更新回 15:00，继续使用同一个 Calendar Event。
4. “晚上不一起吃饭了，他有饭局。”仅移除晚餐安排，保留下午见面。
5. “明天买套400万的房子。”不得执行交易，返回确认流程。
6. 信息查询不创建任务。长期偏好进入 Goals & Plans；长期规则与本次行动分别保存，任一失败明确返回部分完成。
7. Date 是计划执行日期，Deadline 仅来自明确截止要求。日期优先级：明确日期、对话行程、Calendar、Travel Plan、当前任务/Goal、合理默认。保留模糊时间原文。
8. 一个 Action 一个 Task，未完成通过 Today/Overdue 继续显示。创建前查询真实候选；重复、修改、跟进、子任务、新事项沿用现有解析与关系结构。
9. 只有 write_success === true 且回读 verified === true，才返回“已经写进去了”。读取确认存在但未写入时用复用反馈；Calendar 失败单独报告，不能声称手机通知送达。

## IMPLEMENTATION

- 使用现有 Smart Reminder 本地快照作为本轮集成工作副本，保留同一个 Personal OS 仓库及 Supabase/Google 服务；本目录不建立新数据库、服务、Git 仓库或自动化。
- `autonomy-policy.js` 负责有界、可解释的规则判断。它不是通用语言模型，MCP 调用者负责传入对话中已知的行程及当前任务 ID。
- `autonomy-runtime.js` 统一上下文准备、Google Tasks 回读核验和反馈。服务端重新读取当前任务，避免直接用对话旧快照覆盖内容。
- `personal-os-intake` 复用幂等审计、Google Task 写入与 Goals & Plans 写入；混合请求返回两个结果，失败重试复用原 Task ID。
- `task-status` 复用凭据和 provider，提供上下文、原位更新、回读；更新沿用稳定 Calendar 投影。
- MCP schema 与初始化规则同时更新，传递 context、existing_task_id 与严格状态字段。普通提醒继续走 Personal OS，不创建 Codex/ChatGPT 自动化。
- 复用决定：EXTEND。依据见 `docs/reuse-first-autonomous-intake.json`。未增加依赖。

## TEST

使用仓库 `npm run verify`，策略测试、provider 回读测试及真实 Intake handler 的模拟 HTTP 集成测试。生产验收必须在相同发布包保留已有 CRUD/Follow-up 工具、migration 对齐并获得生产发布授权后进行。

## RESULT

以 `ACCEPTANCE_AUTONOMOUS_INTAKE_V1.md` 的实测结果为准。本地代码和模拟测试通过不等于线上部署，也不等于 iPhone 通知实际送达。
