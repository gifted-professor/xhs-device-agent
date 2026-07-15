# Hermes 单轮验收执行契约

这份文件是交给 Hermes 的唯一单轮执行契约。它回答四个问题：读什么、只运行什么、遇到坑能不能自行绕、把证据写到哪里。

本契约适用于效卫公开能力 canary、单机只读研究 canary 和四机验收。完整能力说明见 [效卫设备 Agent 稳定操作指南](XIAOWEI_DEVICE_OPERATOR_GUIDE.md)，验收阶段与通过标准见 [Hermes 小红书只读能力验收流程](HERMES_CAPABILITY_ACCEPTANCE.md)。

## 1. 固定分工

- **Hermes**：唯一真机验收执行者，只按本契约和调用方提供的清单运行，不修改实现。
- **Codex**：在两轮验收之间分析证据、修代码、补测试和更新维护文档；Hermes 活跃时不改核心文件。
- **人工**：选择设备与账号、完成登录或身份验证、批准有状态动作、决定是否进入下一轮。

同一时刻只能有一个设备执行者。若发现其他任务正在操作任一目标手机、效卫窗口或 `config/local.psd1`，Hermes 返回 `executor_conflict`，不运行预检之外的命令。

## 2. 调用方必须提供的交接包

没有完整交接包时，Hermes 只报告 `handoff_incomplete`：

1. 唯一 `acceptanceId`；不得与旧报告或旧输出目录重复。
2. 模式：`operator_canary`、`single_device_research` 或 `four_device_research`。
3. 目标公开别名；不得出现真实 ADB 标识、账号 ID、手机号或 Token。
4. 允许执行的精确命令清单；不能只写“自行测试”。
5. 研究模式下的未使用任务 JSON 绝对路径。
6. 被 Git 忽略的报告路径：`data/acceptance/<acceptanceId>-report.md`。
7. 本轮是否只验 ADB 路径，或要验证已候选授权的效卫 action。
8. 代码与配置已经冻结、没有其他设备执行者的明确声明。
9. 若包含本地状态改变，必须另附本轮人工确认、理由和回滚方法；没有时只能验证入口会拒绝，不能真的执行。
10. 执行器的精确工作目录必须是项目根目录；交接包同时给出命令中使用的项目相对配置、任务和报告路径。

任务“未使用”必须同时满足：`data/research/<taskId>/` 不存在、报告路径不存在、该 `taskId` 没有旧事件或 checkpoint。不得删除旧产物来伪造未使用状态。

### 2.1 Shell 与路径契约

- 调用工具必须通过它的 `workdir`/工作目录字段进入项目根目录，不能把带空格的绝对项目路径拼进 `cd ... && ...`、`cmd /c "..."` 或多层 shell 字符串。
- 项目内的 `--config`、`--task`、`--profile`、`--review` 和报告路径在实际命令中统一使用正斜杠项目相对路径，例如 `data/xiaowei-canary/<acceptanceId>/candidate-config.psd1`。绝对路径只作为交接元数据，不进入嵌套命令字符串。
- 原生 PowerShell/CMD 使用 `.\\xhs.cmd <command>`；Git Bash/MSYS 必须显式使用 `bash ./xhs.cmd <command>`，让同一个 `xhs.cmd` 的 Bash 分支按 `"$@"` 保留参数边界。不得在 Git Bash 中直接执行 `./xhs.cmd`，也不得再套 `cmd.exe /c`。
- 每一次向 shell 提交 `xhs.cmd doctor ...` 都计入 `doctor shell launch count`，即使失败发生在 `xhs.cmd` 或程序逻辑之前。不得把“修正引号”排除在计数外，也不得在同一 `acceptanceId` 下再次提交。
- 若 shell 把一个参数拆成多个 token，统一入口会在发送前拒绝并提示使用项目相对路径。本轮记为 `PREFLIGHT_BLOCKED`，正式命令保持 0；修复交接方式后必须使用新的 `acceptanceId`。

## 3. 开始前必须完整阅读

按顺序阅读：

1. `AGENTS.md`
2. `skills/xhs-device-operator/SKILL.md`
3. `docs/HERMES_RUN_CONTRACT.md`
4. `docs/HERMES_CAPABILITY_ACCEPTANCE.md`
5. `docs/XIAOWEI_DEVICE_OPERATOR_GUIDE.md`
6. `docs/INPUT_METHOD_WORKFLOW.md`
7. `docs/SAFETY.md`
8. `config/xhs-page-rules.json`
9. 调用方给出的精确任务 JSON 或 canary 清单

`config/local.psd1` 和候选验收配置可以传给统一入口，但其中的真实标识不得复制进提示词、报告、普通日志或外部系统。

## 4. 唯一入口

所有操作只能从项目根目录调用 `xhs.cmd`。禁止直接调用：

- `scripts/*.ps1` 或可执行 Node 文件；
- 原始 ADB；
- 效卫 WebSocket、内部 gateway 或临时 JSON；
- Computer Use、坐标点击、群控同步；
- Hermes 自己临时编写的设备脚本。

无设备静态检查：

```powershell
.\xhs.cmd help
.\xhs.cmd api catalog
```

目录必须恰好是：

```text
31 actions = 5 routable + 1 partial + 3 profile_only + 16 catalog_only + 6 blocked
```

任何数量或状态不一致都返回 `catalog_mismatch`，不接触手机。

## 5. 预检只运行一次

```powershell
.\xhs.cmd doctor --config data/xiaowei-canary/<acceptanceId>/candidate-config.psd1
```

只有预期设备全部在线、公开别名唯一、分组明确且没有 blocker 时才继续。要验证效卫 API 时，还必须同时满足：

- 端点是本机 loopback；
- ADB 与效卫看到的设备集合完全一致；
- 效卫版本与候选配置精确一致；
- action 在目标别名自己的清单中；
- `AcceptedDeviceSerialsByAlias` 与该别名当前物理设备精确一致；
- 没有旧的全局 `AcceptedActions`；
- 别名不是原始 ADB 标识。

任一条件失败都返回 `preflight_blocked`。正式研究命令调用次数必须是 0；不得为了通过而改配置、换设备或改版本字符串。

`data/matrix/preflight.json` 可能含本地诊断细节，只能在报告中引用路径，不得复制真实标识。

## 6. 三种验收模式

### 6.1 `operator_canary`

调用方必须逐行给出命令，Hermes 不自行扩展。普通 canary 每次只选一台设备、一个候选 action，不能使用群组。中文输入是唯一例外：只能把 `imeList/selectIme/inputText` 作为固定、不可拆分的三 action 原子 profile bundle 验收。

无需额外确认即可运行的公开能力：

```powershell
.\xhs.cmd device list --config <本轮配置路径>
.\xhs.cmd device screen --device <alias> --config <本轮配置路径>
.\xhs.cmd device ui --device <alias> --config <本轮配置路径>
.\xhs.cmd device open-xhs --device <alias> --config <本轮配置路径>
.\xhs.cmd device open-profile --device <alias> --config <本轮配置路径>
.\xhs.cmd device home --device <alias> --config <本轮配置路径>
.\xhs.cmd device back --device <alias> --config <本轮配置路径>
.\xhs.cmd app list --device <alias> --config <本轮配置路径>
.\xhs.cmd app open --device <alias> --package com.xingin.xhs --config <本轮配置路径>
```

每条命令最多调用一次。命令完成后读取该次新生成的 `data/matrix/runs/<run>/result.json`，记录 `executionChannel`、`executionOutcome`、`verificationChannel` 和 `verificationOutcome`。效卫已经接收但后态无法证明时必须保留 `unknown`，不得重放动作。

`app stop`、熄屏、亮屏和设置入口只有在交接包包含本轮独立人工批准、三字以上理由和明确回滚时才可执行。无人值守验收默认只测试“缺少确认时会在发送前拒绝”。

`catalog_only` 与 `blocked` action 只验证目录状态和公开入口不可达，不得通过内部层、自由 shell 或直接 WebSocket 实际调用。

### 6.2 `single_device_research`

允许一次 dry run：

```powershell
.\xhs.cmd research run --task <TASK_PATH> --dry-run --device <alias> --config <本轮配置路径>
```

dry run 通过后，正式命令只调用一次，且真机目标只由任务 JSON 的单设备 `deviceGroup` 决定：

```powershell
.\xhs.cmd research run --task <TASK_PATH> --config <本轮配置路径>
```

不得在正式命令追加 `--device`，不得改任务、预算、来源、查询或 profile。

### 6.3 `four_device_research`

只有四台分别通过单机 canary 后才允许进入。正式命令同样只调用一次：

```powershell
.\xhs.cmd research run --task <TASK_PATH> --config <本轮配置路径>
```

通过要求：四个不同工作单元、四个不同公开别名、每台一个不同查询；全部 `attempt=0`、`reassignCount=0`、`completed`，无人工审核、无跳过、无全局熔断、无互动，输入审计中的要求项全部为真。

聚合状态即使是 `completed`，只要存在重复工作单元、设备替换、重分配或旧任务复用，本轮仍为 FAIL。

## 7. Hermes 可以自行做的恢复

Hermes 只能依赖统一入口内部已经实现并有测试的确定性恢复：

- 重新获取并等待稳定 UI 层级；
- 关闭一次语义确认的普通更新弹窗；
- 重试一次语义确认的普通网络错误；
- 对已确认的评论面板执行 BACK；
- 使用该别名精确匹配的页面与输入 profile；
- 在焦点编辑框内执行已配置的有界清空；
- 用精确 UI 文本或固定区域本地 OCR 验证回显；
- 恢复原默认输入法和临时启用状态；
- API 结果为 `unknown` 后只做新的独立读取，不重发原动作。

Hermes 不得增加新的点击、坐标、重试、输入法、设备替换、账号切换、网络变化或任务修改。新想到的绕法只能写成“建议修复，未执行”，不是本轮权限。

## 8. 必须立即停止的情况

以下任一情况立即停止目标设备，保留已有证据：

- 登录、验证码、身份验证、申诉、风控或权限挑战；
- 联系人、私信、订单、购物、支付或账号安全页面；
- 发布、编辑、删除、点赞、收藏、关注、评论、回复、分享入口；
- 页面无法唯一分类、目标有多个匹配、坐标未知；
- 编辑框焦点、清空、精确回显或输入法恢复无法验证；
- API 动作已发送但后态不明确；
- 一次性 `device` / `app` canary 的第一次失败；
- 单机交接的第一次缺失、歧义或身份不匹配。

研究的正式工作单元由程序维护连续失败计数：同一设备连续两次健康失败后隔离；两台设备出现同一失败签名时全局熔断；中性跳过不增加也不清零。主题发现的非敏感失败只停止该别名当前尝试，可以继续探测另一个健康设备；敏感 `stopAll` 才停止全部设备。

## 9. 禁止掩盖失败

- 正式研究命令最多调用一次。
- 不复用旧 `taskId`，不删除旧输出，不用新 ID 重跑同一未修复工作单元。
- 不把失败查询搬到另一台手机制造成功。
- 不在运行中修改代码、规则、配置、任务或报告模板。
- 原进程未明确结束时只等待并读取它的 checkpoint，不启动第二个进程。
- `unknown` 不是 `failed`，也不是 `success`；只能靠独立后态读取转为 `verified_after_unknown`。

## 10. 踩坑报告

Hermes 只在调用方给出的 `data/acceptance/<acceptanceId>-report.md` 写一份报告。不得编辑维护文档或页面规则。

报告必须包含：

```text
acceptanceId:
mode:
startedAt / endedAt:
code/config freeze confirmed:
doctor invocation count:
doctor shell launch count:
doctor program entry count:
formal command invocation count:
target aliases:
taskId:
final state: PASS | FAIL | PREFLIGHT_BLOCKED | ABORTED | UNKNOWN
forbidden action count:

每个 canary / 工作单元：
- command 或 unitId / source / query
- device alias
- attempt / reassignCount
- first failing stage
- page state
- failure signature
- executionChannel / executionOutcome
- verificationChannel / verificationOutcome
- input-method audit（仅脱敏布尔值）
- 实际发生的内建恢复
- screenshot / UI XML / event / checkpoint / summary 路径
- 已解决：只能写本轮已有白名单恢复确实解决的项
- 未解决：建议修复，明确标记“未执行”
```

只引用本地证据路径，不复制真实 serial、账号标识、手机号、Token、IME 服务名、原始 OCR 文本或私密 UI 内容。

## 11. 返工闭环

1. Hermes 报告第一个真实卡点并停止，不边测边改。
2. Codex 根据证据修复代码或维护配置，补自动测试并更新文档。
3. 人工确认新的代码冻结点和验收范围。
4. 生成新的 `acceptanceId`；研究任务还必须使用新的、语义不同且未执行过的 `taskId`。
5. Hermes 再按本契约执行一次。

某个绕法只有经过 Codex 审查、进入正式实现、通过测试并写入维护文档后，才能在下一轮成为“内建恢复”。

## 12. 可直接交给 Hermes 的提示词

```text
你是本轮唯一真机验收执行者。先完整阅读 AGENTS.md、skills/xhs-device-operator/SKILL.md、docs/HERMES_RUN_CONTRACT.md、docs/HERMES_CAPABILITY_ACCEPTANCE.md、docs/XIAOWEI_DEVICE_OPERATOR_GUIDE.md、docs/INPUT_METHOD_WORKFLOW.md、docs/SAFETY.md、config/xhs-page-rules.json，以及调用方提供的精确任务或 canary 清单。

本轮 acceptanceId=<ACCEPTANCE_ID>，mode=<MODE>，报告只能写到 <REPORT_PATH>。将命令工具的工作目录直接设置为项目根目录；项目内配置、任务和报告在命令中只用调用方给出的正斜杠相对路径，不把带空格的绝对路径拼进 cd、cmd /c 或嵌套 shell。原生 PowerShell/CMD 只使用 .\xhs.cmd；Git Bash/MSYS 只使用 bash ./xhs.cmd；两者都是同一个公开入口。禁止直接调用 scripts、ADB、效卫 WebSocket、内部 gateway、Computer Use、坐标或临时设备脚本。先确认没有其他设备执行者和文件修改者，再依次运行 help、api catalog，并只向 shell 提交一次 doctor。每次 shell 提交都计数，引号或路径失败也不得在同一 acceptanceId 重试。任何预检 blocker 都写为 PREFLIGHT_BLOCKED，正式命令调用次数保持 0。

预检通过后，只执行交接包中的精确命令。正式 research 命令最多一次，不改 taskId、任务、预算、来源、设备、配置或输入 profile，不重跑失败单元。只允许统一入口内部已有的确定性恢复；新绕法只记录为“建议修复，未执行”。遇到登录、验证码、风控、权限、联系人、私信、订单、支付、互动入口、未知页面、歧义目标、未验证清空/回显/恢复或 after-send unknown，立即停止并保留证据。

报告每个工作单元的公开别名、阶段、页面状态、失败签名、attempt、reassignCount、执行/验证通道、脱敏输入审计和证据路径；不得写真实设备或账号标识、IME 服务、原始 OCR 或私密内容。命令结束后返回 final state、正式调用次数、报告路径、summary/checkpoint 路径和第一个未解决卡点。没有新的明确启动指令时，只阅读，不运行。
```
