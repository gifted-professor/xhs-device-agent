# P1 缺口批量修复交接（给 hermes-agent 真机验收）

日期：2026-07-18
执行者：kimi（Mac 远程，经 Tailnet HTTPS 网关 + SSH）
关联：DCI-0033（verified）、DCI-0055（resolved）、DCI-0056（verified）、DCI-0058、DCI-0059（verified）、DCI-0060、DCI-0061
状态：全部 8 条缺口已处置；测试 533/533 通过；待 hermes 按本文逐条真机验收

---

## 逐条处置与验收指引

### 缺口 1：`xhs.observe` 搜索结果页分类失败（P1）
- **处置**：Codex 已在远程网关公开校验放行 SEARCH_ENTRY/SEARCH_SUGGESTIONS/SEARCH_RESULTS/TRENDING/RECOMMENDED 并补结构化测试；DCI-0057 resolved。本批未再改代码。
- **验收**：搜索关键词到结果页 → `xhs.observe` 返回 SEARCH_RESULTS 且含卡片 ordinal；切「用户」tab 后再 observe 状态正确；首页 observe 不退化。

### 缺口 2：`xhs.dm.send` 验证超时（P1，DCI-0058 resolved）
- **修复**：编辑器清空但气泡 20s 内不可读时返回 `status: "mitigated"`（不再死等超时）；`xhs.dm.send` 命令超时 120s→300s；verified 语义（清空+气泡回显）不变。
- **验收**：私信会话页输入草稿 → `xhs.dm.send` 在 ~20s 内返回 `verified` 或 `mitigated`，不返回 timeout；发送失败场景仍正确报错。

### 缺口 3：全流程性能 187s（P1）
- **处置**：Codex 性能优化已在码（tap-coords 2.17s、back 3.2-4.3s、tap-text 4.51s、open-visible 6.87s，隔离端口实测）。本批未再改。
- **验收**：重跑 29 步全流程基准，对比 187s 基线。

### 缺口 4：话题标签无法单独点击（P1，DCI-0033 verified）
- **根因（本次查明）**：①Windows OCR 运行器解析到 pwsh 7，而 OCR 脚本的 WinRT 互操作只存在于 PowerShell 5.1，故 OCR 恒不可用；②OCR 把汉字逐字空格化后，归一化未合并 `#`/`@` 与汉字间的空格；③locate 只做整行/整词匹配，命不中多标签行内的话题。
- **修复**：OCR 运行器固定 PowerShell 5.1；双侧归一化合并 `#`/`@`+汉字；locate 新增行内连续词窗匹配。
- **已真机验证**：01 点击 `#酸奶推荐` → 跳转话题页，`success`（73s）。
- **验收**：任意含话题标签的帖子，`device.tap-ocr` text 用 `#某话题`、expectText 用「讨论」（话题页稳定可见；「最热/最新」小字 Windows OCR 读不到，勿用作 postcondition）→ 跳转话题页。

### 缺口 5：视觉服务超时/不可用（P1，DCI-0059 verified）
- **根因（本次查明）**：视觉后端其实可用（hermes 配置，kimi-k2.5-vision，实测 12-17s 返回）；失败来自两次观测的模型框抖动（实测约 79px）超过 ±24px 的无障碍级容差。
- **修复**：vision 观测容差改为屏幕相对（max 64px、屏宽 8%）。
- **已真机验证**：01 vision 解析「关注」按钮返回 `resolved`（52s）。
- **验收**：`device.node.resolve` vision 来源解析无文本图标（分享/心形），返回 resolved；注意 LLM 框中心可有 ~80px 误差，点击精度需按目标尺寸评估。

### 缺口 6：带「翻译」按钮的评论无法回复（P2，DCI-0060 resolved）
- **修复**：suffix 匹配容忍尾随「翻译」。
- **验收**：找一条多语言评论（元数据为「…回复 翻译」），`xhs.comment.reply-input` 能找到回复、打开编辑器并 verified；无「翻译」的评论回归不退化。

### 缺口 7：部分评论面板 `xhs.observe` 分类失败（P2，DCI-0055 resolved）
- **修复**：comment-modal 证据正则覆盖 分钟前/小时前/周前/个月前/月前/刚刚 并允许「翻译」后缀。
- **验收**：在含「分钟前+翻译」元数据的评论面板调用 `xhs.observe` 返回 COMMENT_PANEL；常规面板不退化；零评论面板（无任何评论行）当前仍可能分类失败，已另记为已知边界。

### 缺口 8：`device.back` 偶发 fingerprint 不稳（P2，DCI-0061 resolved）
- **修复**：验证改为「新屏幕 600ms 内稳定」或「前台窗口真实移动」双路径；纯动画继续轮询直至失败关闭。
- **验收**：视频详情页连续多次 back 不出现误验证/误失败；静态页面 back 回归不退化。

---

## 附带修复（本批顺带完成）

- **01 回复输入全角标点验证失败**（DCI-0056 verified）：草稿过滤双侧 NFKC 归一化；reply-input 与输入后验证改时间预算制；`xhs.comment.input/reply-input` 超时 300s。01 真机 reply-input verified（52s）、`xhs.comment.send` 817→823 已发送闭环。
- **仓库迁移**：项目已迁至 `Desktop/coding/control_Test/xhs-device-agent`，计划任务已改指；共享网关 17891 运行修复构建（buildId f894a042 前缀）。

## 测试与门禁

- 全量测试 533/533 通过；策略扫描 0 违规；账本契约校验通过。
- 新增测试：dm mitigated、OCR 话题归一化、OCR 5.1 运行器、vision 抖动容差、翻译 suffix、评论面板分类、back 动画双路径，共 8 项。

## 服务收尾

- 隔离网关 17904：用完即关；共享网关 17891 健康，队列为空。
- 01/04 已返回小红书首页，无打开的编辑器。
