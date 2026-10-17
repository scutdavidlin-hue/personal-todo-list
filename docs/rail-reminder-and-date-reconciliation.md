# 铁路提醒模板与日期对账：合成复现及最小修复

基线：`bb240517727a81ca89059985295b7c9da144403b`，独立分支
`fix/rail-security-reminder-20261017`。不以旧 main 或 PR12 为补丁基线；
不声称此源 SHA 已映射到当前生产的 opaque Edge bundle。

本次只读检查代码并使用完全虚构数据。没有读取/修改真实任务、日历、身份或凭据，
没有部署、迁移、权限变更或 Calendar cancelled 清理。本文件不记录实际行程或个人信息。

## 已证的软件路径

输入：`乘坐某列车，从某高铁车站出发，提前安检进站`，配合虚构日期和时刻。

`resolveReminderPolicy` 合并 raw_text/title/notes，原 `taskKind` 在检查铁路词前，
将“安检”归为 flight；另一条 `inferTransportation` 却得出 train。
之后 `reminderNotificationCue` 和 `reminderActionGuidance` 按 task_kind 生成航空提示，
`buildCalendarEvent` 将它们放进实际 summary/description。

| 同一合成输入 | 基线 | 补丁 |
| --- | --- | --- |
| task_kind / transportation | flight / train | train / train |
| 投影提示 | 机场值机、安检和行李 | 前往车站、进站 |

这证明仅靠正常铁路“安检”文字就能走到错误模板，**不需要调用方先填错 flight 字段**。
但它不证明任何现有真实事件必然由这一输入路径产生：未取证其创建参数、保存的 context、
后续更新或生产代码版本。若调用方 notes 本身明确写有“机场值机”，现有航空专属词仍优先；
本补丁不会将这种混合/错误输入悄悄改成纯铁路意图。

最小改动：航空专属词仍优先，明确铁路词优先于共用的“安检”；补齐“列车”这一铁路词，
让类型和交通方式一致。单独“安检”的旧 fallback 未扩展修改。新推断会使用既有 train
准备/缓冲规则；已明确配置的提醒时刻与策略保留，不借分类修复重排显式提醒。
尚无生产部署或旧事件重建，不能宣称已有错误投影被修正。
仅有车次编号而没有上述明确铁路词的输入不在本补丁覆盖范围，不能声称所有铁路输入均已修复。

## 日期差异：保留事实，不自动统一

Google Tasks 的 `due` 是使用 RFC3339 时间戳格式的可选字段；API 只保留日期部分，设置时丢弃时间部分。
官方[旧 Tasks 路径](https://developers.google.com/tasks/reference/rest/v1/tasks?hl=en)称其为 due date，
[Workspace 路径](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks?hl=en)（页面标注更新于 2026-02-24）
使用 scheduled date，并有原文："It doesn't represent the deadline of the task."；
两处措辞存在差异，不能据字段名替具体用户事项保证其业务截止或独立安排含义。
`updated` 只说明整个任务最后修改时间，不能识别修改字段、操作者或意图。
**本应用约定**：Task 日期按安排日期处理，另有 deadline 字段表示明确硬截止；
这一应用语义不被写成 Google 对每条用户数据的业务保证，也不从更新时间推断覆盖方向。

源码已有 `taskScheduleSyncDecision`：对无法解释的 Task 日期 / scheduled_date 差异返回
`TASK_SCHEDULE_RECONCILIATION_REQUIRED`；明确的 morning_plan 或已有 deadline 语义可保留
独立计划日期。调度对账入口能据此停止投影并记录待对账，但普通 `taskView` / GET / search
原先只返回两个日期及存储的 sync_required，并不调用这个派生判定。
因此旧 `sync_required:false` 与空 last_sync_error 不能证明读取时已经对齐。

最初的 `611ffd16` 读取补丁仅凭该投影判定的 reason 推断计划日期差异，存在组合缺陷：
morning_plan 的 Task/计划日期分离已可解释，但另一个 deadline 时间投影会先返回同名 reason，
从而使读取错误地显示 Task/计划日期待对账。独立复现与修复见下节。

当前读取由 `taskPlannedDateReconciliation` **独立比较 Task 日期与 scheduled_date 这一轴**，
共享已有计划分离依据，不使用投影窗口或 deadline 投影的 reason。
仅当两种日期都为有效完整日期、不同且缺少现有认可的分离依据时，附加：

```json
{
  "date_reconciliation": {
    "required": true,
    "comparison": "task_date_vs_scheduled_date",
    "reason": "TASK_SCHEDULE_RECONCILIATION_REQUIRED",
    "task_date": "2099-01-09",
    "scheduled_date": "2099-01-08",
    "automatic_repair_allowed": false
  }
}
```

这是“需核对原意”的只读信号，不是判定某个日期错误，也不是新的持久状态或权限机制。
Task 日期、planned/requested_date、deadline、原 sync_required、last_synced_at 都保持原样。
它不调用 scheduler，不写回、不建事件、不排自动修复。明确的 get/search 读路径携带该提示；
默认不装配 Schedule 的 list 路径不含此提示，不能声称覆盖所有读取。
日期相同、缺一日期、已有可解释分离、独立 deadline 不因此被强制统一或推断为错误。
畸形或缺失的 Task/计划日期不被当作两个可比较的日期，也不被自动修正；
没有这个冲突提示不代表原始日期已通过有效性检查或已经对齐。

现有 PR9 另含 dueDate 更新别名和写后回读检查；本分支未重复引入那些写路径修复，
也未把日期差异追溯成某一次用户操作。若要决定具体真实事项的日期，需要另行核实原意与
可信变更记录；单凭 Google 更新时间较新或 conversation 无历史，不足以选择覆盖方向。

## 可重现证据与验证

```sh
node scripts/reproduce-rail-reminder.mjs
node --test test/rail-reminder-regression.test.js test/task-date-reconciliation.test.js
npm run verify
```

第一条命令只从固定 Git 基线读取纯函数源码，和当前源码运行同一组虚构输入，
输出 [前后对照 JSON](rail-reminder-reproduction.json)，无网络、凭据或 provider 写入。

先添加的 15 项新回归在旧源码上为 7 通过 / 8 失败；补丁后全通过。
另加一项实际 Google Tasks GET handler 的完全合成集成检查：返回只读提示，
不请求 Task/Calendar/metadata 写入或 scheduler，所有 Auth/provider 边界均是假数据、无真实网络。

`611ffd16` 历史本地结果：**16 项新回归全过；完整 npm run verify 529 项，527 通过，2 项既有跳过，0 失败**。
这是源代码/合成验证，不是远端 CI、生产修复、设备提醒或实际行程验收。

## 日期轴组合缺陷的增量修复

完全合成组合：Task 日期 2099-01-09、计划日期 2099-01-08、morning_plan、无起止时间，
另有 deadline 2099-01-10 / 18:00。旧版投影 guard 比较的是 Task 日期和 deadline，
返回的 scheduled_date 为 null；旧读取层却把同一个 reason 解释成计划日期冲突。

修复只拆开读取比较轴，投影 guard 的独立 deadline 判定保持不变。
morning_plan 组合不再出现错误提示；explicit_user 且计划分离缺乏依据的组合仍会提示，
并明确标注 comparison。非法日历日期、时间戳代替日期、数字和对象等不会被误报为有效日期冲突。

```sh
node scripts/reproduce-date-reconciliation-axis.mjs
node --test test/task-date-reconciliation.test.js test/rail-reminder-regression.test.js
npm run verify
```

[固定 611ffd16 与修复的前后证据](date-reconciliation-axis-reproduction.json)由纯函数真实执行生成，
包含给定组合、无依据的计划分离、畸形 Task 日期和畸形计划日期；四例的投影判定均保持原样。
新增 **15 项**组合/畸形日期用例，并扩展原有实际 GET 合成检查。
这些日期用例在旧代码上 24 项中 8 通过、16 失败；修复后与铁路回归合计 **31 项全过**。
当前完整本地验证 **544 项，542 通过、2 项既有跳过、0 失败**，没有远端 CI 通过记录。

真实事件来源仍未证明。本轮仅刷新了已有 Edge 部署元数据（相关函数仍为 ACTIVE v19），
未读取部署 bundle、真实 Task/Calendar 或广泛日志。缺少已确认关联的 task/event/request 标识与
生成输入/日志记录，且 opaque bundle hash 没有 Git 映射，不能把当前部署版本反推为事件生成版本。
