# 代码库审查与整合状态

Windows 工作区是当前权威源。`xhs.cmd repo status --json` 显示电脑、仓库路径、分支、commit 和未提交文件数；`xhs.cmd repo audit --json` 分类全部 Git 可见文件；`xhs.cmd repo policy --json` 检查私有文件、远端可达历史、旧硬限制和必需权限契约。

## 当前真实调用链

```text
xhs.cmd
→ xhs.ps1
→ scripts/xhs-agent.mjs
├─ task run
│  ├─ --dry-run → task-runner.mjs
│  └─ live → Run-TaskWorkflow.ps1 → task-live-runner.mjs
│     → composite execution coordinator
│     → composite workflow / operation ledger
│     → composite device adapter
│     → feed-device-runner.mjs（语义设备适配库）
├─ feed run / feed batch
│  → Run-TaskCompatibility.ps1
│  → legacy-task-converter.mjs
│  → 与 task run 相同的审阅、确认和执行链
├─ research run → Run-TopicResearch.ps1 → run-topic-research.mjs
└─ device / app → Invoke-MatrixAction.ps1（只读或设备本地动作）
```

旧 Feed 包装器、批次父进程、旧屏障、重复 Feed 工作流和固定模板已删除。Matrix 中不可达的点赞、收藏、关注、评论、发布和删除实现也已删除。

## 文件分类

- 正式保留：页面语义识别、设备锁和任务锁、机器身份解析、状态前后验证、操作账本、计划哈希、一次性批准、执行槽、单调熔断、断点恢复和证据清单。
- 兼容转换：`feed run` 与 `feed batch` 只翻译旧参数，不拥有设备上限、动作政策、确认流程或执行器。
- 等待整合：旧只读 Research 仍有独立入口；完成统一搜索/研究适配后再删除旧研究编排器。
- 已删除：临时 OCR/分类脚本、固定模板、重复 Feed/Batch 调度器、不可达 Matrix 外部互动实现和过期测试。
- 私有运行数据：`data/`（除 `.gitkeep`）、截图、UI XML、本地配置、账号/令牌/会话材料保持忽略，不因代码清理而删除用户数据。

## 权限与限制结论

- 精确的用户任务是已实现高层动作范围内唯一的业务意图来源。模板只能补默认值；当前固定模板已删除。
- 设备数、并发、浏览数、动作数和状态变化预算来自任务，并只与当前人工接受的能力档案比较。
- 只检查选中机器和本次实际使用的能力；其他机器离线或未使用能力异常不是阻断条件。
- 一次完整审阅、一次精确 `planHash` 确认。确认后按有限计划连续执行，不逐步重复询问。
- 验证码、登录/身份验证、支付、系统权限、平台风控、目标/身份漂移和状态无法验证仍是强制停止。

## 隐私历史

相关远端分支已改写，远端可达对象中 `data/` 只剩 `.gitkeep`，策略扫描的远端私有对象计数为 0。GitHub 若仍按已知旧 SHA 返回缓存对象，需要仓库所有者按 GitHub 官方敏感数据清理流程联系 Support 清除缓存和不可修改引用。

## 当前验收边界

Feed、Batch 和统一任务编译/审阅/批准/协调/账本已通过无真机测试。搜索结果与 URL 任务可编译，但只有在相应能力档案和真机适配器验收后才允许执行；缺少能力时必须在设备导航前失败。Research 兼容转换、Mac/GPFS commit 对齐和 Hermes 02 号机真机验收仍未完成。
