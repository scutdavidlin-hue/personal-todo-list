# Personal OS V1.2｜Goals & Plans 长期规划层

## 本次目标

在既有 Task、Calendar、Client/Customer 体系之上新增长期规划层，用于承载长期目标、中长期计划、尚未执行的想法、持续跟踪事项、人生/家庭/事业规划与长期财务事项。

核心规则：Goal / Plan 本身不是 Task。只有产生明确下一步动作时才创建 Google Task；Task 完成后 Goal / Plan 继续保留。

## 层级与真源

`Goal / Plan → Project → Task → Calendar`

- Goals & Plans：Supabase/PostgreSQL。
- Projects 与 Goal/Task 关系：Supabase/PostgreSQL。
- Tasks：Google Tasks 是内容和完成状态唯一真源。
- Calendar：有明确执行时间的 Task 的唯一时间投影。

## Goals & Plans 数据

基础字段：`id`、`title`、`description`、`why`、`type`、`category`、`status`、`priority`、`progress_percent`、`created_at`、`updated_at`、`archived_at`、`original_input`。

时间字段：`target_date`、`target_month`、`target_year`、`start_date`、`review_date`、`deadline`。target 表达希望实现的时间；deadline 仅用于真实硬截止。

财务字段：`amount_total`、`amount_completed`、自动计算的 `amount_remaining`、`currency`、`counterparty`、`financial_type`。

关系字段：`client_id`、`contact_id`、`company_id`；V1 先保留外部对象标识，不复制 Client/Contact 主体资料。

## 枚举

- Type：Goal、Plan、LongTermItem、FinancialItem、Idea、LifePlan、BusinessPlan、FamilyPlan。
- Category：Career、Business、Finance、Family、Health、Travel、Learning、Property、Personal、Relationship、Other。
- Status：Inbox、Thinking、Planning、Active、Paused、Completed、Dropped、Archived。
- Financial Type：Receivable、Payable、Budget、SavingGoal、InvestmentGoal。

## Goals 页面

一级导航新增 Goals，并提供 Active、Planning、Someday、Financial、Completed 视图。Goal 卡片展示名称、类别、状态、目标时间、进度、关联项目数、未完成 Task 数、最近更新和下一步行动。

Goal 详情展示 Overview、Progress、Projects、Tasks、Notes / Thinking、原始输入，以及适用时的 Financial 余额。可从 Goal 创建 Project、创建关联 Task 或关联现有 Task。

## GPT Intake

统一输入应区分 Task、Goal、Plan、LongTermItem、FinancialItem、Calendar Event、Project/Client Data、Knowledge 和 GPT Job。Goal/Plan/Financial Item 成功写入 Supabase；Task 继续写入 Google Tasks。

示例：

- “明天打电话给销售” → Task。
- “我明年想买房” → Goal。
- “10–11 月开始做 To C 产品” → Plan。
- “小斌还欠我 3 万块” → FinancialItem / Receivable。
- “小斌电话是……” → Contact/Project Data，不进入 Goals。

## PWA

提供 manifest、App Icon、standalone 模式、Service Worker、离线静态缓存、响应式移动界面与 iPhone safe area 支持。

## V1 验收

1. 新增 Goals 页面。
2. 可创建 Goal / Plan。
3. Goal 可以关联 Task。
4. Goal 可以关联 Project。
5. 支持 target date，而不是强制 deadline。
6. 支持 Financial Item。
7. 支持应收金额与自动余额。
8. Task 完成不会删除 Goal。
9. 手机端正常显示。
10. 可安装为 iPhone PWA。
11. GPT 写入支持 Task / Goal / Plan 自动分类。
12. 保留用户原始输入与 Why。
