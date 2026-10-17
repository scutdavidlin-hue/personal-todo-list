# 合成确认页：可运行的隔离样例

**假身份、假任务、假审核来源，仅内存；不是上线或真实用户来源证明。**
原 ChatGPT 回复不能由该样例重新证明。正式采用这套独立审核交互须用户确认，
再完成真实身份、来源签发、数据库与发布验收。

在仓库根目录使用 Node 24（实际验证版本 v24.19.0）：

```sh
node scripts/confirmation-ui-demo.mjs
```

打开终端打印的 `http://127.0.0.1:4176`。可用第二个参数指定其他端口。
无需安装新依赖、登录、创建密钥、配置环境变量或启动数据库。
仅使用假数据，只监听 `127.0.0.1`；关闭进程即清空。
不要转发该端口、发布到公网或注册为真实 MCP 服务。

1. 选择可自由切换的虚构用户 A/B，生成预览。
2. 检查标题、备注、日期、版本和摘要，点击“明确确认此预览”。这一步只记录合成审核事件。
3. 点击“验证已存批准并模拟执行”。独立 verifier 检索服务端事件，现有 proposal runtime
   调用内存模拟执行器；执行次数为 1。再次点击会返回同一模拟回执，次数不变。
4. 新生成一份预览并确认，在执行前拒绝或改口。重放旧批准会被拒绝，次数不增加。
5. 编辑内容会禁用确认；必须点击“用修改内容生成新版本”，再审核新版本。

页面顶部始终标注合成模式。即使模拟回执有 `verified:true`，它只表示模拟结果；
没有真实 Auth/Google 网络调用，没有手机通知或动态岛验证。

## 独立校验实际做了什么

- 复用现有 `task-proposal-runtime.js`，不修改 PR12 生产模块，也不设置全局/default verifier。
- `memory-store.mjs` 仅实现 runtime 的 store 接口；没有 PostgreSQL 持久化或跨进程锁承诺。
- `review-source.mjs` 通过假会话绑定的单次审核挑战，在服务端创建不可变事件。
  HTTP 请求不能自报 actor、owner、digest 或 proof；客户端只提交 challenge 与明确 decision。
- verifier 从独立事件集合检索该事件、重新核对指纹和全部绑定，并阻止后续拒绝/改口后的旧批准。
  指纹不是数字签名。假身份可自由选择，任何人都能模拟它；本样例不证明实际人类身份或点击。
- Origin/CSRF 和内存挑战只防止样例的错误调用/跨页面混用，不是生产认证、设备证明或
  OpenAI 宿主用户回合证明。浏览器自动化也不算真实用户验收。
- 执行器是硬编码内存 Map；没有生产 URL、secret、外部 network client、真实写入 fallback。
  不应把该 authority、fake authenticator 或内存 adapter 移入生产 entrypoint。

## 新增验证

```sh
node --test test/confirmation-ui-demo.test.js
node scripts/confirmation-ui-browser-check.mjs /usr/bin/chromium /tmp/personal-os-confirmation-ui.png
```

12 项**新确认页协议/来源签发链**用例覆盖：合成标识、完整流程、伪造来源、错用户、
内容换版、过期、后续拒绝、后续改口、事件/执行重放、并发重复确认、跨 proposal 移植、
Origin/CSRF。不是把原有 37 项 PostgreSQL 测试再次算作增量。

显式可选的浏览器脚本仅加载本地页面，验证编辑后重审、版本变更、明确确认、模拟执行、
幂等回读、390px 无横向溢出，以及拒绝后旧批准被阻止；截图保存在指定位置。
该脚本不属于默认测试，不要求 CI 安装浏览器。源码与实际结果见
[证据记录](evidence/results.json)，[实际合成桌面截图](evidence/synthetic-desktop.png)。

可选脚本保留 Chromium 正常浏览器沙箱，不默认禁用它，也没有禁用沙箱的自动降级。
若环境无法使用正常沙箱，应记录浏览器验证未执行；不要为此修改系统配置或弱化用户设备安全。
已提交截图与浏览器结果来自 `aa3674e5` 的历史合成运行，截图不证明真人来源。
移除禁用沙箱参数后的本次修订仅做静态检查，未重跑浏览器或重新生成截图。

仍需真实接线时，遵循 [集成契约](../../docs/task-proposal-integration-contract.md)。
本示例只是可评估替代交互；不能据此称可信真实来源已接通、原任务已创建或功能已上线。
