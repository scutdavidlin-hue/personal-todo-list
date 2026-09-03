# GPT 晨会 × 今日任务云同步实施计划

> 历史方案说明：本文记录最初的 Supabase 任务表方案。2026-09-04 起，Google Tasks 已替代 Postgres `tasks` 表成为唯一任务状态真源；当前实现与验收以 `README.md`、`AUTOMATION_API.md` 和 `ACCEPTANCE.md` 为准。

基准需求：`PRD_TASK_SYNC_V1.md`（V1.0，2026-09-03）。

## 审计结论

- `index.html` + `app.js` 是完整桌面/响应式任务应用，数据仅在 `richeng-tasks-v1`。
- `today.html` 是独立的手机页，内嵌另一套逻辑，数据仅在 `gpt-personal-tasks-v1`。
- 两页的数据模型、示例任务和延续实现不一致，跨设备与 GPT 均不可读取。
- 当前 checkbox、编辑、删除、移到明天均只改 localStorage；无加载、鉴权、失败回滚或冲突反馈。
- 两页都会在无数据时构造 sampleTasks；正式环境存在误导/迁移污染风险。
- 仓库是纯静态 GitHub Pages 形态，无构建、测试、数据库或后端配置。

## 最终技术方案

保留现有静态页面和视觉结构，新增 Supabase 作为唯一云端数据源：

1. **身份认证**：Supabase Auth 邮箱 Magic Link。浏览器只保存用户会话，不保存数据库高权限密钥。
2. **任务数据**：Postgres `tasks` 表；RLS 强制 `owner_id = auth.uid()`，前端使用公开 anon key + 用户 JWT。
3. **延续机制**：数据库 RPC `rollover_open_tasks(target_date)` 原地更新过期 open 任务的 `date`，首次写入 `carried_from_date`。同一 UUID 不复制，因此重复调用幂等。
4. **自动化接口**：Supabase Edge Function `/task-status`。读、写分别使用服务端环境变量中的低摩擦 Token；service role key 仅存在 Supabase Secret 中。GET 返回晨晚会结构化 JSON，POST 预留 GPT 新增任务。
5. **前端同步**：共享 REST/Auth 客户端。加载后先执行 rollover，再读云端；所有写操作等待服务端成功后再更新 UI。失败时保留/恢复真实状态并明确提示。
6. **离线策略**：最近一次云端快照仅作只读缓存；离线时可查看，但禁止把未同步操作伪装成成功。
7. **旧数据迁移**：同时识别两套旧 key，过滤已知示例任务，规范化后按 UUID upsert；成功后写 migration flag，重试不重复。
8. **部署**：GitHub Pages 继续托管前端；Supabase 承担认证、数据库和 Edge Function。公开 `runtime-config.js` 仅包含 project URL 与 anon key，安全性完全由 Auth + RLS 保证。

## Phase

### Phase 0｜审计与设计

- 完整阅读 PRD 与现有 HTML/CSS/JS。
- 固化方案、风险和外部依赖。
- 建立 `IMPLEMENTATION_PLAN.md`、`PROGRESS.md`、`OPEN_QUESTIONS.md`。

### Phase 1｜云端数据层

- 建立 Supabase migration：任务/复盘表、约束、索引、updated_at、RLS、幂等 rollover RPC。
- 建立 Edge Function：Token 鉴权、结构化状态读取、安全任务写入、CORS 与输入校验。
- 补齐配置示例和 Secret 安全边界。

### Phase 2｜前端同步

- 建立共享 Auth/REST 数据客户端和纯业务逻辑模块。
- `index.html` 保留 UI，接入登录、同步状态、真实 CRUD、失败反馈、云端复盘。
- `today.html` 保留移动端极简路径，接入同一云端源与真实 checkbox。
- 建立只读缓存与一次性 localStorage 迁移。

### Phase 3｜延续与自动化接口

- 页面/接口读取前执行幂等 rollover。
- GET 输出 today_open / today_done / carryover_open / yesterday_completed / recent_completed / upcoming。
- POST 支持经写 Token 创建 GPT 任务。

### Phase 4｜集成准备

- 提供 Supabase/GitHub Pages 配置、部署、晨会/晚会调用示例。
- 账号、项目、Secret 等用户必做事项集中写入 `OPEN_QUESTIONS.md`。

### Phase 5｜测试与验收

- 单元测试：日期、模型规范化、迁移去重、延续分类、API 错误回滚语义。
- 静态检查与 Secret 扫描。
- 本地 mock 后端集成测试与移动视口检查。
- 对 PRD 10 条验收标准逐项记录真实结果；外部环境未配置项明确标记阻塞，绝不虚报。

## 风险与控制

- **公开仓库**：anon key 可公开，但 service role、自动化 Token、SMTP 等全部只放 Supabase Secret/GitHub Secret。
- **匿名滥用**：禁止匿名任务读写；RLS 仅允许 authenticated 用户访问自己的行。
- **客户端日期**：用户页面使用本地日期；自动化调用显式传 `date=YYYY-MM-DD`，默认服务端按 `Asia/Shanghai`。
- **重复延续/迁移**：任务原地 rollover + UUID upsert + migration flag，三层保证幂等。
- **网络失败**：写前不提交本地真值；请求失败恢复控件并显示错误。
- **外部依赖**：Supabase 项目创建、Auth 邮件与 Secrets 部署需要账号权限，是唯一预期人工阻塞。
