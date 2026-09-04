# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Personal OS 的主要使用者是系统所有者本人。主要使用场景是：在 ChatGPT 中自然表达想法、安排和长期事实，再由系统归类；在 Mac 或 iPhone 上查看今天的执行动作、长期方向和进展。

## Product Purpose

Personal OS 把人的自然表达连接到长期规划与日常执行：长期目标和持续事项保留在 Goals & Plans，阶段性工作进入 Project，明确动作进入 Google Tasks，有具体执行时间的 Task 再投影到 Google Calendar。成功意味着用户不需要每天手工整理数据库，也能清楚知道长期方向、当前项目和今天下一步。

## Positioning

GPT 是统一输入与理解层，而不是要求用户先选择项目管理表单。系统按内容含义把同一句话归入 Fact、Task、Goal、Plan、Project、Client、Financial Item、Calendar Event 或 Knowledge，并保持各层职责清晰。

## Operating Context

- Google Tasks 是 Task 内容与完成状态的唯一真源。
- Google Calendar 是有明确执行时间的 Task 的投影层，不保存第二份任务状态。
- Supabase/PostgreSQL 保存长期规划、关系、排程 metadata、每日复盘、OAuth 凭证与审计记录。
- ChatGPT 通过现有 Personal OS Intake/MCP 链路写入系统。
- Web App 需要在 Safari 中可添加到 iPhone 主屏幕并以 standalone 模式运行。

## Capabilities and Constraints

- 数据层级为 Goal / Plan → Project → Task → Calendar。
- Goal / Plan 不是 Task；只有出现明确下一步动作时才创建 Task。
- 长期事项允许 target date/month/year、start date 和 review date，不强制虚构 due date。
- deadline 只表达真实的最晚完成时间。
- Financial Item 支持应收、应付、预算、储蓄目标、投资目标，并自动计算余额。
- Task 完成、恢复或改期不能删除 Goal / Plan。
- Goals / Plans 保留用户原始输入与 Why。
- 继续沿用现有静态 Web 前端、Supabase、Google Tasks 与 Google Calendar 链路；本版本不迁移到新框架，也不引入第二个任务库。
- Client、Contact、Company 保持独立业务对象；长期欠款等事实只通过关系连接，不能塞进联系人主体记录。

## Brand Commitments

产品名称为 Personal OS。中文界面语气清楚、克制、支持行动，不使用复杂项目管理术语要求用户自行维护数据库。

## Evidence on Hand

- 现有 V1.1 已实现 Google OAuth、Google Tasks 唯一真源、Calendar 时间投影、Supabase Intake、远程 MCP、桌面与手机任务界面。
- V1.2 的 Goals & Plans 数据模型、页面结构、分类规则和 12 条验收标准由用户在本次需求中明确给出。
- 当前没有可复用的 Goals 数据、联系人表或项目表；实现不得伪造真实长期计划、金额、联系人或客户记录。

## Product Principles

- 自然输入优先：用户说人话，系统负责归类。
- 长期事实与执行动作分层：完成一次 Task 不抹掉长期状态。
- 时间语义真实：目标时间、复查时间与硬截止各自表达，不用假 Due Date。
- 一个职责一个真源：Task 在 Google Tasks，长期规划在 Supabase，Calendar 只做时间投影。
- 从最小可用闭环开始，避免把 Personal OS 变成复杂的通用项目管理软件。

## Accessibility & Inclusion

Web 界面需要键盘可操作、表单有明确标签、状态变化可由辅助技术感知；iPhone 触控目标和安全区必须可用。
