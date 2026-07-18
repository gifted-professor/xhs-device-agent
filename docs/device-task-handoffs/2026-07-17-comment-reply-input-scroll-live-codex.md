# 评论面板滚动与回复输入闭环修复交接

日期：2026-07-17  
执行者：Codex  
预留机器：02（2号机）、04（4号机）

## 结果

- `device.scroll` 已在两台预留机器的评论面板内通过命名 HTTP 真机验收；每台各执行一次向下滚动并验证新鲜 UI 变化。
- 新增 `xhs.comment.reply-input`。调用方传入当前可见“回复”的序号与文本，服务端在两份新鲜层级中重新解析同一序号。
- 回复编辑器在输入法选择后完全关闭时，只重新打开原序号一次；恢复原输入法后编辑器再次收起时，也只重新打开同一序号并要求精确草稿仍存在。
- 两台机器均完成回复输入和 `xhs.comment.send` 单次发送闭环；草稿清空且同一帖子评论数严格增加。

## 代码与测试

- `scripts/xiaowei-device-read.mjs`：回复序号绑定、编辑器恢复、回复占位判空和精确草稿回显。
- `scripts/xhs-remote-gateway.mjs`：`xhs.comment.reply-input` 命名请求与公开响应契约。
- `scripts/xhs-agent.mjs`、`scripts/Invoke-XiaoweiDeviceRead.ps1`：统一 CLI 与逐机输入配置接线。
- `tests/xiaowei-device-read.test.mjs`：覆盖输入法选择关闭编辑器、同序号恢复和恢复输入法后草稿复核。
- `tests/xhs-remote-gateway.test.mjs`、`tests/xhs-agent-cli.test.mjs`：覆盖路由、参数和结构化响应。

## 设备与服务状态

- 仅操作 02、04；01、03 未操作。
- 使用隔离网关 `127.0.0.1:17904` 验证新代码，验收后已关闭并确认端口释放。
- 共享 `17891` 在队列为空时通过认证排空重载，`codeCurrent=true`，新命令已加载。
- 两台机各真实发送一条中性测试回复；发送动作均只触发一次。
- 02、04 均已返回小红书首页，无编辑器、无草稿。

## 事件状态

- DCI-0038：补充评论面板 `device.scroll` 的真实命名 HTTP 验收证据。
- DCI-0039：补充回复编辑器完全消失后的同序号恢复实现、回归测试和双机真实验收。
- 事故账本中的旧格式性能基准记录已转换为契约兼容的 DCI-0054，原有性能事实保留。
- DCI-0055：`mitigated`。部分评论面板上的 `xhs.observe` 仍可能分类失败；当前评论面板操作改用 `device.ui`、`device.scroll` 和专用回复事务，不影响本次闭环。
