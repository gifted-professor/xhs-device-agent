# 私信输入、发送与评论回复入口修复交接

日期：2026-07-17  
执行者：Codex  
选中机器：01（1 号机）

## 结果

- `device.input` 已支持同一前台包内唯一、稳定但未聚焦的 `EditText`：内部只聚焦一次并有界等待，输入法切换期间编辑器短暂重建时以两份新鲜 UI 重新绑定。
- `device.tap-text` 新增封闭的 `match: "suffix"` 与显式 `ordinal`。评论元数据末尾的“回复”可按当前页面可视顺序唯一定位，缺少序号时失败关闭。
- 新增 `xhs.dm.send`。它把精确草稿绑定到编辑框同行右侧的发送控件，发送前复核两次，单次触发后要求编辑框清空且聊天区出现独立同文消息。
- 通用 `device.tap-text` 继续绑定来源包；同包出现多个同名“发送”时返回歧义，不猜选、不跨应用点击。

## 真机验收

- 使用隔离命名网关 `127.0.0.1:17892`，1 号机小红书评论区以 `match: "suffix"`、`ordinal: 1` 点击第一条“回复”，返回 verified，并验证回复编辑器出现。
- 私信页初始编辑框为未聚焦状态。`device.input` 自动聚焦并输入“测试”，返回 `exact_focused_editor_ui_echo_after_ime_restore`。
- 私信页实测同时存在两个同包名“发送”节点，证明通用文本点击必须保持歧义即停止。
- `xhs.dm.send` 单次真实发出一条“测试”私信，返回 `expected_dm_draft_and_aligned_send_rechecked_then_editor_clear_and_message_echo`；未跳转到其他应用。
- 没有发送评论回复；调试期间出现过回复草稿，退出输入法后已关闭回复编辑器。

## 接口用法

评论元数据末尾的回复入口：

```json
{"command":"device.tap-text","machine":"01","package":"com.xingin.xhs","text":"回复","match":"suffix","ordinal":1,"expectText":"发送"}
```

私信先输入、后发送：

```json
{"command":"device.input","machine":"01","package":"com.xingin.xhs","text":"测试"}
```

```json
{"command":"xhs.dm.send","machine":"01","expectedDraft":"测试"}
```

失败后应先只读观察，不得直接重发。

## 资源与运行状态

- 共享网关 `127.0.0.1:17891` 未重启，未打断其他任务；它需要在维护窗口重载后才会提供本次新代码。
- 隔离网关只用于本次验证，收尾时停止并释放端口。
- 1 号机结束在小红书私信会话页，编辑框已清空，无待发送私信草稿。

## 事件状态

- DCI-0039：`verified / live_verified`，补充唯一未聚焦编辑器预聚焦、延迟焦点等待和 UI 回显优先的真机证据。
- DCI-0042：`verified / live_verified`，评论元数据 suffix + ordinal 回复入口通过隔离命名 HTTP。
- DCI-0043：`verified / live_verified`，私信精确草稿绑定发送事务通过隔离命名 HTTP。

## 验证范围

- 已增加输入框预聚焦、编辑器重建、UI 回显优先、suffix + ordinal 文本选择、私信发送事务的模块回归。
- 已增加统一 CLI、PowerShell 包装器和命名 HTTP 路由覆盖。
- 全仓测试 505/505 通过；JavaScript 语法检查、PowerShell 解析、仓库策略扫描、事件簿校验和 `git diff --check` 均通过。
- 隔离端口已释放；共享网关健康、队列为空，并且未被本任务重启。
- 回复评论目前只验证到打开回复编辑器；文字输入、发送及回复回显仍需后续单独闭环。
