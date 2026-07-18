# 评论三段式 API 修复与真机验收交接

日期：2026-07-16  
执行者：codex

## 结果

- 评论流程已拆成三个独立命名 API：`xhs.comment.open`、`xhs.comment.input`、`xhs.comment.send`。
- 预留 1 号机进行真实验收；快捷表情草稿输入成功，发送后同一帖子评论数从 3 增至 4，草稿清空，前台始终保持小红书。
- 初次隔离网关调试与验收实际发出 4 条表情测试评论，分布在 3 个公开帖子；后续共享网关复验另发出 5 条，合计 9 条，本任务未执行删除。
- 改名后的 `xhs.comment.open` 再次通过 HTTP 真机验证，返回评论数 4、帖子绑定和 64 位 `editorStateHash`。
- 使用新 `device.back` 单次关闭空评论框并验证新鲜 UI 变化；结束时无遗留草稿。

## 接口事务

1. `xhs.comment.open`：只打开评论框，返回 `commentCount`、`target`、`editorStateHash`。
2. `xhs.comment.input`：要求同一次打开返回的 `expectedEditorStateHash`，只输入文字或快捷表情，并验证草稿精确回显。
3. `xhs.comment.send`：要求 `expectedDraft`、打开时的 `expectedBeforeCount`、`expectedTarget` 和 `expectedEmptyEditorStateHash`；发送前全部重验，只点击一次。

发送成功要求草稿清空且同一帖子评论数严格增加。高活跃帖子可能同时收到其他评论，所以使用 `afterCount > beforeCount`，不再要求精确 `+1`。若评论面板隐藏计数，执行器只进行一次有界恢复，并按公开帖子身份重新打开同一帖子验证。

## 同步修复

- `device.back` 改走 Xiaowei API，不再依赖本机 ADB 选择器。
- 评论打开返回字段由会被脱敏器误判的 `editorToken` 改为 `editorStateHash`。
- 保留 `xhs.comment-emoji` 作为一次性便捷入口；需要定制文字、表情或分阶段审计时使用三段式 API。
- 通用 `device.input` 已支持输入法切换后编辑器重建；共享网关已用 IME 文字 `好看` 完成输入与发送真机闭环，DCI-0039 已提升为真机验证通过。

## 资源与运行状态

- Xiaowei 私有 API 在验收前按正式 host 命令启用。
- 初次验收使用隔离临时网关 `127.0.0.1:17892`；已停止并确认端口释放。
- 后续在维护窗口重载共享网关 `127.0.0.1:17891`，并直接完成快捷表情与 IME 文字两条评论闭环；共享网关当前健康检查为 `true`。
- Hermes 可直接使用共享网关复验，无需再次加载代码；三段式调用必须沿用同一事务返回的绑定字段。

## 事件状态

- DCI-0039：`verified / live_verified`，评论 IME 文字输入与发送在共享网关通过。
- DCI-0040：复发后重新提升为 `verified / live_verified`，同帖作者规范化与快速计数恢复通过。
- DCI-0036：复发后重新提升为 `verified / live_verified`，延长首页过渡窗口后从详情连续打开通过。

## 验证

- 最终相关模块定向 JavaScript 回归 39/39 通过。
- 全仓测试 502/502 通过。
- JavaScript 语法检查、PowerShell 解析、仓库策略扫描、事件簿校验和 `git diff --check` 均通过。

## 共享网关复验补充

- Hermes 报告的 `comment.open` 502 发生在 `open-visible` 已失败、设备仍在首页之后；后续 `input/send` 400 是缺少事务必填字段，不是命令未注册。
- `xhs.open-visible` 的详情返回首页等待窗口已延长，并在共享网关从详情页连续打开成功。
- 首页卡片的独立“赞”标签曾被并入作者名，导致评论已发送却无法重新定位同帖验证；作者身份现已规范化。
- 发送后草稿清空会立即进入同帖计数恢复，避免客户端在无效轮询中超时。
- IME 文字分支现支持编辑器资源与边界重建、语义空占位、UI 精确回显和恢复输入法后单次重开评论框。
- 共享网关最终真机结果：快捷表情评论 62→63，文字评论 25→26，两个 `xhs.comment.send` 均直接返回 HTTP 200。
- 本次共享网关复验实际发出 5 条评论：4 条快捷表情和 1 条文字；其中一条快捷表情已发送但旧后态验证失败，随后只读复核确认计数增加。本轮未执行删除。
- 共享网关已重载最新代码并保持健康；1号机结束在小红书帖子详情页，无遗留草稿。
