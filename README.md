# XHS Device Agent

一个面向小红书多手机矩阵的低 Token、只读研究框架。效卫负责连接、投屏、设备分组和人工接管；ADB 负责逐台手机的确定性执行与后验验证；AI 只在主题扩展、未知页面恢复和结果分析等事件发生时介入。

项目的研究流程默认只读。点赞、关注、评论、发布和删除只通过显式命名命令执行，并要求目标设备别名在本地配置中逐项授权；私信、随机停留、模拟真人和规避风控不在这些命令的范围内。

## 唯一操作入口

日常操作只使用项目根目录的统一入口：

```powershell
.\xhs.cmd help
.\xhs.cmd doctor
.\xhs.cmd device list
```

已授权设备可以使用以下语义命令；评论和发布必须提供单行文本：

```powershell
.\xhs.cmd like --device device-01
.\xhs.cmd favorite --device device-01
.\xhs.cmd follow --device device-01
.\xhs.cmd comment --device device-01 --text "评论内容"
.\xhs.cmd publish --device device-01 --text "发布内容"
.\xhs.cmd delete --device device-01
```

这些名称是小红书页面语义动作，不是效卫 WebSocket 的底层 action。授权写在 `Xhs.Interactions.AllowedActionsByAlias`，不要把它们加入 `Xiaowei.Api.AcceptedActionsByAlias`；执行器会按当前页面的 UI 语义定位控件并校验结果。

需要顺序浏览推荐流并在指定位置互动时，使用单设备 Feed 工作流：

```powershell
.\xhs.cmd feed run --device device-01 --task-id feed-001 --count 10 --like-at 5 --favorite-at 10
```

工作流只统计成功打开并验证身份的不同内容。点赞和收藏先检查已激活状态，已完成时不会再次点击；发送边界不明确时，同一任务拒绝重放。详细契约见 [Feed 顺序浏览与指定互动](docs/FEED_WORKFLOW.md)，真机排障和 AI 接管见 [Feed Runbook](docs/FEED_RUNBOOK.md)。

进入详情后执行器会区分图文与视频：图文默认停留 3–6 秒，视频默认停留 10–20 秒。停留值按任务和内容身份稳定生成；期间持续校验小红书前台，视频进度可见时还会验证进度确实变化。可用 `--image-min-seconds`、`--image-max-seconds`、`--video-min-seconds`、`--video-max-seconds` 覆盖默认区间。

旧的 `scripts/*.ps1` 和可执行 Node 文件继续作为内部实现与兼容层，不再要求操作者判断应该调用哪一个。完整的安装、效卫 31 项 API 能力、安全验收、故障处理和回滚步骤见 [效卫设备 Agent 稳定操作指南](docs/XIAOWEI_DEVICE_OPERATOR_GUIDE.md)。

## 核心能力

- 按 `resource-id`、文字、`content-desc` 和稳定控件关系逐机定位，不共享主控坐标。
- 识别搜索、搜索建议、搜索结果、热搜、推荐、图文、视频、评论区、网络错误、更新弹窗和登录/挑战等页面状态。
- 页面稳定后再行动：500 ms 间隔取得两次相同的归一化 UI 指纹，最长等待 8 秒。
- 按主题、来源和关键词生成工作单元，最多四台设备并行，每台设备内部串行。
- 任务按 `taskId` 幂等，候选跨设备去重，并提供设备隔离、全局熔断和一次离线重分配。
- 已标定页面可完全不调用模型；自动 AI 调用硬上限为每任务 4 次。
- 结果以本地 JSON/JSONL 为真相源，可选镜像到飞书多维表格。

## 前置条件

- Windows 10/11、PowerShell 5.1+
- Android Platform Tools，或效卫自带的 `adb.exe`
- Node.js 18+
- 可选：`lark-cli`，用于同步人工审核队列和闭合白名单设备资料
- 可选：[效卫安卓投屏](https://www.xiaowei.xin/android)。软件本体不包含在仓库中

## 配置与正式运行闸

先复制配置模板：

```powershell
Copy-Item config/matrix.example.psd1 config/local.psd1
```

在被 Git 忽略的 `config/local.psd1` 中配置：

- 有效的 `AdbPath`；
- 每台手机的真实 ADB 序列号到公开别名/编号的映射；
- 任务要使用的设备分组，例如 `content`；
- 如需自动输入中文，已完成逐机验收的效卫文本适配器优先；其次是批准并校准的原生中文 IME，再其次是另行批准的 Unicode 输入法。所有路径都必须精确回显并恢复原默认 IME。

真实编号或分组未完成时，只允许预检和干跑，不运行正式主题分配。`xhs.cmd` 是唯一公开入口；原生 PowerShell/CMD 使用 `.\\xhs.cmd`，Git Bash/MSYS 使用 `bash ./xhs.cmd`，不得直接调用内部脚本。PowerShell 包装层和内部 Node 路由都会独立清点 ADB 在线设备，要求全部在线设备有唯一别名和显式分组。内部模块不是第二套操作者入口。不要把序列号、账号、截图或 UI XML 写入受版本控制的文件。

先执行只读预检：

```powershell
.\xhs.cmd doctor
```

效卫本地 API 按 action、设备别名和物理设备绑定逐项验收和路由。旧的全局 `PreferApi` 已废弃：未验收、版本不符、API/ADB 身份不一致或别名改绑时，对应能力保持 ADB。每次效卫请求还必须携带由统一入口会话密钥签发、绑定请求哈希且最长 30 秒有效的一次性能力票据；自制 policy 或直接调用内部 CLI 会在发送前失败。API 动作成功后仍由 ADB/UI 做后验验证。

## 主题研究任务

复制示例任务并修改主题、来源和研究预算：

```powershell
Copy-Item config/research-task.example.json data/my-research-task.json
# 不连接手机，先验证任务、分配、幂等和产物
.\xhs.cmd research run --task data/my-research-task.json --dry-run

# 完成真实设备映射后，默认使用 ADB 正式执行
.\xhs.cmd research run --task data/my-research-task.json
```

任务必须同时满足：

- `mode` 为 `research_read_only`；
- `interactionPolicy` 为 `human_final`；
- 只包含 `search`、`suggestions`、`trending`、`recommended` 来源；
- 不包含点赞、收藏、关注、评论发送、私信、发布、删除或支付字段。

任务和结果的严格接口分别位于 [research-task.schema.json](config/research-task.schema.json) 和 [research-result.schema.json](config/research-result.schema.json)。完整运行方式、AI 触发条件和产物说明见 [只读研究自动化](docs/RESEARCH_AUTOMATION.md)。

## Hermes 的职责

Hermes 只负责按计划把符合 Schema 的任务 JSON 投递到本地。研究执行器负责预检、设备分配、页面导航、预算、熔断、工作单元检查点、幂等和结果合并；不要把手机操作步骤或随机行为时间表写进 Hermes 任务。

重复投递相同 `taskId` 和相同内容时，执行器直接返回原结果，不重复操作设备。相同 `taskId` 对应不同内容会被拒绝。

## AI 配置

复制 `.env.example` 并在本机设置兼容 OpenAI Chat Completions 的端点、密钥和模型。AI 不是运行只读脚本的前置条件：未配置模型时，确定性流程仍可运行，相关 AI 阶段应安全跳过或转人工。

AI 仅承担：

- 首次取得真实搜索建议后，每个新主题最多一次规划，缓存 30 天；
- 本地 UI 指纹连续失败后，单任务最多两次页面恢复；
- 至少取得 5 条候选后，每任务最多一次结果分析；
- 人工主动请求时生成一条可编辑评论草稿，永不填写或发送。

敏感页面、验证码、登录挑战、权限、订单、账号隐私、私信、联系人和支付画面禁止上传模型。未知页必须让两次 Windows 本地 OCR 检查同一个截图文件，并用该文件哈希绑定上传内容；单独声明 `safeToUpload=true` 无效。页面恢复还必须达到 `0.90` 置信度，并能在新的 UI 层级中重新找到语义节点。

## 人工审核与飞书镜像

本地 `data/research/` 是任务执行真相源。需要把审核队列镜像到飞书时，可运行：

```powershell
$env:LARK_RESEARCH_BASE_TOKEN = "已批准的 Base Token"
$env:LARK_RESEARCH_TABLE_ID = "已批准的 Table ID"
.\xhs.cmd research sync-review `
  --review data/research/<taskId>/human-review.jsonl `
  --confirm-external-sync
```

同步入口只接受 `data/research/<taskId>/human-review.jsonl`，并在任何飞书请求前核对 taskId、闭合字段、受本地设备映射批准的别名、值边界和敏感标识；不同任务使用隔离临时负载，同一队列不能并发同步。飞书只保存公开候选字段、AI 理由和审核状态，不写入真实设备序列号或本地路径。人工选中候选后，先在效卫中只显示一台手机并关闭群控同步，再执行只读交接：

```powershell
.\xhs.cmd handoff review `
  --task data/my-research-task.json `
  --candidate <candidateId> --device device-01 `
  --confirm-single-device-and-sync-off
```

交接脚本只搜索精确候选、验证笔记 ID 或标题并暂停。找不到、匹配多条或详情身份不一致时转人工，不会打开模糊匹配，也不会执行互动。

涉及中文输入时，执行器只使用该设备已验收的适配器；每次都要验证前台包和编辑框精确回显，结束后恢复原默认输入法。详见 `docs/INPUT_METHOD_WORKFLOW.md`。

## 关键文件

- `xhs.cmd`：唯一公开入口；`scripts/xhs-agent.mjs` 是其内部命令路由。
- `scripts/xiaowei-action-catalog.mjs`：效卫当前 31 项 API 的严格契约和风险目录。
- `scripts/xiaowei-client.mjs` / `scripts/xiaowei-transport.mjs`：逐项验收门禁、本地 WebSocket 和结果归一化。
- `scripts/Invoke-MatrixAction.ps1`：效卫执行、ADB/UI 后验验证和兼容矩阵动作。
- `scripts/feed-workflow.mjs` / `scripts/feed-device-runner.mjs`：Feed 顺序浏览、checkpoint、幂等互动和真机适配。
- `scripts/adb-research-provider.mjs`：只读研究的逐机语义执行器。
- `docs/XIAOWEI_DEVICE_OPERATOR_GUIDE.md`：操作者主手册。
- `docs/SAFETY.md`：安全唯一事实源。
- `docs/INPUT_METHOD_WORKFLOW.md`：中文输入唯一事实源。
- `docs/RESEARCH_AUTOMATION.md`：只读研究任务契约。
- `docs/HERMES_CAPABILITY_ACCEPTANCE.md`：Hermes 分阶段验收计划。
- `docs/HERMES_RUN_CONTRACT.md`：Hermes 单轮执行、踩坑记录和可复制提示词。
- `skills/xhs-device-operator/SKILL.md`：Agent 执行规程。

## 隐私

`.env`、`config/local.psd1`、`data/`、截图、UI XML、OAuth Token、真实设备/账号标识都不得提交。提交前检查工作区和暂存内容，避免把运行产物带入 Git。
