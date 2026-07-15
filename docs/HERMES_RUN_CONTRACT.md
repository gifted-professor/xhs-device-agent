# Hermes 统一任务执行契约

Hermes 只能通过 `xhs.cmd` 提交、复述和执行任务。它不能调用内部脚本、原始 ADB、效卫 WebSocket 或私有 API，也不能自行生成批准。

## 交接包

每次交接必须明确：

- Windows 仓库绝对路径、分支和 commit；
- 任务规范绝对路径及其 SHA-256；
- 能力档案 ID、当前档案哈希和本地人工接受状态；
- 两位目标机器号和可见名称，或 `auto_idle` 的确定性选择要求；
- 数据源、数量、动作顺序、条件、并发、有限预算和停止条件；
- 输出根目录；
- 是否只做干跑、只做候选计划，或执行已确认的精确计划哈希。

内部设备别名、原始序列号、账号、截图、UI XML、令牌、cookie、私信/联系人内容和本地路径证据不得写进公开报告。

## 唯一流程

1. 执行 `xhs.cmd repo status --json`，记录电脑、仓库、分支、commit 和未提交数量。
2. 执行 `xhs.cmd repo policy --json`，要求私有跟踪文件、远端可达私有对象、旧限制和旧执行器引用全部为 0。
3. 用 `xhs.cmd task run --spec <任务> --dry-run` 或对应兼容命令生成非执行候选。
4. 正式运行前不带确认哈希调用同一命令，只做选中机器的新鲜只读准备并输出完整计划。
5. 向用户复述精确机器、来源、顺序、动作、条件、次数、并发、预算、恢复、停止规则和 `planHash`。说明这是本轮唯一确认边界。
6. 只有用户明确确认完全相同的哈希后，才用 `--confirm-plan-hash <hash>` 再调用同一命令一次。
7. 批准后连续执行完整有限计划；中途不重复询问普通业务步骤，也不自动改变机器、目标、动作、预算或并发。
8. 输出一个终态报告，不重复相同 doctor、预检、诊断或运行。

## 命令

原生统一任务：

```powershell
.\xhs.cmd task run --spec <TASK_PATH> --dry-run --json
.\xhs.cmd task run --spec <TASK_PATH> --config <CONFIG_PATH> --json
.\xhs.cmd task run --spec <TASK_PATH> --config <CONFIG_PATH> --confirm-plan-hash <PLAN_HASH> --json
```

兼容入口只负责转换，随后执行完全相同的生命周期：

```powershell
.\xhs.cmd feed run --machine 02 --task-id <ID> --count 11 --like-at 2 --favorite-at 7 --dry-run --json
.\xhs.cmd feed batch --spec <LEGACY_BATCH_PATH> --dry-run --json
.\xhs.cmd research run --task <LEGACY_RESEARCH_PATH> --dry-run --json
```

Research 的正式候选和执行也必须使用 `--capability-profile`、一次完整审阅和 `--confirm-plan-hash`；不得直接运行研究核心或独立包装器。

## 设备与能力范围

- 只检查任务选择的机器和计划实际使用的能力。
- 未选中机器多出、离线、锁定或能力异常只能作为诊断，不阻断目标机器。
- 目标机器离线、身份漂移、锁冲突或缺少必要能力时，必须在 App 操作前失败。
- `maxParallel` 来自任务，只受选中机器数和当前人工接受能力约束。Hermes 不得把它静默改小。
- 机器选择、能力档案、计划内容或哈希有任何实质变化，都必须重新生成并确认计划。

## 运行中边界

每个 worker 必须持有当前父进程票据和执行槽租约。普通只读操作使用内存快速门禁；确保点赞/收藏前后刷新 UI、重绑目标、持久化唯一操作槽并验证后态。

以下情况立即停止并保留当前页面：验证码、登录/身份验证、平台风控、异常账号状态、系统权限、订单/支付、私密页面、私信/联系人、不同设备/账号/目标、批准或计划失配、租约丢失、证据/预算损坏、账户状态后态不明确、人工中断。

不得关闭、接受、绕过或重试这些页面，不得换机、切工具、转移剩余动作或重新发送不明确的账户动作。

## Hermes 报告

终态报告只包含：

- 仓库分支和 commit；
- 计划 ID、计划哈希、能力档案 ID/哈希；
- 选中机器号和可见名称；
- 完成、失败、跳过、模糊、未执行的步骤数；
- 已验证的点赞/收藏 no-op 或完成数；
- Research 的公开计数摘要；
- 全局熔断或人工介入原因；
- 已脱敏的本地证据引用；
- 明确说明是否执行过设备操作。

发送手势、点击动画、等待时间或模型判断不能报告为成功；只有新鲜可见后态和已提交检查点才算完成。
