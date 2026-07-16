# XHS Device Agent

这是一个在 Windows 上运行的多设备手机自动化项目。Agent 默认使用命名 HTTP API，`xhs.cmd` 用于人工调试、兼容流程和能力缺口。用户当前任务就是其明确范围的执行授权，不额外要求 task-id、dry-run、planHash、能力档案或逐步骤确认。

## 可选的统一批量任务入口

```powershell
# 离线编译和审阅，不读取设备，也不执行设备操作
.\xhs.cmd task run --spec data/task.json --dry-run

# 只对选中机器做新鲜只读准备，并展示完整计划
.\xhs.cmd task run --spec data/task.json

# 正式执行器的技术完整性绑定；Agent 可根据当前明确任务连续提交
.\xhs.cmd task run --spec data/task.json --confirm-plan-hash <64位哈希>
```

任务格式见 `config/task-spec.schema.json`。当前编译器支持：

- Feed、搜索结果、有序小红书 URL 列表和只读 Research 分片；
- 明确机器列表或按偏好确定性选择空闲机器；
- 用户指定浏览数、每台浏览数、并发和有序动作；
- 同一条内容连续点赞与收藏；
- 多个点赞、多个收藏；
- 按评论数区间或标题包含条件选择分支；
- 可选完整审阅和精确哈希完整性绑定。

搜索、URL 与 Research 的正式批量执行器已经接入统一票据和执行槽，并使用能力档案描述已测范围。该机制只约束此执行器，不是命名 HTTP 或原子任务的全局许可条件。

## 兼容命令

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

.\xhs.cmd research run --task data/research-task.json --dry-run --json
```

兼容 Batch 会保留每台机器号、每台浏览数、每台任务 ID 和请求的 `maxParallel`。兼容 Research 会保留公开数据来源和有限查询、笔记、评论、模型调用与时间预算，并按选中机器确定性分片。固定模板、旧 Feed/Batch 父进程、旧 Research 命令行执行器和独立确认链已删除。

## 正式批量执行器的能力档案

需要使用正式复合执行器时，可维护本地、被 Git 忽略的能力凭据：

```powershell
.\xhs.cmd capability status --json
.\xhs.cmd capability accept `
  --profile config/profile.json `
  --evidence data/acceptance-evidence.json `
  --confirm-profile-hash <哈希> `
  --confirm-evidence-hash <哈希> `
  --confirm-human
```

能力档案只描述正式执行器当前测试范围，不是第二套业务政策，也不能阻断命名 HTTP、原子能力或项目支持的兼容路线。

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

- 用户明确请求的点赞、收藏、评论、关注、消息、发布、编辑、删除、登录、权限、支付和账号操作均属于当前任务范围；优先使用可验证的高层或原子能力，缺失时转项目适配通道并沉淀通用能力。
- 设备、账号或目标发生漂移时重新观察和绑定；缺少会改变结果的选择时才询问，发送结果不明确时暂停受影响动作且不盲目重发。
- 定位和验证基于新鲜 UI、截图或封闭节点策略，避免无证据的盲点和盲重放。
- 每个状态变化都有唯一、不可转移的操作槽和预算槽；发送不明确时永不重发。
- 未选中设备的在线、离线或能力异常不阻断选中设备。

## 文档

- [代码库审查与整合状态](docs/CODEBASE_AUDIT.md)
- [Feed 统一任务工作流](docs/FEED_WORKFLOW.md)
- [Feed 运行与排障](docs/FEED_RUNBOOK.md)
- [架构](docs/ARCHITECTURE.md)
- [研究自动化](docs/RESEARCH_AUTOMATION.md)
- [机器身份](docs/MACHINE_IDENTITY.md)
