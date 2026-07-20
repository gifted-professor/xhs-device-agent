# 可信 Feed 10 条基线（2026-07-14）

## 结论

任务 `codex-feed-runbook-10-20260714-1935` 已按 `FEED_RUNBOOK.md` 完成并通过全部验收条件，可作为 `trusted-10` 优先模板的真机基线。

## 固定规格

- 目标数量：10；
- 第 5 条：点赞；
- 第 7 条：收藏；
- 视频计划停留：固定 5 秒；
- 单设备串行执行；
- 每次运行必须使用新的任务 ID；
- 机器编号必须来自当前 `xhs.cmd device list`；名称重复时必须使用编号。

推荐入口：

```powershell
.\xhs.cmd feed run `
  --template trusted-10 `
  --machine <当前在线的两位机器编号> `
  --task-id <新的安全任务ID>
```

## 本次验收结果

| 检查项 | 结果 |
| --- | --- |
| 任务状态 | `completed` |
| 完成数量 | 10/10 |
| 跳过 / 失败 | 0 / 0 |
| 图文 / 视频 | 9 / 1 |
| 前台校验 | 10/10 |
| 实际停留不少于计划 | 10/10 |
| 返回 Feed | 10/10 |
| 第 5 条点赞 | `verified / verified_active` |
| 第 7 条收藏 | `verified / verified_active` |
| 最后事件 | `completed` |
| 核心流程耗时 | 336.9 秒 |

## 已闭环卡点

旧 runbook 使用了当前本地配置中不存在的内部绑定。首次调用在任务目录创建和任何互动发送之前安全失败；随后通过 `xhs.cmd device list` 核对，改用在线机器编号 `04`，同一规格完整通过。

模板不固化内部设备绑定，只固化已经验收的内容数量、互动位置和视频停留参数，从而避免把某台机器的配置复制到另一台机器。

## 证据索引

版本库中的完整任务证据位于：

- `data/feed/codex-feed-runbook-10-20260714-1935/checkpoint.json`；
- `data/feed/codex-feed-runbook-10-20260714-1935/events.jsonl`；
- `data/feed/codex-feed-runbook-10-20260714-1935/summary.json`；
- `data/feed/codex-feed-runbook-10-20260714-1935/evidence/`（86 份 UI hierarchy）；
- `data/feed/codex-feed-runbook-10-20260714-1935/final-verification/screen.png`；
- `data/feed/codex-feed-runbook-10-20260714-1935/final-verification/window.xml`。

`checkpoint.json`、`summary.json` 和 `events.jsonl` 是结构化验收真相源；UI XML 证明每条内容进入详情、停留后仍在详情、互动前后状态以及返回 Feed；最终截图与 hierarchy 证明任务结束后设备位于首页“发现”Feed。
