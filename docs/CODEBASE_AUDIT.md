# 代码库审查与整合边界

本审查以 Windows 工作区为当前权威源。`xhs.cmd repo audit` 对所有 Git 已跟踪及未忽略文件执行机械分类；私有运行数据只计数、不输出路径，被 `.gitignore` 排除的私有数据也不会被枚举。

## 当前真实调用链

```text
xhs.cmd
→ xhs.ps1
→ scripts/xhs-agent.mjs
├─ doctor / api status → Matrix-Preflight.ps1
├─ device / app / 旧具名动作 → Invoke-MatrixAction.ps1
├─ feed run → Run-FeedWorkflow.ps1 → feed-device-runner.mjs → feed-workflow.mjs
├─ feed batch → Run-FeedBatch.ps1 → feed-batch-runner.mjs
│  └─ 每台机器重新进入 Run-FeedWorkflow.ps1 → 旧 Feed 执行链
└─ research run → Run-TopicResearch.ps1 → run-topic-research.mjs
   └─ research-session.mjs → adb-research-provider.mjs
```

`composite-*` 当前只有 schema、纯编译器、审批、账本、适配器和单 worker 测试库，没有从 `xhs-agent.mjs` 可达的 `plan`/`task` 命令，也没有完整生产父调度器。因此“文件存在、测试通过”不等于 Hermes 已在使用 Composite。

## 分类规则

### 正式保留

页面语义识别、设备/任务锁、机器身份解析、前后状态验证、确保态操作、操作账本、审批哈希、隐私门、CPA 严格 schema、恢复检查点及其测试。远程访问和 Windows 主机维护脚本也保留，但不是设备动作入口。

### 需要整合

公开入口、旧 Feed/Batch/Research 包装器、Composite 候选实现、相关 schema/测试和运行手册。目标是让 `xhs.cmd task ...` 成为唯一计划生命周期入口；旧命令只做闭合转换，不直接拥有另一套互动执行策略。

### 等待删除或重写

固定 `trusted-10` 说明、历史 V1/V1.1 设计稿，以及包含自动处理登录、验证码、支付、任意 ADB/AutoJS、动作重放或自动换机内容的过期文档。删除发生在统一入口通过无真机验收之后。

### 临时文件

`tmp-classify.mjs` 与 `tmp-ocr.mjs`。两者含本地运行痕迹，不提交；文件名和 SHA-256 已记录在仓库外备份清单，内容因隐私边界未进入恢复包。

### 私有运行数据

`data/`（除占位文件）、`.env*`、`config/local.psd1`、输入法本地配置、截图、UI XML、CSV、日志、账号/令牌/会话/凭据材料。它们保持忽略，不提交、不在审查命令中枚举，也不因代码清理而删除用户数据。

审查发现基础 commit 已历史性跟踪一批 `data/`、截图和 UI XML。清理时只从 Git 索引取消跟踪并提交删除记录，本机文件继续保留且由 `.gitignore` 接管；任何报告只显示数量，不显示私有路径。

## 限制审查结论

- 删除或迁移到兼容转换层：Feed 的 `1–50`、点赞/收藏只能各一次、同序号禁止、`trusted-10` 覆盖参数冲突、旧 Batch 的设备数/浏览数业务上限。
- 动态判断：设备数、并发数、状态变化预算、评论预算和候选数由已人工接受的 capability profile 限制；只检查本次选中设备和本次动作所需能力。
- 保留：验证码、登录/身份验证、支付、系统权限、平台风控、私密页面、设备/账号/目标漂移、状态无法确认、审批/哈希/nonce/锁/账本失效，以及不明确状态禁止重发。
- Human-final：关注、评论/回复发送、私信、分享、发布、删除、账号/隐私/安全变更。它们不进入自动设备动作注册表；任务计划只能显示为人工最终步骤。

## 版本对齐

执行任务前运行：

```powershell
.\xhs.cmd repo status --json
.\xhs.cmd repo audit --json
```

Hermes 应把电脑、仓库路径、分支、commit 和未提交文件数写入本次任务证据。Mac/GPFS 只有在显示与 Windows 相同 commit 后才可作为同一代码源运行。
