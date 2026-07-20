# XHS Device Agent

一个面向小红书多手机矩阵的低 Token、只读研究框架。效卫负责连接、投屏、设备分组和人工接管；ADB 负责逐台手机的确定性执行与后验验证；AI 只在主题扩展、未知页面恢复和结果分析等事件发生时介入。

项目默认只读。点赞和收藏只允许在用户明确批准并全程盯着所选机器时，通过固定 `trusted-10` 模板各执行一次；关注、评论、私信、发布、删除和其他外部沟通仍保持人工最终操作。项目不实现随机停留、模拟真人或规避风控。

## 核心能力

- 按 `resource-id`、文字、`content-desc` 和稳定控件关系逐机定位，不共享主控坐标。
- 识别搜索、搜索建议、搜索结果、热搜、推荐、图文、视频、评论区、网络错误、更新弹窗和登录/挑战等页面状态。
- 页面稳定后再行动：500 ms 间隔取得两次相同的归一化 UI 指纹，最长等待 8 秒。
- 按主题、来源和关键词生成工作单元，最多三台设备并行，每台设备内部串行。
- 任务按 `taskId` 幂等，候选跨设备去重，并提供设备隔离、全局熔断和一次离线重分配。
- 已标定页面可完全不调用模型；自动 AI 调用硬上限为每任务 4 次。
- 结果以本地 JSON/JSONL 为真相源，可选镜像到飞书多维表格。

## 前置条件

- Windows 10/11、PowerShell 5.1+
- Android Platform Tools，或效卫自带的 `adb.exe`
- Node.js 18+
- 可选：`lark-cli`，用于同步人工审核队列
- 可选：[效卫安卓投屏](https://www.xiaowei.xin/android)。软件本体不包含在仓库中

## 配置与正式运行闸

先复制配置模板：

```powershell
Copy-Item config/matrix.example.psd1 config/local.psd1
```

在被 Git 忽略的 `config/local.psd1` 中配置：

- 有效的 `AdbPath`；
- 每台手机的两位机器编号、可见名称和内部设备绑定；真实 ADB 序列号与内部绑定都只保存在本地；
- 任务要使用的设备分组，例如 `content`；
- 如需自动输入中文，优先配置 `TextInput.NativeIme`，同时要求 `Enabled`、`HumanApproved` 为真，并把已逐机标定的别名加入 `ApprovedAliases`；设备端 Unicode 桥只作为另行批准的后备通道。

机器目录或分组未完成时，只允许预检和干跑，不运行正式主题分配。PowerShell 包装器和 Node 正式入口都会独立清点 ADB 在线设备，要求全部在线设备有唯一机器编号、可见名称、内部绑定和显式分组；直接调用 Node 也不能绕过这道门禁。操作者只使用机器编号和名称，名称重复时以编号为准。不要把序列号、内部绑定、账号、截图或 UI XML 写入受版本控制的文件。

先执行只读预检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Matrix-Preflight.ps1 -ProbeApi
```

效卫本地 API 当前按实验通道处理。会员或版本限制导致探测失败时，正式执行仍使用 ADB；效卫继续提供投屏和人工接管。

## 主题研究任务

复制示例任务并修改主题、来源和研究预算：

```powershell
Copy-Item config/research-task.example.json data/my-research-task.json
# 不连接手机，先验证任务、分配、幂等和产物
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Run-TopicResearch.ps1 `
  -TaskPath data/my-research-task.json -DryRun

# 完成真实设备映射后，默认使用 ADB 正式执行
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Run-TopicResearch.ps1 `
  -TaskPath data/my-research-task.json
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
node scripts/sync-research-review.mjs `
  --review data/research/<taskId>/human-review.jsonl `
  --base-token $env:LARK_RESEARCH_BASE_TOKEN `
  --table-id $env:LARK_RESEARCH_TABLE_ID
```

飞书只保存公开候选字段、AI 理由和审核状态，不应写入真实设备序列号。人工选中候选后，先在效卫中只显示一台手机并关闭群控同步，再执行只读交接：

```powershell
.\xhs.cmd handoff review `
  --task data/my-research-task.json `
  --candidate <candidateId> `
  --machine 04 `
  --confirm-single-device-and-sync-off
```

交接脚本只搜索精确候选、验证笔记 ID 或标题并暂停。找不到、匹配多条或详情身份不一致时转人工，不会打开模糊匹配，也不会执行互动。

涉及中文输入时，Hermes 先按设备执行原生输入法盘点和一次中文模式校准，再进行文本动作；每次输入都必须做编辑框精确回显校验，结束后恢复原默认输入法。详见 `docs/INPUT_METHOD_WORKFLOW.md`。

## 目录

- `scripts/xhs-page-engine.mjs`：页面评分、UI 指纹和语义选择器
- `scripts/research-core.mjs`：任务校验、分配、幂等、熔断、去重和结果合并
- `scripts/research-session.mjs`：建议词发现、AI 角色编排、检查点恢复和最终摘要
- `scripts/adb-research-provider.mjs`：只读 ADB 来源适配器和中文输入安全闸
- `scripts/ai-role-runner.mjs`：严格 JSON 输出、缓存和模型调用预算
- `scripts/Run-TopicResearch.ps1`：主题研究入口
- `scripts/Open-ReviewCandidate.ps1`：单机精确候选导航和人工暂停点
- `scripts/Invoke-MatrixAction.ps1`：通用矩阵动作和风险分类
- `scripts/Matrix-Preflight.ps1`：效卫、ADB、在线设备和映射预检
- `scripts/Capture-VisibleWindow.ps1`：Windows 10 上只读、前台可见的效卫窗口截图后备
- `scripts/sync-research-review.mjs`：飞书人工审核队列镜像
- `docs/RESEARCH_AUTOMATION.md`：任务执行与人工交接
- `docs/ACCOUNT_RAMP_UP_AUTOMATION.md`：账号冷启动、只读研究和人工运营流程
- `docs/ARCHITECTURE.md`：状态机、执行层和失败传播
- `docs/SAFETY.md`：操作、数据和模型边界
- `docs/XIAOWEI_MATRIX.md`：效卫矩阵接入和降级策略
- `docs/MACHINE_IDENTITY.md`：面向操作者的机器编号/名称契约与本地映射
- `docs/TAILSCALE_REMOTE_CONTROL.md`：通过 Tailscale + OpenSSH 远程执行 `xhs.cmd`
- `skills/xhs-device-operator/SKILL.md`：Hermes/Codex 操作规程
- `scripts/Collect-PhoneAssets.ps1`：逐台读取硬件、系统、小红书公开主页和 UI 层级
- `scripts/Run-Pipeline.ps1`：一键采集、生成标准 CSV、可选同步飞书
- `scripts/Sync-LarkBase.ps1`：创建必要字段并按设备编号/ADB 序列号更新记录
- `scripts/cloud-vision.mjs`：OpenAI-compatible 云端视觉分类器
- `scripts/greenarrow-api.mjs`：可选的本地 WebSocket API 示例；需要软件侧开放 API
- `skills/xhs-device-operator/SKILL.md`：Hermes/Codex 执行规则
- `docs/ARCHITECTURE.md`：系统结构和页面状态机
- `docs/INPUT_METHOD_WORKFLOW.md`：原生中文输入法与 Hermes 调度流程
- `config/input-methods.example.psd1`：按设备别名配置输入法候选和校准状态
- `docs/SAFETY.md`：数据与操作边界

## 隐私

`.env`、`config/local.psd1`、`data/`、截图、UI XML、OAuth Token、真实设备/账号标识都不得提交。提交前检查工作区和暂存内容，避免把运行产物带入 Git。
