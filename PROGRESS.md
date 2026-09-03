# 开发进度

最后更新：2026-09-04

## 已完成

- [x] 从正式 `personal-todo-list` Git 仓库建立当前工作区，并合并已有 Google Tasks 草稿。
- [x] Google OAuth 复用 Supabase Auth；支持保留现有 Calendar scope 并追加 Tasks scope。
- [x] Google Tasks API：Task Lists、创建、筛选未完成、完成、恢复、修改、删除。
- [x] 优先复用 `Personal OS` 清单；不存在时创建。
- [x] 统一 Task Model 与 `originalIntent` 持久化。
- [x] 服务端语义去重；命中后更新原 Task，不复制。
- [x] Action Router：Task / Calendar Event / Project Data / Note。
- [x] 桌面及手机页面：Today / Overdue / Upcoming / Completed。
- [x] 晨会、夕会、每日简报状态接口改读 Google Tasks。
- [x] 超时、授权失效、scope 缺失、API 未启用、限流、外部删除和同步失败处理。
- [x] 域名审核提醒已纳入 Router 与真实验收清单。
- [x] 清点 Gmail 晨会、夕会、每日简报与提案/待办关键词，按 Task / Calendar / Project Data / Note 分类。
- [x] 将 27 条有效行动写入现有 `Personal OS` Google Tasks；连同首批任务共 30 条未完成事项，重复标题为 0。
- [x] 原行李 Task 追加“呼吸机”，没有为同一旅行准备事项创建第二条任务。

## 待完成

- [x] 最终自动回归（34 tests；0 fail）。
- [x] 现有 Google Cloud / Supabase 一次性配置、数据库迁移、Functions 部署与 OAuth consent。
- [x] 创建并核验 30 条真实未完成任务；完成日期、说明、originalIntent、去重、分流、完成与恢复的云端验收。
- [x] Mac 页面真实显示、checkbox 完成同步与恢复验收。
- [ ] iPhone 在正式部署地址可用后做最终触控验收。

## 已确认限制

- 当前仓库没有原有 Google Calendar 写入实现；本阶段 Router 会正确分类并阻止误建 Task，但不会在本仓库重复建设 Calendar 服务。
- `runtime-config.js` 只含公开的 Supabase URL 与 anon key；OAuth Client Secret、刷新令牌、加密密钥、service role key 和自动化 Token 均不在前端或 Git 中。
- Postgres 不再保存第二套任务池；Google Tasks 是唯一任务状态真源，Supabase 只保存每日小结和加密后的 OAuth 凭证。
