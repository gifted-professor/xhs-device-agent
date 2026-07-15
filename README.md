# XHS Device Agent

这是一个在 Windows 上运行的小红书多设备受监督自动化项目。所有设备操作只从 `xhs.cmd` 进入；高层任务先确定性编译、完整展示，再由人工确认精确 `planHash`，最后由能力受限的执行器运行。

## 统一任务入口

```powershell
# 离线编译和审阅，不读取设备，也不执行设备操作
.\xhs.cmd task run --spec data/task.json --dry-run

# 只对选中机器做新鲜只读准备，并展示完整计划
.\xhs.cmd task run --spec data/task.json

# 本轮唯一确认边界：重新提交完全相同的计划哈希
.\xhs.cmd task run --spec data/task.json --confirm-plan-hash <64位哈希>
```

任务格式见 `config/task-spec.schema.json`。当前编译器支持：

- Feed、搜索结果和有序小红书 URL 列表；
- 明确机器列表或按偏好确定性选择空闲机器；
- 用户指定浏览数、每台浏览数、并发和有序动作；
- 同一条内容连续点赞与收藏；
- 多个点赞、多个收藏；
- 按评论数区间或标题包含条件选择分支；
- 一次完整复述、一次精确哈希确认。

搜索与 URL 的真机执行还必须有对应的已验收能力档案和设备适配器。没有能力时会在设备导航前拒绝，不会改走旧执行器。

## Feed 兼容命令

旧参数会转换为同一个统一任务，不再拥有独立执行器或限制：

```powershell
.\xhs.cmd feed run `
  --machine 02 `
  --task-id feed-001 `
  --count 11 `
  --like-at 2 `
  --favorite-at 7 `
  --dry-run

.\xhs.cmd feed batch --spec data/legacy-batch.json --dry-run
```

兼容 Batch 会保留每台机器号、每台浏览数、每台任务 ID 和请求的 `maxParallel`。固定 Feed 模板、旧 Feed/Batch 父进程、旧屏障和独立执行器已删除。

## 能力激活

生产执行需要本地、被 Git 忽略的人工接受凭据：

```powershell
.\xhs.cmd capability status --json
.\xhs.cmd capability accept `
  --profile config/profile.json `
  --evidence data/acceptance-evidence.json `
  --confirm-profile-hash <哈希> `
  --confirm-evidence-hash <哈希> `
  --confirm-human
```

能力档案只证明当前实现是否已测试并可安全执行，不是第二套业务政策。它只能接受或拒绝任务，不能缩窄、重排或替换用户参数。

## 仓库与隐私检查

```powershell
.\xhs.cmd repo status --json
.\xhs.cmd repo audit --json
.\xhs.cmd repo policy --json
```

`repo policy` 会检查：

- 被跟踪的私有运行文件；
- origin 远端分支可达历史中的私有对象；
- 固定设备上限、固定 Feed 数量、同序号动作禁令、静态设备互动授权和旧执行器模式；
- AGENTS、Skill 和策略文件中的任务权限契约。

私有运行数据包括 `.env`、`config/local.psd1`、`data/`、截图、UI XML、账号、令牌、会话和真实设备标识。它们不得提交、上传或出现在公开诊断中。

## 安全边界

- 自动账号状态变化仅限批准计划中的 ensure-like 与 ensure-favorite。
- 验证码、登录/身份验证、支付、系统权限、平台风控、私密页面、设备/账号/目标漂移和无法验证的后态会立即停止。
- 不使用随机坐标、随机时序、模拟真人、规避平台控制或自动养号。
- 每个状态变化都有唯一、不可转移的操作槽和预算槽；发送不明确时永不重发。
- 未选中设备的在线、离线或能力异常不阻断选中设备。

## 文档

- [代码库审查与整合状态](docs/CODEBASE_AUDIT.md)
- [Feed 统一任务工作流](docs/FEED_WORKFLOW.md)
- [Feed 运行与排障](docs/FEED_RUNBOOK.md)
- [架构](docs/ARCHITECTURE.md)
- [研究自动化](docs/RESEARCH_AUTOMATION.md)
- [机器身份](docs/MACHINE_IDENTITY.md)
