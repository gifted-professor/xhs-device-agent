# 代码库审查与整合状态

Windows 工作区是当前权威源。`xhs.cmd repo status --json` 显示电脑、仓库路径、分支、commit 和未提交文件数；`xhs.cmd repo audit --json` 分类全部 Git 可见文件；`xhs.cmd repo policy --json` 检查私有文件、远端可达历史、旧硬限制、已删除执行器名称和必需权限契约。

## 当前调用链

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
│     → Feed / Search / URL / Research source adapters
├─ feed run / feed batch / research run
│  → Run-TaskCompatibility.ps1
│  → legacy-task-converter.mjs
│  → 与 task run 相同的可选审阅、完整性绑定和执行链
└─ device / app → Invoke-MatrixAction.ps1（只读或明确设备本地动作）
```

固定 Feed 模板、旧 Feed/Batch 父进程、旧屏障、重复 Feed 工作流、独立 Research 包装器和自动账号冷启动模板已删除。Matrix 中不可达的点赞、收藏、关注、评论、发布和删除实现也已删除。

## 文件分类

- 正式保留：页面语义识别、设备锁和任务锁、机器身份解析、状态前后验证、操作账本、计划哈希、一次性批准、执行槽、单调熔断、断点恢复、证据清单、只读 Research 核心和数据适配器。
- 兼容转换：`feed run`、`feed batch` 与 `research run` 只翻译旧参数，不拥有设备上限、动作政策、确认流程或执行器。
- 已删除：临时 OCR/分类脚本、固定模板、重复 Feed/Batch 调度器、独立 Research 入口、账号冷启动自动执行器、不可达 Matrix 外部互动实现和对应过期测试。
- 私有运行数据：`data/`（除 `.gitkeep`）、截图、UI XML、本地配置、账号/令牌/会话材料保持忽略，不因代码清理而删除用户数据。

## 权限与限制结论

- 精确的用户任务是已实现高层动作范围内唯一的业务意图来源。模板只能补默认值。
- 设备数、并发、浏览数、动作数和状态变化预算来自任务，并只与当前人工接受的能力档案比较。
- 只检查选中机器和本次实际使用的能力；其他机器离线或未使用能力异常不是阻断条件。
- 正式复合执行器可使用完整审阅和精确 `planHash` 技术绑定；当前用户请求已经授权其明确范围，不再逐步或二次询问。
- 当前请求明确包含的登录、身份验证、支付、权限、互动和账号状态动作可以继续，不追加第二次确认；目标/身份漂移或状态无法验证时换观察/适配路线，无法判断动作是否已发送时不盲目重发。
- 正式复合注册表当前实现确保点赞与确保收藏；其他用户请求动作可通过命名 HTTP、原子能力或项目支持路线执行，并逐步沉淀到高层注册表。

## 隐私历史

相关远端分支已改写，远端可达对象中 `data/` 只剩 `.gitkeep`，策略扫描的远端私有对象计数为 0。GitHub 若仍按已知旧 SHA 返回缓存对象，需要仓库所有者按 GitHub 官方敏感数据清理流程联系 Support 清除缓存和不可修改引用。

## 验收边界

Feed、Batch、搜索结果、有序直链、只读 Research、统一编译/审阅/协调/账本以及选中设备范围检查均有无真机测试。能力档案只约束正式复合执行器，不是其他真机命名或原子能力的全局门槛。
