# Feed 运行与排障手册

## 开始前

1. 执行 `xhs.cmd repo status --json`，确认 Windows 分支、commit 和工作区状态。
2. 执行 `xhs.cmd capability status --json`，确认当前能力档案是人工接受的精确版本。
3. 先运行 `task run --dry-run` 或 Feed 兼容命令的 `--dry-run`。
4. 运行不带确认哈希的命令，只读取选中机器的在线、解锁、App 版本和所需能力，并展示计划。
5. 人工核对机器、动作、序号、条件、预算、恢复和停止条件后，用完全相同的 `planHash` 再运行一次。

## 兼容 Batch

旧 Batch JSON 仍可读取；设备数、每台浏览数、每台任务 ID 和 `maxParallel` 会原样转换：

```powershell
.\xhs.cmd feed batch --spec data/legacy-batch.json --dry-run
```

Batch 不再有“最多两台”“每台最多十条”“必须全员同时就绪”或独立只读执行器。转换后的计划只服从当前能力档案和统一启动政策。未就绪机器按批准的 `all_ready` 或 `ready_subset_after_deadline` 处理，动作和预算不会转移给其他机器。

## 排障原则

- `review_required`：正常结果；核对计划后再提交哈希。
- `task requires an unaccepted capability`：当前能力档案没有验收该动作，不能改走旧入口。
- `exact plan hash confirmation mismatch`：任务、设备快照或能力已变化；重新审阅。
- `DEVICE_BUSY`：目标机器锁仍有效；死亡进程遗留锁由锁模块清理，活锁不抢占。
- `IDENTITY_DRIFT` / `TARGET_CHANGED`：保留当前屏幕，不替换机器或目标。
- `AMBIGUOUS_AFTER_SEND`：不重发状态变化，打开全局熔断并人工核对。
- 登录、验证码、权限、支付或风控：不关闭、不绕过、不重试。

禁止直接运行内部 PowerShell、Node、ADB、私有 API 或效卫 WebSocket。所有设备操作必须从 `xhs.cmd` 进入。
