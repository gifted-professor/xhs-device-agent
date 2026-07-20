# 回复输入全角标点草稿验证失败修复交接

日期：2026-07-18
执行者：kimi（Mac 远程，经 Tailnet HTTPS 网关 + SSH）
测试机器：01（1号机，修复验证）、04（4号机，回归验证）
关联：DCI-0056（verified）、DCI-0039/DCI-0042（回复事务原始修复）

## 问题本质（一句话）

`xhs.comment.reply-input` 的草稿验证失败与机器无关：`xhsDraftEditor` 的草稿过滤器把 **NFKC 归一化后的节点文本** 与 **未归一化的请求文本** 直接 `includes` 比较，草稿含全角字符（如 `！` U+FF01）时过滤恒为空，验证恒失败。

## 为什么此前表现为「01 失败、02/04 通过」

- hermes 的复现文本是 `感谢分享！`（含全角 U+FF01），Codex 在 02/04 的验收文本是 `感谢分享`（4 字，无标点）。
- 全角/半角差异触发过滤器失配，与设备型号、输入法、速度均无关。
- 调查期间曾一度误判为「01 稳定慢、验证窗口不足」；逐次 instrumentation 日志证实草稿 echo 在输入后 ~13s 即精确出现，过滤器失配才是恒败根因。01 的 IME 恢复风暴（编辑器短暂消失数秒）真实存在，但由既有的「按原序号重开一次」兜底即可覆盖。

## 修复内容

1. `scripts/xiaowei-device-read.mjs` → `xhsDraftEditor()`：过滤器两侧统一 `semanticValue`（NFKC）归一化。**核心修复，一行级**。
2. 同文件：`openXhsReplyEditor` 开启等待与 `inputXhsCommentDraft` 输入后验证由固定次数改为**时间预算制**（默认各 150s，可经 runtime 注入 `replyOpenBudgetMs` / `commentDraftVerifyBudgetMs`），轮询间隔分别放宽至 1s / 2.5s，验证前增加 6s 静默窗口。理由：Codex 实测 01 开启阶段曾需 >78.7s（12 次预算仅 ~75s）；次数制预算会随读取提速而反向缩短。
3. `scripts/xhs-remote-gateway.mjs`：`xhs.comment.input` / `xhs.comment.reply-input` 命令超时 120s → 300s，容纳慢速机预算。
4. `tests/xiaowei-device-read.test.mjs`：新增回归测试 `XHS reply input verifies drafts containing full-width punctuation`。

精确匹配、稳定聚焦、状态哈希绑定、「按原序号只重开一次」等安全语义全部保持不变。

## 验证

- 回归测试：65/65 通过；全量 526/526 通过（含账本契约校验）。
- 01 真机（隔离网关 127.0.0.1:17904）：`xhs.comment.reply-input` ordinal=2、文本 `感谢分享！`（含 U+FF01），52s 返回 `status=verified`，`draftLength=5`，未发送。
- 04 回归：同一文本 101s 返回 `verified`，未发送，无退化。
- DCI-0056 已按契约转换为标准 incident 并置 verified（见 `config/device-control-incidents.json`）。

## 待办（需要人工决策）

- 验收标准中「01 号机 `xhs.comment.send` 后评论数 +1」需要**真实发送一条回复**，尚未执行；reply-input 已 verified，发送闭环为独立命令。
- 共享网关 17891 已随仓库迁移至 control_Test 重启，并运行本修复构建（buildId f894a042 前缀）。
- 调查期间 01 的三条测试草稿（均未发送）按帖子留存于 App 内，重进对应帖子的回复框前需先只读确认。
- hermes 早先写入账本末尾的两条非契约记录已转换为 DCI-0056 / DCI-0057（本任务顺带完成）。

## 服务收尾

- 隔离网关 17904：已关闭，端口已确认释放。
- 共享网关 17891：已重启（迁移后新构建），健康，队列为空。
- 01 / 04：已返回小红书首页，无打开的编辑器，本轮未发送任何评论。
