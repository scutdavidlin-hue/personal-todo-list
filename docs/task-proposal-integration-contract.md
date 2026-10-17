# 新建任务确认：真实接线的最小契约与验收门

核实日期：2026-10-17 UTC。实现基准为 `636ded04aa4c3ecc4ec2985d4d99275ff6bd3419`，
其直接 CI 为 [39049126377](https://github.com/scutdavidlin-hue/personal-todo-list/actions/runs/39049126377)。
本文只记录接线缺口、可用平台入口和以后获准的验收步骤，**不是实接、部署或送达证据**。
本次不重复测试，不新增凭据/权限，不部署、不迁移、不写真实 Task。

## 现在具体缺什么

| 缺口 | 哪个宿主负责、可用入口 | 当前实际状态 | 用户本人最小动作 / 批准边界 |
| --- | --- | --- | --- |
| 原 ChatGPT 自然语言回复的可信证明 | 必须由掌握实际人类回合的 OpenAI/ChatGPT 宿主提供可验证事件或证明；Personal OS 服务端负责验签/独立检索与精确绑定 | 当前工具无此接口；已核实的官方 MCP/UI/auth 文档也未给出可用于该用途的签名用户回合/预览同意证明接口。不能以参数、会话 ID 或 bearer 替代 | 用户反复说“同意”、重新登录、贴截图或开放数据库均不能补出宿主证明。此路径需要平台支持/正式契约，不能让用户提交密钥来解决 |
| 可选的显式预览审核来源 | Personal OS 维护者在现有 PWA + Supabase Auth/Edge Functions 内实现独立审核事件签发与查询服务；也可评估官方 MCP UI 组件 | 现有 `src/task-conversation.js` 和 `task-conversation` 仅处理已有 task_id，不能用于未创建任务；没有新建任务审核页、来源事件签发器或真实 verifier | 若用户选择此替代流程，待实现后仅需在现有 Personal OS 登录下打开绑定预览并点确认/拒绝。它建立新的 UI 审核证据，不会证明或重放先前那句 ChatGPT 回复；改变交互方式需用户选择 |
| 私库连接池 | 现有 Personal OS Supabase 项目的 Edge runtime，维护者在服务端装配连接池 | 官方明确注入 `SUPABASE_DB_URL`；优先复用这一已有运行时变量，不先创建数据库密码。现有代码只接受注入的 pool，尚无线上装配或项目内连接/角色验证 | 若平台默认变量可用，不需要用户复制任何密码。本轮也不读取它。把数据库访问接入新上线 HTTP 路由属于待审批的发布动作；若确需新角色/secret，必须先列出具体差额并另行批准 |
| 私表迁移 | 该 Supabase 项目获授权的发布者；已连接的 `supabase.apply_migration`，或现有管理员的 Dashboard/CLI 发布流程 | 工具存在，不是平台缺功能；仓库仅有执行过隔离 PG 的 draft SQL，尚未审定、打包或应用线上迁移，亦无清理策略 | 审批应针对具体项目、SQL 差异、保留/清理范围及回退方式；不以“接线”泛授权迁移。可由获授权代理用既有 connector 执行，不必让用户手动粘贴 SQL 或交出 CLI token |
| HTTP/前端/MCP 路由 | Personal OS 维护者，既有 Supabase Edge Functions 与 GitHub Pages/MCP 宿主 | 有 `supabase.deploy_edge_function` 工具，但无 proposal 线上 entrypoint、路由注册、前端调用或 MCP 预览桥；现有 CI 只跑隔离测试 | 完整代码与差异可审阅后才批准精确函数/前端发布。不可直接覆盖生产整个分支；须先与并行 Calendar 修复、实际生产版本核对 |

“现有项目管理员/发布者”是职责，不是已核实的人员或角色。
仓库 owner 名不能证明其 Supabase Owner/Admin 身份；当前未要求用户重新登录或扩大账户权限。

## 官方接口能证明什么

已查阅 OpenAI 官方 [Plugins reference](https://developers.openai.com/plugins/reference)、
[用户认证](https://developers.openai.com/plugins/build/auth) 与
[MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui)。
OAuth 可证明所授权的账户；`openai/subject`、`openai/session` 提供匿名身份/会话关联；
UI 可通过 `tools/call` / `window.openai.callTool` 发起调用。
这些已公开的契约并未为当前服务器提供“某实际用户回合批准某 proposal/version/digest”的证明。
这是对已查接口和当前工具的能力核实，不是宣称所有 OpenAI 内部或未来接口都不存在。

官方确实描述 approval-gated tool 的 UI 输入何时可见，以及 `_meta.ui.visibility` 的
model/app 可见性。它们可以用于以后设计审核 UI，但不得单独当作签名同意证据或服务端鉴权。
`source:chatgpt`、`actor:user`、`confirmed:true`、模型转述、任意事件 ID、
`request_user_input` 的文字结果、浏览器 `isTrusted` 标记、组件生成的 follow-up message，
均不能由本代理自封为真实来源。登录通过也不会自动提供实际人类同意。

现有 MCP `personal-os-mcp/index.ts` 解析 `params.arguments` 后分派，未接入来源证明；
其 Auth `/auth/v1/user` 检查只确认当前 owner。现有 task-conversation 要求真实 task_id，
不能伪造一个任务 ID 来储存新建任务的待确认内容。

## 可信来源的服务端契约

宿主装配现有 `createTaskProposalHandler` 的以下依赖；不能把客户端上送对象直接返回为证明：

```text
store                 <- createPostgresProposalStore(approvedServerPool)
authenticateUser      <- createExistingSessionAuthenticator(existing Auth binding)
resolveAccount        <- createExistingAccountResolver(existing task-status binding)
resolveContext        <- existing read-only autonomy context
verifyReplySource     <- independent retrieval/validation from an approved source issuer
trustedAuthorities    <- server-side allowlist for that actual issuer
sendIntake            <- existing personal-os-intake with stable proposal:<id>:<version>
```

`verifyReplySource({ request, principal, accountSubject, proposal, replyEventId })`
须从宿主实际存储/签名通道独立验证来源后返回：

```text
authority, eventId, actor, ownerId, accountSubject, conversationId,
proposalId, previewId, version, scopeDigest, disposition, occurredAt, proofDigest
```

服务端记录必须绑定同一 owner、Google subject、会话、proposal、preview、版本、摘要和时刻。
只有精确批准才是 `approve_exact`；拒绝为 `reject`；改动范围为 `change_scope`；不确定为
`question`。不能用文本中出现“是/好”覆盖问句、否定或修改。
`proofDigest` 仅为已验证证据的指纹，不是签名校验方案。

若采用 Personal OS 自有审核页，尚需实现服务端签发、绑定预览的一次性审核挑战、
同源/CSRF 与会话边界、来源事件不可变存储、独立查询 verifier 和真实用户操作验收。
owner/account/digest 等绑定值须来自服务端已有 proposal，不能由页面 body 自报。
模型可调用的 capture/confirm 工具不能自行生成“用户已点击”来源事件。
具体 UI 通道必须证明模型调用不能冒充审核操作；普通 bearer、工具 visibility 或 nonce
单独均不能替代该安全评估。当前没有这套签发/验证代码，不把它称作可马上启用的入口。

## 私库与发布接线的精确范围

Supabase 官方 [环境变量](https://supabase.com/docs/guides/functions/secrets) 列出自动注入的
`SUPABASE_DB_URL`；[数据库连接示例](https://supabase.com/docs/guides/functions/connect-to-postgres)
展示 Edge runtime 使用它创建 Postgres pool。因此当前准确缺口是**装配及验收**，
不是“已证明必须新增持久凭据”。默认变量在本项目线上是否可用、对应角色和连接方式均未核实。

维护者需在获准的隔离宿主内只回报以下非秘密结果，不打印 DSN、密码、token、环境变量集合：

1. 默认变量是否存在；连接是否成功；是否命中预期数据库。
2. 当前连接角色是否已经有访问私 schema/事务的权限；不要为通过测试自动 grant。
3. Edge driver 是否兼容当前 adapter 的 `pool.query(text,args)`、`pool.connect()`、
   `client.query(...)`、`release()` 和 `{rows,rowCount}` 结果。官方 Deno Pool 示例不是
   本仓库 Node `pg` 接口的自动等价替换；Edge 运行时/驱动适配仍须验证。
4. 原子事务、参数化查询、DB 时间、并发条件更新均保留；客户端和模型不得取得 pool。

当前 connector 能执行管理面 SQL，但它不是生产函数的长期数据库连接服务。
不能把本会话 connector、service-role REST 或向公开 schema 暴露新私表当作连接池替身。
当前工具没有 Supabase secret-setter。仅在明确确认默认变量不足且确需新 secret 时，才由
项目 Owner/Admin 在 Dashboard **Edge Functions → Secrets** 或既有 CLI 安全入口设置；
官方该页注明生产 secret 新建/删除要求 Owner/Admin。不得在聊天或 PR 传递其值。

迁移工具和函数部署工具均已可发现；本轮没有调用它们。CLI 之前的本地初始化失败不代表
Supabase 管理面没有迁移能力，也不构成要求用户新建 token 的理由。
新 schema 仍保持 private、RLS 与 client revokes，不扩展 PostgREST exposed schemas，
不增加 SECURITY DEFINER 或客户端角色授权。保留期限及何种最小审计要留存仍待发布审定。

未来 route wrapper 必须处理 OPTIONS/CORS、owner 身份、超时、错误脱敏和显式依赖装配。
例如若选新 Edge function `task-proposals`，本 runtime 匹配的子路径应为
`/functions/v1/task-proposals/proposals` 和
`/functions/v1/task-proposals/proposals/<id>/confirm`；不能假定 function 根路径已经可用。
这些路径只是拟议契约，当前线上不存在对应注册证据。

最小正常传输体：

```text
POST .../proposals                 {input, conversation_id}
GET  .../proposals/<id>             (read exact preview/version/digest/status)
POST .../proposals/<id>/confirm     {version, scope_digest, reply_event_id}
POST .../proposals/<id>/revoke      {version}
POST .../proposals/<id>/revise      {version, input}
```

“confirm”只引用来源事件，不上送 approve 布尔值。现有库在来源未配置时返回
`TRUSTED_REPLY_SOURCE_UNAVAILABLE`；当前并未部署一个返回此值的新线上 route。

发布者可使用既有 connector 的 `apply_migration` / `deploy_edge_function`，
或官方 [数据库迁移](https://supabase.com/docs/guides/deployment/database-migrations)、
[函数发布](https://supabase.com/docs/guides/functions/deploy) 的既有工作流。
本任务不需要先开新 Supabase 项目、分支、外部账户或收费服务；若以后选择新增收费隔离资源，
必须先报价、用户批准。仓库无自动生产 Edge 部署 workflow；隔离 PG CI 不会替代发布。

## 获准接线后的最短验收顺序（本轮未执行）

1. **来源可用性门**：平台给出正式签发/检索接口，或完成独立 UI 来源实现并获准采用。
   在此之前不得开放真实 confirm writer；不能用 fixture authority 通过此门。
2. **只读连接门**：获准隔离宿主核实已有默认数据库绑定和权限、Auth owner/Google subject；
   仅报告布尔结果/版本等非秘密信息。无可用隔离宿主则明确申请具体宿主，不落到生产试验。
3. **部署准备门**：精确审定 migration、保留策略、宿主/驱动实现、路由、审核 UI 及
   intake/task-status 依赖包。核对生产 bundle 与源版本及并行 Calendar 修复，不整分支覆盖。
4. **用户批准门**：提交具体项目、函数清单、schema 差异、权限差额、费用（若有）和回退动作；
   本轮明确禁止迁移/部署/真实写入，该批准尚不存在。
5. **真实来源但零 Google 写入门**：在获准的隔离服务连接真实 Auth/审核来源，执行
   预览、否认、改口、错 owner/preview/version、事件重放和过期检查，验证服务端独立取证。
   其下游仍可指向显式模拟 transport，报告为真实来源验收而非真实任务保存。
6. **最小真实 Task 验收门**：只有单独获准一个新建的测试事项后，才允许真实 Google
   创建与回读；不得改用原失败任务、真实 KPL 任务或旧请求作隐式测试。不确定结果只读对账。
   iPhone 通知/灵动岛验收属于另一条原生安装与设备验证链，不能由此 PG/HTTP 结果代替。

可交付而尚未实接的结论：有现成 Supabase 管理面发布入口，也有默认数据库绑定候选；
**当前不能独立安全完成的首要门，是原 ChatGPT 人类回复的可验证来源**。
新增自有审核 UI 是可开发替代路径，尚须完整实现、选择和验收，不是配置一个标志即可上线。

另附 [可运行的隔离合成确认页](../demo/confirmation-ui/README.md)，仅演示假会话下的
预览、服务端事件签发、独立 verifier 与内存模拟执行。它补充来源链的评估证据，
不使上述真实身份/来源缺口消失，也不能重证原 ChatGPT 回复；正式采用交互仍须用户选择。
