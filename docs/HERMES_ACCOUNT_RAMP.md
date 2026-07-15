# Hermes 账号冷启动研究执行手册

## 定位

本入口把运营中常说的“养号”限制为可审计的账号冷启动研究：搜索、读取公开页面、在语义容器内滚动、采集候选和生成研究记录。

它不执行随机停留、模拟真人、点赞、收藏、关注、评论、私信、发布、删除、购物、支付、登录验证、设备身份或网络身份变更。

## 一次性准备

1. 把 `config/account-ramp-profile.example.json` 复制到被 Git 忽略的 `data/accounts/<accountAlias>/profile.json`。
2. 只填写不透明的 `accountAlias`、已映射的 `deviceAlias` 和单设备 `deviceGroup`，不填写真实账号、手机号、密码、Token 或设备序列号。
3. 人工确认资料和阶段后，让 `phaseApproval.phase` 与 `phase` 完全一致，并记录批准时间。
4. 只有 `topic_learning`、`content_preparation`、`steady_operation` 可以生成研究任务。其他阶段会在设备操作前停止。

## 正式入口

生成并执行当天第一个任务：

```powershell
.\xhs.cmd ramp run `
  --profile data/accounts/account-01/profile.json `
  --sequence 1
```

只生成任务，不碰设备：

```powershell
.\xhs.cmd ramp run `
  --profile data/accounts/account-01/profile.json `
  --sequence 1 `
  --generate-only
```

使用 Dry Run 验证编排器：

```powershell
.\xhs.cmd ramp run `
  --profile config/account-ramp-profile.example.json `
  --date 2026-07-14 `
  --sequence 1 `
  --dry-run
```

## Hermes 单次调用

```powershell
hermes -z "你是只读账号冷启动研究执行者。阅读 AGENTS.md、skills/xhs-device-operator/SKILL.md、docs/ACCOUNT_RAMP_UP_AUTOMATION.md 和 docs/HERMES_ACCOUNT_RAMP.md。不得修改代码，不得使用零散 ADB，不得执行任何互动、发布、登录、支付、身份或网络变更。只运行 .\xhs.cmd ramp run --profile data/accounts/account-01/profile.json --sequence 1。报告 status、taskId、summaryPath、reportPath；遇到 human_required、partial、failed、登录/验证码/风险页或两次导航失败，立即停止并把证据路径交给 Codex。"
```

Hermes 不得自行修改 `phase`、`phaseApproval`、预算或来源，也不得为了获得 `completed` 而重复使用新序号。失败后的下一轮必须先由 Codex 修复或人工处理，再使用新的任务序号。

## 阶段预算

| 阶段 | 来源 | 候选上限 | 评论面板 | AI 上限 |
| --- | --- | ---: | ---: | ---: |
| `topic_learning` | suggestions、search | 5 | 0 | 2 |
| `content_preparation` | suggestions、search、trending、recommended | 8 | 2 | 3 |
| `steady_operation` | suggestions、search、trending、recommended | 8 | 1 | 2 |

所有阶段固定为 `research_read_only` 和 `human_final`。阶段不会自动升级。

## 产物

- 任务：`data/accounts/<accountAlias>/tasks/<taskId>.json`
- 研究结果：`data/research/<taskId>/`
- 账号运行记录：`data/accounts/<accountAlias>/runs/<taskId>.json`
- 最近状态：`data/accounts/<accountAlias>/state.json`
- 当日人工队列：`data/accounts/<accountAlias>/today-queue.json`

## 人工接力

先在效卫中只显示目标手机并关闭群控同步，再从当日队列选择一个 `candidateId`：

```powershell
.\xhs.cmd handoff ramp `
  --profile data/accounts/account-01/profile.json `
  --candidate <candidateId> `
  --confirm-single-device-and-sync-off
```

入口只会精确打开队列中的一条候选并暂停。点赞、收藏、关注、评论或其他最终动作仍由人工决定和点击。

相同日期和序号会生成相同 `taskId`。内容一致时复用；内容不一致时拒绝覆盖。
