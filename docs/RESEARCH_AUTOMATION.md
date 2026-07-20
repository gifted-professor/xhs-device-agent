# 只读主题研究自动化

## 目标与边界

这条流水线用于围绕一个主题采集公开搜索建议、搜索结果、热搜和推荐候选。时间、查询数、滚动数和候选数是研究预算；流水线不包含随机等待、模拟真人、“养号”互动或规避平台控制。

自动执行止于候选和人工审核队列。点赞、收藏、关注、评论发送、私信、发布和删除不会进入任务接口或设备执行器。

## Hermes 任务接口

Hermes 只负责定时投递 JSON 文件。任务应以 [research-task.schema.json](../config/research-task.schema.json) 为准；示例见 [research-task.example.json](../config/research-task.example.json)。

```json
{
  "schemaVersion": 1,
  "taskId": "xhs-20260713-001",
  "mode": "research_read_only",
  "topic": "夏季通勤穿搭",
  "seedKeywords": ["夏季通勤穿搭"],
  "sources": ["search", "suggestions", "trending", "recommended"],
  "deviceGroup": "content",
  "commentMode": "metadata",
  "interactionPolicy": "human_final",
  "budgets": {
    "wallClockSeconds": 1200,
    "maxQueries": 6,
    "maxNotes": 15,
    "maxNotesPerQuery": 5,
    "maxResultScrollsPerQuery": 4,
    "maxNoteScrolls": 3,
    "maxCommentPanels": 5,
    "maxCommentsPerNote": 5,
    "maxNoNewScrolls": 2
  },
  "aiPolicy": {
    "topicPlanner": true,
    "pageFallback": true,
    "resultAnalysis": true,
    "maxAutomaticCalls": 4
  }
}
```

`commentMode` 只控制只读评论数据：

- `none`：不打开评论区；
- `metadata`：在保守详情抽样中只保存公开计数和元数据；
- `deidentified_snippets`：在同一抽样和预算内保存少量脱敏片段。

任何额外互动字段、互动动作值、非 `research_read_only` 模式或非 `human_final` 策略都会在设备操作前被拒绝。

## 运行前检查

1. 从 `config/matrix.example.psd1` 创建被忽略的 `config/local.psd1`。
2. 配置有效 ADB 路径、所有目标手机的两位机器编号、可见名称、内部绑定，以及任务使用的 `deviceGroup`。名称可重复，编号必须唯一。
3. 中文自动输入需要同时启用 `TextInput.UnicodeIme.Enabled` 和 `HumanApproved`，并把已标定别名加入 `ApprovedAliases`；否则保持关闭。
4. 确认没有把真实标识写入模板或 Git。
5. 运行 `xhs.cmd doctor`，并核对 `xhs.cmd device list` 只显示机器编号和名称。
6. API 不可用时保持 ADB 为执行通道；不要绕过效卫会员限制。

正式设备映射未完成时，只运行干跑：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Run-TopicResearch.ps1 `
  -TaskPath config/research-task.example.json -DryRun
```

正式运行使用同一任务入口；执行器必须先验证任务中的分组已映射且设备健康。

## 会话流程

1. 校验任务 Schema、互动禁令和 `taskId`。
2. 预检目标分组，只保留健康设备。
3. 使用主题进入搜索框，先采集真实搜索建议。
4. 只读采集当前热词，合并种子词、建议词、热词和 30 天主题缓存；配置允许时调用一次主题规划 Agent。
5. 将 `(来源, 关键词)` 按稳定哈希分配到设备。
6. 最多三台设备并行；单台设备中的工作单元严格串行。
7. 按来源采集搜索、建议、热搜和推荐；入口不存在时只跳过该来源。
8. 对搜索/推荐工作单元的首个可解析候选做保守详情抽样，区分图文和视频；视频页不通过主画面滑动切换下一条。
9. 按评论模式和预算，从该详情只读采集公开评论计数或少量脱敏片段。
10. 按笔记 ID、元数据哈希和高阈值近似标题跨设备去重。
11. 候选达到 5 条且策略允许时，调用一次研究分析 Agent。
12. 写出候选、摘要和人工审核队列；可选镜像到飞书。

## 中文输入

普通 ADB 文本输入只用于 ASCII。中文关键词按以下顺序处理：

1. 已完成逐机验收的效卫文本 API；
2. 经人工批准并按设备别名标定的 Unicode 输入法；
3. 效卫桌面人工粘贴。

输入能力按设备别名独立探测：某台手机需要人工输入时，会继续探测下一台健康设备；只短路该别名上的搜索/建议工作单元，不把整组标记成故障。输入后必须从新的 UI 层级读取搜索框，确认回显与原关键词完全一致。未配置、输入失败或回显不一致时返回 `human_required`；不会提交乱码，也不会尝试其他未知输入法。

`taskId` 继续保持严格幂等。人工处理或重新批准某台设备的输入适配器后，不会偷偷改写已结束任务；需要继续自动采集时，应复制原任务、使用新的 `taskId` 重新投递。原任务和人工处理记录会完整保留。

## AI 调用预算

| Agent | 触发条件 | 上限 | 输出限制 |
| --- | --- | --- | --- |
| 主题策划 | 已取得建议，主题无有效缓存 | 新主题 1 次 | 意图组、最多 6 个排序查询、排除词 |
| 页面恢复 | 本地指纹和规则连续失败 | 每任务 2 次 | 页面类型、证据、语义目标；禁止坐标 |
| 研究分析 | 至少 5 条候选 | 每任务 1 次 | 聚类、候选排序、内容缺口和理由 |
| 评论辅助 | 人工主动请求 | 按人工请求 | 一条不超过 300 字的可编辑草稿 |

自动角色合计不能超过任务的 `maxAutomaticCalls`，并且 Schema 硬限制为 0–4。主题规划缓存 30 天；页面恢复缓存键为截图内容哈希、提示词版本和模型名。

没有模型配置、主题已有缓存且页面稳定时，执行器可以实现 0 次模型调用。AI 不可用不能放宽页面置信度、互动禁令或中文输入验证。

页面恢复还必须满足：

- 未知页面先尝试两次 Windows 本地 OCR；本地 OCR 只返回页面类型与语义目标，永不返回点击坐标；
- 两次 OCR 都必须对即将上传的同一个本地截图文件成功产生安全检查，并由该文件的 SHA-256 证明绑定；OCR 不可用、空白或哈希不一致时直接转人工；
- 本地 OCR 识别到登录、验证、权限、订单、账号隐私、支付、私信、联系人或风险页面时立即全局停止，不上传模型；
- 独立的 `cloud-vision.mjs` 截图上传入口已禁用，布尔 `safeToUpload` 不能绕过上述证明；
- 画面不含验证码、登录、私信、联系人或支付信息；
- 模型置信度至少 `0.90`；
- 输出不含坐标；
- 刷新 UI 后仍能找到模型描述的允许语义节点。

任一条件不满足即转人工。

## 状态、幂等与熔断

结果状态：

- `completed`：所有计划工作安全完成；
- `partial`：部分来源或设备失败，但有可用结果；
- `human_required`：需要人工输入、验证或安全接管；
- `failed`：没有可用结果或触发不可恢复失败；
- `duplicate`：相同任务已完成，直接返回原产物。

相同 `taskId` 只允许对应同一任务内容。相同内容重复投递不会重复工作；不同内容复用同一 ID 会报冲突。

每个结束的工作单元都会原子写入 `checkpoint.json`。如果进程在最终摘要生成前中断，再次启动同一任务会复用已记录结果，只运行剩余单元；已生成 `summary.json` 的任务则直接返回 `duplicate`。

熔断规则：

- 单台手机连续两次转场失败：隔离该设备；
- 两台手机出现相同失败签名：全局熔断；
- 登录、验证码、风险、支付、私信或权限挑战：立即停止；
- 设备离线：未开始工作最多重分配一次；
- 来源入口不存在：仅跳过来源。

## 结果和审核队列

本地任务目录包含去重候选 JSONL、人工审核 JSONL、摘要 JSON、工作单元检查点和逐设备事件日志。评论面板的全任务预留会先原子写入 `resource-budget.json`；一旦发出打开评论区的动作就保守计数且不退还，所以中断、转场失败或页面无法确认都不能绕过预算。建议词和热词发现写入 `topic-discovery.json`，AI 角色状态写入 `ai-status.json`；满足条件时另有 `analysis.json`。版本变化或全局选择器熔断会按故障签名在输出根目录原子去重，每个新签名只生成一次仅含规则/代码建议权限的维护请求。摘要遵循 [research-result.schema.json](../config/research-result.schema.json)，包含查询数、笔记数、重复数、模型调用数、设备别名、全局熔断和产物路径。

飞书仍是审核镜像，本地 `human-review.jsonl` 是真相源。每次同步会分页拉取全部飞书审核行，再按 `reviewId` 回读 `Review status` 后执行写入；若分页结果不能证明完整，整次同步会在上传前安全停止。旧表中没有 `Review ID` 时，仅在 `candidateKey` 唯一且无歧义时兼容匹配。飞书已由人工改成非待审核状态、而本地仍为待审核时，该状态会先原子回写本地，因此重跑不会把人工决定覆盖成 `pending_review`。若本地与飞书存在两个不同的非待审核状态，同步会安全停止并要求人工解决冲突。所有审核行都携带 `taskId` 和主题。

```powershell
node scripts/sync-research-review.mjs `
  --review data/research/<taskId>/human-review.jsonl `
  --base-token $env:LARK_RESEARCH_BASE_TOKEN `
  --table-id $env:LARK_RESEARCH_TABLE_ID
```

审核行按 `reviewId` 更新，`candidateKey` 仅用于关联候选和兼容旧表。镜像字段只包含审核 ID、候选键、主题、来源、关键词、标题、公开作者、媒体类型、AI 理由、审核状态、设备别名和采集时间。

## 人工最终动作

1. 人工查看 AI 排序和理由；
2. 在本地队列或飞书选中一条候选；
3. 效卫只显示一台手机并关闭所有群控同步；
4. 脚本只导航到对应笔记并暂停；
5. 人工核对页面，决定是否点赞、收藏或评论；
6. 如需评论，人工主动请求草稿，修改后亲自发送。

自动执行器不记录或代替最后一步。

完成第 3 步的单机确认后，使用：

```powershell
.\xhs.cmd handoff review `
  --task data/my-research-task.json `
  --candidate <candidateId> `
  --machine 04 `
  --confirm-single-device-and-sync-off
```

交接只能使用本地 `candidates.jsonl` 中的候选。脚本会按精确笔记 ID 或标题寻找唯一卡片，并在详情页再次验证身份后返回 `pausedForHuman=true`；缺失、歧义或不一致都返回人工处理，不做互动。
