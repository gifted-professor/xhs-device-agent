# Feed 运行与排障手册

## 开始前

1. 执行 `xhs.cmd repo status --json`，确认 Windows 分支、commit 和工作区状态。
2. 对普通命名 HTTP 或原子任务，直接检查选中机器和任务所需能力后执行。
3. 只有需要正式复合执行器的批量、恢复或并发能力时，才查看 capability status 或运行 dry-run。
4. 正式执行器可先准备并展示计划，再以相同 planHash 完成技术绑定。
5. 用户当前请求已明确任务范围时，Agent 连续完成上述技术步骤，不要求用户再次确认同一内容。

## 兼容 Batch

旧 Batch JSON 仍可读取；设备数、每台浏览数、每台任务 ID 和 `maxParallel` 会原样转换：

```powershell
.\xhs.cmd feed batch --spec data/legacy-batch.json --dry-run
```

Batch 不再有“最多两台”“每台最多十条”“必须全员同时就绪”或独立只读执行器。转换后的计划只服从当前能力档案和统一启动政策。未就绪机器按批准的 `all_ready` 或 `ready_subset_after_deadline` 处理，动作和预算不会转移给其他机器。

## 排障原则

- `review_required`：正式执行器的正常中间结果；Agent 可从当前明确任务继续提交哈希。
- `task requires an unaccepted capability`：仅表示正式执行器档案未覆盖；可继续使用命名 HTTP、原子能力或项目支持的兼容路线。
- `exact plan hash confirmation mismatch`：任务、设备快照或能力已变化；重新审阅。
- `DEVICE_BUSY`：目标机器锁仍有效；死亡进程遗留锁由锁模块清理，活锁不抢占。
- `IDENTITY_DRIFT` / `TARGET_CHANGED`：保留当前屏幕，不替换机器或目标。
- `AMBIGUOUS_AFTER_SEND`：不重发状态变化，打开全局熔断并人工核对。
- 登录、验证码、权限、支付或风控：不关闭、不绕过、不重试。

Agent 默认使用命名 HTTP API。`xhs.cmd`、项目 PowerShell/Node 适配器、OCR、vision、开发命令和兼容路线可在对应能力需要时使用。
