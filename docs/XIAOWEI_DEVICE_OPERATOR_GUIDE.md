# 效卫设备统一操作指南

所有手机操作只通过项目根目录的 `xhs.cmd`。效卫 API、ADB 和本地 OCR 都是内部适配能力，不能被 Hermes 或操作者直接调用来绕过计划、批准、锁、票据、执行槽和状态验证。

## 当前入口

```powershell
.\xhs.cmd help
.\xhs.cmd repo status --json
.\xhs.cmd repo policy --json
.\xhs.cmd capability status --json
.\xhs.cmd task run --spec data/task.json --dry-run --json
```

`task run --dry-run` 只生成不可执行候选，不读取手机。正式候选不带确认哈希，只对选中机器做新鲜只读准备并显示完整计划。只有用户明确确认完全相同的 `planHash` 后，带 `--confirm-plan-hash` 的同一命令才能执行。

Feed、Batch 和 Research 的旧命令只是统一任务转换器：

```powershell
.\xhs.cmd feed run --machine 02 --task-id demo-001 --count 11 --like-at 2 --favorite-at 7 --dry-run --json
.\xhs.cmd feed batch --spec data/legacy-batch.json --dry-run --json
.\xhs.cmd research run --task data/research-task.json --dry-run --json
```

它们没有独立执行器、设备上限、动作限制或确认循环。

## 成功判定

效卫或 ADB 的传输成功、业务码、点击动画、等待时间都不等于任务成功。每次 UI 变化后必须读取新鲜页面状态；确保点赞与确保收藏还必须重新绑定同一目标、读取前态、持久化唯一操作槽、发送一次并验证后态。

结果只报告 `verified`、`noop_already_active`、`failed`、`ambiguous`、`skipped` 或 `human-final`。发送结果不明确时不重发。

## 当前自动动作

当前已实现的自动账户状态动作只有：

- `engagement.ensure_liked`
- `engagement.ensure_favorited`

关注、评论/回复发送、私信、分享、发布、删除、登录/恢复、系统权限、支付以及账号/隐私/安全修改不在自动动作注册表中。用户任务可以决定已实现动作的机器、目标、顺序、次数、条件和并发，但不能把尚未实现的动作变成通用点击或文本输入。

## 机器与并发

操作者使用两位机器号和可见名称。内部别名、序列号和账号标识只存在于被忽略的本地配置。

任务决定选中机器和 `maxParallel`；当前人工接受的能力档案只判断实现是否已验证到该规模，不得重排或缩小任务。未选机器离线、增加或能力异常不阻断目标机器。目标机器身份漂移、离线或缺少任务必要能力时，在 App 导航前停止。

## 强制停止

验证码、平台风控、异常账号状态、意外登录/身份验证、系统权限、订单/支付、私密页面、私信/联系人、不同设备/账号/目标、计划或批准失配、租约/锁/预算/证据损坏、账户状态后态不明确都会立即停止。

不得关闭、接受、绕过、重试或换机继续这些页面。不得使用随机坐标、随机时序、模拟真人、账号养号、互动农场或平台规避行为。

## 详细手册

- [统一架构](ARCHITECTURE.md)
- [安全边界](SAFETY.md)
- [Feed 工作流](FEED_WORKFLOW.md)
- [Feed 真机排障](FEED_RUNBOOK.md)
- [统一 Research](RESEARCH_AUTOMATION.md)
- [Hermes 执行契约](HERMES_RUN_CONTRACT.md)
