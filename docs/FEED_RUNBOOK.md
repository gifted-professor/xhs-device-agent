# Feed 真机运行与 AI 接管手册

本手册用于小红书推荐流顺序浏览、指定序号点赞/收藏，以及运行异常时的恢复和验收。协议字段与计数规则见 [FEED_WORKFLOW.md](FEED_WORKFLOW.md)。

## 0. V1.1 多机只读批次

`feed batch` 与下方 `trusted-10` 是两条独立通道。批次通道只允许推荐流浏览，拒绝点赞、收藏、关注、评论、私信、分享、发布和任何其他互动字段。

```json
{
  "schemaVersion": 1,
  "batchId": "feed-batch-20260715-001",
  "mode": "feed_read_only",
  "maxParallel": 2,
  "runs": [
    { "machine": "04", "taskId": "feed-batch-20260715-001-04", "count": 3 },
    { "machine": "05", "taskId": "feed-batch-20260715-001-05", "count": 3 }
  ]
}
```

先做不连接手机的校验：

```powershell
.\xhs.cmd feed batch --spec data/feed-batch-20260715-001.json --dry-run
```

获得本次明确授权并保持父命令在前台后，才可移除 `--dry-run`。V1.1 规则如下：

- 必须显式给出 1–2 个两位机器编号和互不重复的 task ID；不做动态发现、补位或故障转移。
- 单机时 `maxParallel=1`；双机时必须 `maxParallel=2`。不接受含糊的“双机配置、单机并发”。
- 每台先持有独立设备锁和 task ID 锁。全部锁定后才释放只读预检屏障；全部在线并完成能力快照后才释放统一 GO。
- 父进程维持 attempt-scoped lease。每个 tap、swipe、BACK 或重新拉起前都必须确认 lease 新鲜、GO 已发布且熔断未触发。
- 任一登录、挑战、风险控制、权限、支付、私密页或身份漂移触发全局熔断；两台出现同一失败签名按系统性故障停止。
- checkpoint 是计数真相源：只有 `opened → dwell_verified → actions_verified → returned_verified → committed` 完整闭环才计入 `items`。中断中的条目不计数，也不会在恢复时伪装成完成。
- 批次结果位于 `data/feed-batches/<batch-id>/`；单机 checkpoint 和证据仍位于 `data/feed/<task-id>/`。事件日志带单调 `seq`，原始设备标识不进入公开批次摘要。

`trusted-10` 仍是单机、现场监督、窄范围互动验收，不能放进批次 spec。

## 1. 标准运行

优先可信模板：

```powershell
.\xhs.cmd feed run `
  --template trusted-10 `
  --device device-01 `
  --task-id feed-trusted-001
```

`trusted-10` 固定为 10 条、第 5 条点赞、第 7 条收藏、视频 5 秒，并拒绝冲突覆盖。`device-01` 是文档占位符；运行前先执行 `xhs.cmd device list`，使用当前配置中唯一映射且在线的别名。

需要自定义规格时再使用展开形式：

```powershell
.\xhs.cmd feed run `
  --device device-01 `
  --task-id feed-test-001 `
  --count 10 `
  --like-at 5 `
  --favorite-at 7 `
  --video-min-seconds 5 `
  --video-max-seconds 5
```

计划停留 5 秒不等于整条只耗时 5 秒。进入详情、两次页面采样、停留后校验和返回首页通常还会增加 10–20 秒。

## 2. 完整执行链路

1. 读取或创建 `checkpoint.json`，核对任务 ID、规格哈希和设备别名；未完成条目保存在 `inFlightItem`，不计入完成数量。
2. `ensureFeed` 检查是否在小红书首页：先多次 BACK，再尝试语义“首页”Tab，仍失败才重新拉起小红书。
3. 连续读取 UI hierarchy；首页以“相同卡片身份和边界”判断语义稳定，详情以“相同页面类型和作者/笔记身份”判断语义稳定。
4. 从当前 Feed 容器中寻找未浏览的卡片，点击后验证为 `IMAGE_NOTE` 或 `VIDEO_NOTE`，并核对卡片与详情身份。
5. 按详情类型停留，每秒验证小红书仍在前台；结束后再次读取详情页。
6. 到指定互动序号时，先读取当前状态：已激活则不点击；未激活则先写入 `send_intent`，只点击一次，再验证选中状态或计数增加。
7. 返回首页并验证 Feed，将条目标记为 `committed` 后才写入 `item_completed`。
8. 达到目标数量后写入 `completed` 和 `summary.json`。

## 3. 自动恢复边界

| 情况 | 自动处理 |
| --- | --- |
| 上次任务遗留在详情页 | 多次 BACK；仍未回首页时重新拉起小红书并找语义“首页”Tab |
| 当前 ROM 不支持 `dumpsys window windows` 焦点格式 | 优先读取完整 `dumpsys window`，再使用 Activity 和旧格式探针 |
| UI dump 短暂失败 | 直接 dump、设备临时文件、再次直接 dump，分级重试 |
| 视频进度、播放时间或计数持续变化 | 详情页按页面类型与稳定身份判断，不要求整页 fingerprint 完全一致 |
| 广告、活动、直播或不支持的 `UNKNOWN` 页面 | 返回首页、记录跳过原因、继续寻找下一张卡片 |
| 卡片与详情身份不一致 | 返回首页并跳过，不计入目标数量 |
| 小红书评分弹窗 | 识别弹窗，BACK 关闭，再回到原详情验证动作结果 |
| 新版动作栏没有“点赞”文字 | 根据同一底栏中“点赞计数 → 收藏 → 评论”的结构识别，点击后用选中状态或计数增加验证 |

自动恢复必须有新鲜 UI 或屏幕证据。禁止复用旧坐标，禁止把其他设备的布局当作当前设备布局。

## 4. 什么时候必须让 AI 看屏幕

下列情况不应继续让固定脚本盲等或盲点：

1. 连续 UI hierarchy 无法分类，或页面为 `UNKNOWN`，但设备屏幕明显仍有内容。
2. `stableUi`、UI dump 或返回首页连续失败，且同一个详情页停留超过正常时间。
3. 找不到点赞/收藏控件，但屏幕上肉眼可见控件。
4. 已写入 `send_intent`，点击后出现弹窗、遮罩、转场或后态不确定。
5. BACK 报验证失败。动作可能已经发送，必须先看新屏幕和新 UI，不能立即重复 BACK。
6. 新版 App 改变页面结构、控件语义或出现从未记录的广告/直播/活动页。
7. 同一失败签名重复出现，需要把一次性判断升级成规则和测试。

AI 接管时先执行只读采集：

```powershell
.\xhs.cmd device screen --device device-01
.\xhs.cmd device ui --device device-01
```

同时检查任务目录中的 `events.jsonl`、`checkpoint.json`、最后两份 XML 和 `failure.png`。AI 应判断：

- 当前真实页面类型；
- 是否有弹窗或遮罩；
- 动作是否已经生效；
- 应关闭弹窗、返回、跳过、重新拉起，还是停止等待人工；
- 是否能从现有证据安全恢复同一任务。

## 5. 互动后的硬规则

`send_intent` 是不可重复发送边界。

- 没有 `send_intent`：允许修复识别逻辑后使用新任务重新验收。
- 已有 `send_intent`，后态明确：用点击前后 XML、屏幕、选中状态或计数变化对账，记录 `action_reconciled` 和 `action_verified`，不得再点。
- 已有 `send_intent`，后态不明确：保持 `unknown`，同一任务不得重放动作。

这条规则同时适用于点赞和收藏，防止一次故障造成取消点赞、取消收藏或重复互动。

## 6. 常见卡点处理表

| 现象/签名 | 先检查 | 处理 |
| --- | --- | --- |
| `feed:app_left_foreground` | 完整 window focus、top activity、最新屏幕 | 确实离开则停止或重新启动；仍在小红书则修复焦点探针 |
| `feed:home_tab_not_found` | 当前是否仍在详情、弹窗或桌面 | 详情先 BACK；弹窗先关闭；桌面重新拉起；最后才找首页 Tab |
| `UI_DUMP_INVALID` | 屏幕是否正常、前台包、远端 XML 是否完整 | 使用分级 dump；屏幕正常但 hierarchy 缺失时由 AI 判断页面并保留证据 |
| `stableUi` 超时 | 两次页面类型与作者/笔记身份是否相同 | 忽略播放时间和动态计数，使用语义稳定；仍无身份则停 |
| `unexpected_page` / `UNKNOWN` | 屏幕是广告、活动、直播、弹窗还是普通笔记 | 可识别的非笔记返回并跳过；新类型交给 AI 建规则 |
| `identity_mismatch` | Feed 卡片身份与详情公开文本 | 返回并跳过，不计数 |
| `action_control_not_found` | 最新截图和底部动作栏结构 | AI 根据同级控件、顺序、计数和边界确认；补规则后测试 |
| `after_send_unknown` | 是否已有 `send_intent`，前后计数/选中状态 | 绝不重点；有充分证据则对账，没有则保持 unknown |
| 返回后仍在详情 | 是否先关闭了弹窗/全屏层，BACK 是否实际发送 | 每次 BACK 后重新 screen + ui；必要时点击语义返回或重新拉起 |

## 7. 完成验收

任务只有同时满足以下条件才算完成：

- `checkpoint.status === "completed"`；
- `items.length` 等于目标数量；
- 每条 `dwell.foregroundVerified === true`，实际停留不少于计划停留；
- 每条 `returnedToFeed === true`；
- 指定互动的 `phase === "verified"` 且 `verification === "verified_active"`；
- `events.jsonl` 最后存在 `completed`；
- 跳过的广告、未知页或身份不一致内容不计入目标数量。

## 8. 证据与复盘

每个任务目录 `data/feed/<task-id>/` 应包含：

- `checkpoint.json`：可恢复状态和每条内容的最终结果；
- `events.jsonl`：完整时间线；
- `summary.json`：最终摘要；
- `evidence/*.xml`：首页、详情、互动前后、返回页；
- `failure.png`：失败时的屏幕。

每次出现新卡点，都应完成“保存证据 → AI/人工判断 → 增加规则 → 增加测试 → 新任务或安全对账后续跑”的闭环，不能只手动把设备拨回首页而不留下规则。

## 9. 2026-07-14 可信基线案例

优先模板基线任务 `codex-feed-runbook-10-20260714-1935`：

- `device-01` 在当前本地配置中不存在，预检在创建任务和发送互动前安全拒绝；核对 `device list` 后改用唯一在线映射 `device-04`；
- 19:35:04 启动，19:40:41 完成，核心流程耗时 5 分 37 秒；
- 完成 10/10，0 跳过、0 失败，9 条图文、1 条视频；
- 10 条均满足前台校验、实际停留不少于计划停留、返回 Feed；
- 第 5 条点赞和第 7 条收藏均为单次 `send_intent`，最终 `verified_active`；
- `checkpoint.status`、`summary.status` 和事件尾部均为 `completed`；
- 任务目录保存 86 份 UI XML，最终另采集首页截图与 UI hierarchy；
- 完整复盘与证据索引见 [可信 Feed 10 条基线](trusted-runs/FEED_TRUSTED_10_20260714.md)。

以下案例保留为评分弹窗和动作对账的恢复样本。

### 评分弹窗恢复案例

任务 `codex-feed-10-like5-favorite7-fast5s-20260714-03`：

- 18:44:40 启动；
- 18:47:37 第 5 条发出点赞；
- 18:47:42 因评分弹窗遮住详情页，后态进入 `unknown`；
- AI 查看失败截图和 UI，确认心形变红、计数 `1124 → 1125`，关闭评分弹窗并对账；
- 18:53:44 从断点恢复；
- 18:54:59 第 7 条收藏验证成功；
- 中途跳过 1 条卡片/详情身份不一致内容；
- 18:57:02 完成 10/10，所有内容返回首页。

最终墙钟耗时 12 分 22 秒，其中约 6 分钟用于定位、修复和对账评分弹窗；两段实际自动执行合计约 6 分 21 秒。
