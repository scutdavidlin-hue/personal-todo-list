# PRD｜GPT 晨会 × 今日任务真打勾闭环 V1.0

- 项目：personal-todo-list
- Repo：scutdavidlin-hue/personal-todo-list
- 日期：2026-09-03
- 状态：Ready for Codex

## 1. 一句话目标
用户每天只需要看 05:00 Gmail《GPT晨会》，点击“☑️ 打开今日任务”，在 iPhone 网页中真正勾选完成；勾选状态写入云端，GPT 后续晨会/晚会能够可靠读取：已完成不再延续，未完成自动延续到第二天。

## 2. 用户体验原则
1. 用户不需要再回 ChatGPT 口头汇报“这个完成了”。
2. Gmail 是通知与摘要入口，不承担任务数据库职责。
3. 今日任务页是唯一的人机任务操作入口：查看、勾选、取消勾选、必要时编辑/删除/延期。
4. 云端任务状态是 Single Source of Truth；localStorage 只允许作为缓存/离线容错，不能再作为主数据源。
5. 手机优先，iPhone Safari/Chrome 都应好用；页面加载快、按钮大、单手可操作。
6. 不把 GitHub PAT、数据库 service role key 或任何高权限 secret 放进前端代码。
7. 尽量少让用户参与技术配置；Codex 能自动完成的直接完成。只有必须由用户授权/注册/复制 secret 时，才一次性输出清晰阻塞清单。

## 3. 当前状态
现有 repo 已有：index.html、today.html、app.js、styles.css。
当前 app.js 使用 `richeng-tasks-v1` / `richeng-reviews-v1` 存入浏览器 localStorage。checkbox 可以在本机改变 `done`，但其他设备和 GPT 后台无法可靠读取，因此不能形成自动晨会闭环。

## 4. V1 功能范围

### 4.1 云端任务模型
至少支持字段：
- id: uuid
- title: string
- date: YYYY-MM-DD
- time: nullable string
- category: string
- priority: high|medium|low
- duration: number
- notes: string
- status: open|done|cancelled
- done: boolean（可保留兼容）
- completed_at: nullable timestamp
- created_at
- updated_at
- source: manual|gpt|carryover
- carried_from_date: nullable date

可增加必要的版本/同步字段，但避免过度设计。

### 4.2 今日任务页
- 页面打开即读取云端任务。
- checkbox 点击后立即写入云端，并有明确成功反馈。
- 写入失败必须提示，不允许 UI 假装成功。
- 允许取消勾选并恢复 open。
- 已完成任务保留在当天完成区/统计中。
- 未完成昨日任务在第二天显示为 `↪ 昨日延续`。
- 用户手动“移到明天”继续支持。
- 手机端优先。

### 4.3 自动延续规则
每日第一次读取/晨会生成前，应能得到：
- yesterday_completed
- carryover_open
- today_new/open

规则：
- done：记录完成，不进入第二天待办。
- cancelled：不再出现。
- open 且日期 < 今天：进入今天，并保留 carried_from_date；必须避免每天重复复制同一任务。
- 用户重新打开已完成任务：重新进入 open，并可再次进入后续延续。

优先采用幂等设计。可以“逻辑视图延续”而非物理复制，只要 GPT 和前端都能稳定识别。

### 4.4 GPT 可读取接口
必须提供一个无需暴露高权限 secret、适合 GPT/自动化读取的任务状态出口，至少能返回：
- 今日 open
- 今日 done
- 逾期/昨日延续 open
- 最近完成

优先输出结构化 JSON。若需要鉴权，设计成低摩擦且安全的方式；不得把管理员密钥写在公开 repo 或网页源码。

目标是未来 05:00 晨会和 21:00 晚会可基于这个状态源生成邮件，而不是猜测聊天历史。

### 4.5 GPT/自动化写入能力
预留 GPT 新增任务的安全写入路径：GPT 在对话中识别到明确行动事项时，未来可以写入任务源。V1 若鉴权/连接限制导致无法完全自动写入，至少完成后端 API/数据结构和清晰文档，不要用不安全方案硬凑。

## 5. 推荐技术方案
Codex 先自行评估，默认优先：
- 前端继续静态托管（现有 GitHub Pages/jsDelivr 可保留）。
- 使用轻量托管数据库/后端（优先 Supabase 或同等级方案）。
- 前端只使用受限匿名/public client 配置 + 严格 RLS；绝不使用 service role key。
- 如果公开匿名写入无法做到合理安全，则实现轻量认证（magic link / passkey / device session 等），以“用户手机操作最少”为第一原则。
- 若选择 Cloudflare Worker / Vercel Function 等 API 层，也可以，但必须解释为什么比 Supabase 更简单/安全。

不要为了“零配置”牺牲安全。

## 6. 数据迁移
- 首次上线需要兼容现有 localStorage。
- 检测到本地旧数据时，提供一次性迁移到云端的流程。
- 迁移成功后记录 migration flag，避免重复导入。
- sampleTasks 不得污染正式任务库；正式模式不应自动创建示例任务。

## 7. Gmail 晨会集成目标
晨会邮件顶部结构：
1. 今日核心 3–5 项
2. `☑️ 打开今日任务` 真链接
3. 昨日已完成 ✓
4. ↪ 昨日未完成 → 今日延续
5. 今日新增
6. 等待/卡点
7. 未来 3 天

邮件 checkbox 仅展示；真正勾选发生在今日任务页。

最终目标：
`05:00 Gmail → 点击今日任务 → 勾选 → 云端保存 → 21:00 晚会读取 → 次日05:00自动延续/移除`

## 8. 安全要求
- 禁止 commit secrets。
- 禁止前端出现 GitHub PAT / service role key。
- 数据库启用最小权限。
- 如果 repo 继续 public，任何客户端配置都必须按“公众可见”设计。
- 用户个人任务数据原则上不应公开可枚举。
- 对写 API 做基本防滥用/鉴权。

## 9. Codex 工作方式
1. 先完整审计现有代码，不要盲目重写 UI。
2. 新建 `IMPLEMENTATION_PLAN.md`，写清方案、阶段、依赖、风险。
3. 新建/持续更新 `PROGRESS.md`。
4. 新建 `OPEN_QUESTIONS.md`：只有真正需要用户操作/授权的事情才写进去；能自行判断的不要问。
5. 按 Phase 连续执行，不要每做一个小步骤就停下来等用户。
6. 每个 Phase 完成后自行测试。
7. 能通过 GitHub/CLI 自动完成的配置直接完成；遇到登录、第三方账号创建、secret、付费或权限审批才停下。
8. 不破坏现有页面体验，优先增量改造。

## 10. Phase 建议
### Phase 0｜审计与设计
- 审计现有 HTML/CSS/JS。
- 明确托管方式和数据方案。
- 输出 IMPLEMENTATION_PLAN / OPEN_QUESTIONS。

### Phase 1｜云端数据层
- schema / migration / RLS / API。
- 本地开发配置示例 `.env.example`。
- 不提交 secret。

### Phase 2｜前端同步
- 替换 localStorage 主存储。
- checkbox 云端真写入。
- 加载/失败/重试/离线体验。
- localStorage 一次性迁移。

### Phase 3｜延续与状态接口
- 实现幂等 carryover。
- 实现 GPT/自动化读取 JSON 接口。
- 测试跨设备刷新仍保持完成状态。

### Phase 4｜晨晚会集成准备
- 提供机器可读接口文档和示例。
- README 写清 Gmail/ChatGPT 自动化如何读取。
- 如当前环境能直接接入，则完成接入；否则把唯一必要的外部步骤写进 OPEN_QUESTIONS。

### Phase 5｜验收与清理
- 移除 sampleTasks 正式污染。
- 手机端验收。
- 安全检查。
- README / PROGRESS 更新。

## 11. 验收标准
必须至少通过：
1. iPhone 打开 today 页面看到真实今日任务。
2. 勾选 A → 刷新页面仍是已完成。
3. 换浏览器/设备登录或访问授权后仍看到 A 已完成。
4. GPT/自动化读取接口返回 A=done。
5. 未完成 B 到第二天只延续一次，显示 `↪ 昨日延续`。
6. 完成 B 后再下一天不再进入 open。
7. 取消任务后不再延续。
8. 网络写入失败时用户能看见失败，不出现假完成。
9. repo 中不存在 secret。
10. 旧 localStorage 数据可一次性迁移。

## 12. 非目标（V1 不做）
- 不做复杂团队协作。
- 不做完整 Jira/Notion。
- 不做花哨 AI 推荐。
- 不做原生 iOS App。
- 不为了功能堆砌破坏“打开→看→勾”的极简路径。

## 13. 最终用户目标
用户每天只做两件事：
1. 看 Gmail 晨会。
2. 打开今日任务，完成一项勾一项。

系统负责剩余工作：保存状态、统计完成、晚间收口、未完成延续、第二天晨会重排。