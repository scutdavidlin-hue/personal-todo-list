# Task Conversational Update V1

Date: 2026-09-05 · Priority: P0

## WHY

任务创建后仍会改期、补充、取消或产生下一步。用户应在当前任务内直接说话，不必重新描述对象或进入编辑表单。原始需求来源为本任务用户提供的 28 节 PRD；本文是实施摘要，不替代原始需求。

## GOAL

Speak → Understand → Clarify → Preview → Confirm → Execute。复用现有 Personal OS、Google Tasks CRUD、Schedule/Calendar、Semantic Resolution 与 OAuth。Google Tasks 保持普通任务正文和完成状态真源；对话、待确认修改、关系与提醒是附属元数据，不建立第二任务池。

## ACCEPTANCE CRITERIA

1. 当前任务今天 15:00，输入“改四点吧”，有下午上下文时预览今天 16:00；确认才 UPDATE 原 id。
2. 周一约大盆 → “改周四吧”预览日期变化，不 CREATE。
3. “他可能四点才到”记录不确定性或澄清，不修改正式时间。
4. “他会带两个同事”直接追加上下文，不反复确认。
5. “不约了”预览后取消，保留任务及历史，不物理删除。
6. 无下午/日期上下文的“四点”澄清，不能猜。
7. “不对，周五下午三点”替换旧预览，不执行旧提案。
8. “对”仅确认当前展示的 proposal_id；接口执行与回读后才显示成功。
9. 相对提醒随时间一起预览；Date 不冒充 Deadline；follow-up / next-action 创建前搜索去重并保留关联。
10. 刷新和跨会话保留 Timeline、pending 与审计；未确认提案不修改任务。过期、跨任务、并发、重试不得误提交。
11. 失败如实区分 Google Task、附属元数据与 Calendar 投影结果。
12. iPhone 真实麦克风 → GPT 理解 → 澄清 → 预览 → 确认 → 原任务更新 → Google 回读 → Timeline，才算完整 V1 完成。

## IMPLEMENTATION

当前 canonical baseline：本地正式仓库 e286824，源仓库 scutdavidlin-hue/personal-todo-list。本次为隔离修改副本。

新增的确认要求只约束当前任务内的对话修改，优先于旧版普通任务录入默认自动执行规则。低风险补充仍可直接追加，原 CRUD API 保持向后兼容。

复用决策见 docs/reuse-first-task-conversation.json（EXTEND）。Google Tasks PATCH 官方接口保留对象 id；浏览器 SpeechRecognition 仅提供语音输入，其支持程度必须真机验证。现有仓库没有发现服务端 LLM 或转写服务配置，因此不能将确定性中文解析声称为 GPT 理解。

## TEST

以现有 npm run verify 和新增对话用例为自动化入口。Mock provider、浏览器本地测试、云端部署、真实 Google Tasks 回读和 iPhone 验收分开记录。

## RESULT

实现与验收进度见 ACCEPTANCE_TASK_CONVERSATIONAL_UPDATE_V1.md。未部署或缺少 GPT 服务配置时，不宣称完整 V1 已完成。

## Discovery references

- Google Tasks PATCH: https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/patch
- Browser speech: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Compared framework: https://github.com/langchain-ai/langgraphjs/blob/main/docs/docs/concepts/human_in_the_loop.md
