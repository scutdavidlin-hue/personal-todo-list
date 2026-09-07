# PRD｜iOS 同会话 Calendar → Personal OS Task 路由恢复 V1.0

## 1. 背景

当前在 ChatGPT iPhone 端已经确认：

- 纯 Task 对话中，Personal OS MCP 可以正常调用 `create_task` 并写入 Google Tasks。
- 纯 Calendar 对话中，Google Calendar 可以正常写入事件。
- 但在同一个长对话里，如果前序消息已经调用过 Calendar，后续再出现普通提醒/待办时，Personal OS Task 可能不再被重新选择，出现 Calendar 与 Task 的工具路由冲突。

这不是 Google Tasks 写入核心逻辑本身失效，因为新的纯 Task 对话能够成功；更像是同一会话里多工具编排、工具重入与路由提示不足。

## 2. 原始动机

Personal OS 坚持 Single Source of Truth：

- 普通提醒/待办 → Google Tasks / Personal OS。
- 确定时间的真实事件/行程 → Google Calendar。
- GPT Automation 仅用于未来需要 GPT 主动搜索、分析或执行的任务，不作为普通提醒的降级入口。

用户不应该因为前面在同一对话中使用过 Calendar，就失去后续 Task 写入能力。

## 3. Bug 复现

### Case A：同会话先 Calendar 后 Task

Turn 1：`9月8日上午11点广州飞哈尔滨。`

期望：Google Calendar。

Turn 2：`健身后提醒我从萤火虫车上拿薄外套。`

期望：Personal OS `create_task` → Google Tasks。

实际：在部分 iPhone 长对话中，后续 Task 路径未被重新选中，Calendar 工具会继续占据路由或 Personal OS 工具不可用。

### Case B：纯 Task 对话

Turn 1：`明天提醒我处理上周拖延的事情。`

实际：Personal OS MCP 可正常工作。

由此证明问题与“iPhone 完全不支持 MCP”不一致。

## 4. 目标

1. 明确增强 `create_task` MCP 工具元数据，使其支持跨前序工具调用后的重新进入（re-entry）。
2. 明确声明：工具选择必须以“当前用户消息意图”为准，不得被同一对话前序 Calendar 调用锁定。
3. 当当前消息是普通 reminder / todo / follow-up / action item 时，即使同会话早先调用过 Calendar，也应优先选择 Personal OS Task。
4. Calendar 只用于真实事件/行程/预约，或作为 Personal OS Task 的唯一时间投影，不替代 Google Tasks 作为普通待办的真源。
5. 不允许因为 Personal OS MCP 未被路由而自动降级创建 ChatGPT Automation。

## 5. 实现建议

### 5.1 MCP tool description 增强

更新 `supabase/functions/personal-os-mcp/index.ts` 中 `CREATE_TASK_TOOL.description`，加入明确规则：

- Evaluate every message independently from prior tool selections.
- A previous Calendar call in the same conversation MUST NOT suppress or disable `create_task` for a later ordinary reminder/task.
- If the current request is an actionable reminder/todo/follow-up, choose `create_task` even when earlier turns used Calendar.
- Calendar events and Personal OS Tasks are different destinations; prior destination is not sticky conversation state.

### 5.2 回归测试

新增静态 MCP metadata 测试，确保 `create_task` description 持续包含：

- current-message intent / independent routing
- prior Calendar call must not block Task
- no GPT Automation fallback for ordinary reminders

同时保留既有 Task 写入、去重、Calendar 投影测试。

### 5.3 运行时边界

服务端无法强制 ChatGPT 客户端一定暴露某个工具，但必须最大化 tool-selection metadata 的可判别性。

如果经过 metadata 强化后 iOS 仍然复现，则将问题明确归类为 ChatGPT iOS 多工具路由/会话状态层，而非 Google Tasks 业务代码 Bug，并保留最小复现用例用于后续平台 Bug 反馈。

## 6. 验收标准

- AC1：纯 Task 对话仍正常写 Google Tasks。
- AC2：纯 Calendar 对话仍正常写 Calendar。
- AC3：同会话 Calendar → Task 场景中，Task 工具元数据明确要求重新进入 Personal OS，不受前序 Calendar 选择影响。
- AC4：普通 reminder/todo 不创建 ChatGPT Automation。
- AC5：`npm run verify` 全部通过。
- AC6：在 iPhone ChatGPT 做真实回归：先创建 Calendar 行程，再在同会话创建一个普通 Task；Google Tasks 中可以看到后者。

## 7. 非目标

- 不改变 Google Tasks 数据模型。
- 不修改 Calendar 事件写入核心。
- 不把 Calendar 作为普通 Task 的永久替代方案。
- 不复制一份 Task 到多个提醒系统。

## 8. 完成定义

代码修改 + 自动测试通过 + PR 建立后，在 iPhone 上完成 AC6 人工端到端验收。只有 AC6 通过，才视为该 Bug 真正关闭。
