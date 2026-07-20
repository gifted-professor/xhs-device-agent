# 统一只读 Research

Research 用于在有限预算内采集公开搜索建议、搜索结果、热词、推荐候选、公开评论计数和可选脱敏片段。它不执行账户状态变化，不包含随机等待、模拟真人、规避平台控制或自动养号。

## 入口

旧 Research JSON 继续使用 `config/research-task.schema.json`，但入口只是兼容转换器：

```powershell
# 离线转换、编译和审阅；不读取或操作手机
.\xhs.cmd research run `
  --task data/research-task.json `
  --dry-run `
  --json

# 新鲜读取本地分组，只检查选中机器和所需输入能力，输出完整计划
.\xhs.cmd research run `
  --task data/research-task.json `
  --config config/local.psd1 `
  --capability-profile <已接受能力ID> `
  --json

# 正式执行器的技术完整性绑定；不要求用户重复确认同一任务
.\xhs.cmd research run `
  --task data/research-task.json `
  --config config/local.psd1 `
  --capability-profile <已接受能力ID> `
  --confirm-plan-hash <64位哈希> `
  --json
```

兼容层读取任务的 `deviceGroup`，只把该组解析成两位机器号；未选设备、未用能力或额外在线设备不会阻断。干跑时若没有本地配置，`--device` 只决定合成审阅槽位数量，不暴露或绑定真实设备。

Research 不再有第二个包装器或第二套锁。当前用户请求已经授权其明确范围，正式执行器的 planHash 只用于技术完整性。

## 计划内容

转换后的统一任务使用 `research_read_only` 数据源和空的账户动作列表。编译器会：

- 冻结主题、种子、来源、评论模式和 AI 策略；
- 保留任务的查询、笔记、结果滚动、详情滚动、评论面板、评论条数、无新增停止、模型调用和总时间预算；
- 按选中机器顺序确定性划分关键词和总预算；
- 只给有工作分片的机器生成一个 `research.collect` 高层步骤；
- 在计划中展示每台机器的完整分片、任务 ID、预算、并发、停止规则和绑定哈希；
- 用同一张 worker 票据、执行槽租约、快速门禁和全局熔断约束分片中的每次设备操作。

仓库没有永久设备或并发限制。任务提出设备和 `maxParallel`；能力档案描述正式执行器的已测规模，但不阻断命名 HTTP、原子能力或其他项目支持路线。

## 输入与页面安全

中文搜索能力只在本次选中机器上检查，顺序为已验收的效卫文本输入、原生中文输入法、Unicode 输入法。每次输入必须清空旧值、验证焦点、提交前验证精确回显，并恢复输入法；无法证明时停止该 worker。

页面识别优先使用新鲜 UI 层级和语义关系。本地 OCR 和 CPA 只是只读传感器：

- 未知页面先做本地隐私检查；只有同一图像通过双重本地检查并绑定 SHA-256 时才允许受限云感知；
- CPA 不返回动作、坐标、命令、路径或自由提示；
- 当前请求明确包含的登录、身份验证、权限、订单/支付、私信/联系人或账号状态动作可继续，不追加第二次确认；
- 设备/目标漂移先重新观察和绑定，动作结果不确定时不盲目重试；能力缺失则转项目适配通道并记录通用能力缺口。

## 评论与 AI 预算

`commentMode` 只控制公开只读数据：

- `none`：不打开评论区；
- `metadata`：保存公开计数和元数据；
- `deidentified_snippets`：在冻结预算内保存少量脱敏片段。

评论面板预算在发送打开动作前保守预留；中断、失败或模糊结果不会退还。采集在条数上限、滚动上限、结束标记或连续两次无新增时停止。

主题策划、页面恢复和结果分析共享 `maxAutomaticCalls`，公开 Schema 上限为 0–4。没有模型配置时允许零模型调用；AI 失败不能放宽页面、输入或隐私验证。

## 证据与恢复

统一尝试目录位于 `data/tasks/attempts/<attemptId>/`。每台机器保留独立 worker 检查点和 Research 分片目录；候选、人工审核、资源预算、AI 状态和摘要仍写在该机器的忽略目录中。`data/` 不提交，也不因代码清理而删除。

同一尝试中的 worker 只执行自己的编译分片，不自动重分配、换机或转移预算。发送后的未知结果不重发。一次尝试只产生一个终态报告。

人工审核队列仍可显式同步：

```powershell
.\xhs.cmd research sync-review `
  --review <某个分片的human-review.jsonl> `
  --config config/local.psd1 `
  --confirm-external-sync
```

同步是独立的外部写入，需要单独明确确认；它不会获得设备操作权限。
