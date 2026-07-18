# Hermes 真机验收：刷 6 条帖子 + 第 4 条表情评论

## 任务信息

- 执行 Agent：hermes-agent
- 选中机器：01（1 号机）
- 任务时间：2026-07-16
- 会话 ID：2026-07-16-hermes-comment-live-acceptance
- 共享网关：127.0.0.1:17891（已重启并加载最新代码）

## 执行流程

1. 打开小红书（`app.open`）
2. 依次刷 6 条帖子（`xhs.open-visible --ordinal 1..6`）
3. 重新打开第 4 条帖子（`xhs.open-visible --ordinal 4`）
4. 三段式评论：
   - `xhs.comment.open` → 获取 `editorStateHash`、确认 `commentCount=12`、目标
   - `xhs.comment.input` → 输入 `[微笑R]`，验证 UI 回显
   - `xhs.comment.send` → 验证草稿清空并确认计数增加
5. 验证后态：第 4 条帖子详情页，评论数 **13**，无评论框，无遗留草稿

## 真机验证结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 刷 6 条帖子 | ✅ | `xhs.open-visible` 连续打开 1-6 条均成功 |
| 第 4 条帖子打开 | ✅ | 标题：假的阿迪达斯华夫格？，作者：燁 |
| 评论数（前） | 12 | 同一次 open 确认 |
| 评论框打开 | ✅ | `xhs.comment.open` 返回 HTTP 200 + editorStateHash |
| 表情输入 | ✅ | `xhs.comment.input` 返回 shortcut 分支，draftLength=5 |
| 评论发送 | ✅ | `xhs.comment.send` 返回 HTTP 200，afterCount=13 |
| 评论数（后） | 13 | 通过 `device.ui` 验证 |
| 页面状态 | ✅ | 仍在帖子详情页，无评论框，无草稿 |
| 应用跳转 | ✅ | 未跳转微信/支付宝 |

## 事件状态变更

| Incident | 原状态 | 新状态 | 说明 |
|----------|--------|--------|------|
| DCI-0036 | verified | verified | 补充 Hermes liveAcceptance |
| DCI-0037 | resolved | verified | 仅传 contentDesc 的 selector 已可用 |
| DCI-0038 | resolved | verified | `device.scroll` 真机可用 |
| DCI-0039 | verified | verified | 通用 IME 已真机验证（Codex），Hermes 验证快捷表情 |
| DCI-0040 | verified | verified | 表情评论发送链路已真机验证 |

## 发现的问题

- `xhs.comment.input` 实际返回字段中**不包含 `emptyEditorStateHash`**，但 `xhs.comment.send` 使用 `xhs.comment.open` 返回的 `editorStateHash` 作为 `expectedEmptyEditorStateHash` 可以成功。文档示例中的字段名可能需要调整，但功能可用。

## 关键路径证据

- 能力地图：`docs/XHS_CAPABILITY_ROADMAP.md` 第 39、43 行已更新
- 事件簿：`config/device-control-incidents.json` 已更新并通过校验
- 三段式调用说明：`docs/TAILSCALE_REMOTE_CONTROL.md` 第 346-362 行

## 剩余限制

- 本次验证范围：打开帖子 + 评论三段式流程
- B3–B8 中其他能力（如回复私信）未在本次任务中验证
- 设备仍停留在第 4 条帖子详情页，未返回首页

## 资源释放

- 无临时网关进程
- 共享网关保持运行，健康状态正常
- 1 号机当前状态：小红书帖子详情页，评论数 13

## 操作要点（供后续复用）

```json
{"command":"xhs.comment.open","machine":"01"}
{"command":"xhs.comment.input","machine":"01","text":"[微笑R]","expectedEditorStateHash":"<open返回的hash>"}
{"command":"xhs.comment.send","machine":"01","expectedDraft":"[微笑R]","expectedBeforeCount":12,"expectedTarget":{"title":"...","author":"...","mediaType":"image"},"expectedEmptyEditorStateHash":"<open返回的hash>"}
```

注意：如果 `input` 没有返回 `emptyEditorStateHash`，使用 `open` 返回的 `editorStateHash` 作为 `send` 的 `expectedEmptyEditorStateHash` 可成功。

## 测试副作用

- 本次真机验收实际发出 1 条表情测试评论（第 4 条帖子），未删除。
