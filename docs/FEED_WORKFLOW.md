# Feed 统一任务工作流

新任务直接使用统一规格：

```powershell
.\xhs.cmd task run --spec data/task.json --dry-run
.\xhs.cmd task run --spec data/task.json
.\xhs.cmd task run --spec data/task.json --confirm-plan-hash <完整计划哈希>
```

旧参数仍可转换，但不再进入旧执行器：

```powershell
.\xhs.cmd feed run `
  --machine 02 `
  --task-id feed-001 `
  --count 11 `
  --like-at 2 `
  --favorite-at 7 `
  --dry-run
```

移除 `--dry-run` 后只做选中设备的只读准备并显示完整计划。必须再次提交完全相同的 `--confirm-plan-hash` 才能执行。多个 `--machine`、同一序号点赞加收藏以及由任务指定的 `--max-parallel` 都会原样进入统一计划，并受当前能力档案约束。

## 计划与执行保证

- Feed 浏览数、动作序号、动作顺序、机器和并发来自任务。
- 每台机器串行执行；总并发由执行槽控制。
- 每次打开详情都绑定新鲜目标指纹；动作前再次确认相同目标。
- 点赞和收藏是 ensure-state，不是盲目切换；已激活时记录 no-op。
- 状态变化前先持久化意图和唯一操作槽；发送后必须用新 UI 验证。
- 发送结果不明确时不重发，并打开全局熔断。
- 读操作可按能力档案短时复用不可变快照；任何 UI 发送后立即失效。
- 达到有限浏览、跳过、滚动或时间预算时准确返回部分完成，不隐式继续搜索。

## 必须停止

遇到验证码、登录/身份验证、支付、系统权限、平台风控、私密页面、设备/账号/目标漂移或状态无法验证时立即停止并保留现场。其他未选中机器离线、锁定或能力异常不影响本任务。

## 证据

运行证据保存在被 Git 忽略的 `data/tasks/<taskId>/` 下，包括审阅计划、批准、attempt manifest、worker 事件、checkpoint、操作账本和终态摘要。公开输出只显示机器号与可见名称，不显示序列号、账号标识、截图路径或令牌。
