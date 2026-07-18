# xhs-device-agent 待修缺口清单（2026-07-18）

> 给修代码的人看。每个缺口包含：问题现象、复现路径、修复建议、验收标准。
> 修复后通知 hermes-agent 真机验证。

---

## 总览

| # | 优先级 | 缺口 | 影响 | 状态 |
|---|--------|------|------|------|
| 1 | P1 | `xhs.observe` 搜索结果页分类失败 | 搜索流程断裂 | open |
| 2 | P1 | `xhs.dm.send` 验证超时 | 私信发送无法确认送达 | mitigated（超时提至300s，根因未修） |
| 3 | P1 | 全流程性能基准 187s | 单帖操作慢 | open |
| 4 | P1 | 话题标签无法单独点击 | 点击话题跳转失败 | open |
| 5 | P1 | 视觉服务 120s 超时 | 图标/OCR fallback 全挂 | open |
| 6 | P2 | 带「翻译」按钮的评论无法回复 | 多语言场景回复失败 | open |
| 7 | P2 | 部分评论面板 `xhs.observe` 分类失败 | 评论观察降级 | mitigated（已绕行） |
| 8 | P2 | `device.back` 偶发 fingerprint 不稳 | 首页返回偶尔 500 | open |

---

## 缺口 1：`xhs.observe` 搜索结果页分类失败

**优先级**：P1  
**发现者**：hermes-agent 2026-07-17  
**相关事件**：`CAPABILITY_GAPS.md` 缺口列表

### 问题现象
- 搜索关键词后进入搜索结果页，调用 `xhs.observe` 返回 502 或无法分类当前页面类型
- 搜索结果页的 UI 结构与首页 feed 不同，`observe` 内部的页面分类器无法识别
- 导致后续流程（点击用户卡片、切换 tab）无法通过命名 API 驱动

### 复现路径
1. 从首页进入搜索页 → 输入关键词 → 点搜索
2. 到达搜索结果页后调用 `xhs.observe machine=01`
3. 返回 502 或分类为 unknown

### 修复建议
1. 在 `xhs.observe` 的页面分类器中增加搜索结果页的特征识别（搜索框 + 结果卡片 + 顶部 tab 栏）
2. 搜索结果页返回结构应包含：当前关键词、可见卡片列表（标题+作者+类型）、当前选中的 tab（全部/用户/商品/视频等）

### 验收标准
- [ ] 搜索结果页 `xhs.observe` 返回 200，`pageType` 为 `SEARCH_RESULT` 或类似
- [ ] 返回内容包含可见卡片的 ordinal、标题、作者、笔记类型（图文/视频）
- [ ] 切换「用户」tab 后再次 observe，返回正确的 tab 状态
- [ ] 首页 feed observe 不退化

---

## 缺口 2：`xhs.dm.send` 验证超时（根因未修）

**优先级**：P1  
**发现者**：hermes-agent 2026-07-17  
**当前缓解**：超时从 120s 提至 300s（kimi 2026-07-18）  
**相关事件**：`CAPABILITY_GAPS.md` 缺口 6

### 问题现象
- 私信发送动作本身成功（截图可见蓝色气泡、输入框清空）
- 但 `xhs.dm.send` API 调用后，内部验证阶段（读 UI 确认发送完成）耗时过长
- UI dump 单次 10-15s，多次重试后总耗时超 35s（原超时），现提至 300s 后大概率不会超时
- **根因**：验证逻辑做了多次完整 UI dump，没有快速确认路径

### 复现路径
1. 进入私信会话页 → `device.input` 输入草稿
2. 调用 `xhs.dm.send machine=01 expectedDraft="测试"`
3. 等待 30-60s 才返回（即使消息已秒发）

### 修复建议
1. **快速验证路径**：发送后先读一次 UI，检查输入框是否清空（1 次 dump 即可），清空即返回 `verified`
2. **降级策略**：2 次 dump 后仍不确定，返回 `mitigated` 而非继续重试
3. **异步选项**：先返回 `accepted`，后台验证完成后更新状态

### 验收标准
- [ ] 私信发送后 20s 内返回（理想 <15s）
- [ ] 返回 `verified` 或 `mitigated`，不返回 `timeout`
- [ ] 实际发送失败时能正确返回 `failed`（输入框未清空）

---

## 缺口 3：全流程性能基准 187s

**优先级**：P1  
**发现者**：hermes-agent 2026-07-17

### 问题现象
完成一次「首页 → 打开帖子 → 点赞 → 返回」的完整流程耗时约 187s。时间分布：

| 步骤 | 耗时 | 占比 | 瓶颈 |
|------|------|------|------|
| `device.tap-coords` | 9-10s | 28% | 每次点击都要完整 UI dump 验证 |
| `device.back` | 7-8s | 23% | 返回后 fingerprint 校验等待 |
| `xhs.open-visible` | 12-14s | 14% | 打开帖子后 observe 验证 |
| `device.ui` / `device.screen` | 4-6s | ~15% | 观察命令本身 |
| 其他 | ~20s | ~20% | 网络、队列等待 |

### 修复建议
1. **`tap-coords` 优化**：点击后不做完整 UI dump 验证，改为快速检查前台包是否变化（<2s）
2. **`device.back` 优化**：fingerprint 校验等待时间从 8s 缩至 3s，或改为异步验证
3. **`open-visible` 优化**：打开帖子后只做一次轻量 observe（检查标题出现），不做完整分类
4. **批量命令**：支持一次性发送「点击 → 等待 → 观察」的原子操作，减少 HTTP 往返

### 验收标准
- [ ] 同样流程（首页→打开帖子→点赞→返回）总耗时 < 60s
- [ ] 单个 `tap-coords` < 4s
- [ ] 单个 `device.back` < 3s
- [ ] 不影响功能正确性（点赞仍能成功、返回仍能到首页）

---

## 缺口 4：话题标签无法单独点击

**优先级**：P1  
**发现者**：hermes-agent 2026-07-16  
**相关事件**：DCI-0033

### 问题现象
- 帖子正文中的多个话题标签（如 `#想穿漂亮衣服 #衣服推荐`）全部位于一个 `TextView` 中
- 没有独立的 clickable span 或子节点
- `device.tap-text` 匹配到整个 TextView 而非某个具体话题

### 复现路径
1. 打开一个包含 `#话题` 的帖子详情
2. 调用 `device.tap-text text="#想穿漂亮衣服"`
3. 无法定位到具体话题，或点击位置错误

### 修复建议
1. **span 定位**：在 `device.tap-text` 中增加模式匹配——找到包含目标文本的 TextView 后，用 OCR 或像素扫描定位 `#xxx` 在文本中的精确坐标，点击该坐标
2. **或新增命令**：`device.tap-pattern` — 在当前页面找到匹配正则的文本并点击其像素位置
3. **备选**：如果 XHS 的 accessibility 暴露了 URLSpan 信息，可以从 span 中提取精确 bounds

### 验收标准
- [ ] 帖子正文中包含多个 `#话题` 时，能精确点击其中一个
- [ ] 点击后页面跳转到话题搜索/聚合页
- [ ] 不误触相邻话题或正文

---

## 缺口 5：视觉服务 120s 超时

**优先级**：P1  
**发现者**：hermes-agent 2026-07-16  
**相关事件**：DCI-0023

### 问题现象
- `device.node.resolve` 使用 `vision` source 时，请求 120 秒后超时
- 视觉后端不可用或未配置
- 所有依赖视觉识别的 fallback 全部失效（图标定位、复杂布局、OCR 命中的场景）

### 影响范围
- 无文本按钮（评论点赞心形、分享图标等）只能走 contentDesc/resourceId
- 复杂布局（筛选面板内选项）坐标定位不稳定
- 小红书 UI 混淆严重，视觉是最可靠的 fallback，当前不可用

### 修复建议
1. 检查视觉服务配置：环境变量、API key、本地模型是否就绪
2. 如果视觉后端确实不可用，`device.node.resolve` 的 vision source 应快速返回明确错误（<5s），而非等 120s
3. 考虑用 Hermes 自带的 `vision_analyze` 作为临时视觉后端

### 验收标准
- [ ] 视觉服务可用时：`device.node.resolve` vision source 10s 内返回结果
- [ ] 视觉服务不可用时：5s 内返回明确错误，不挂死
- [ ] 至少支持「分享图标」「点赞心形」等常见图标的识别

---

## 缺口 6：带「翻译」按钮的评论无法回复

**优先级**：P2  
**发现者**：kimi 2026-07-18  
**相关文档**：`docs/device-task-handoffs/2026-07-18-reply-target-suffix-blocked-by-translate-kimi.md`

### 问题现象
- `xhs.comment.reply-input` 按 suffix 匹配在评论面板中定位「回复」按钮
- 当评论带「翻译」按钮时（含外语/方言评论），元数据节点文本形如 `7分钟前 中国台湾 回复 翻译`
- 文本以「翻译」结尾而非「回复」，suffix 匹配恒不命中

### 复现路径
1. 找一条含外语/方言的帖子（评论区有「翻译」按钮）
2. 调用 `xhs.comment.reply-input machine=01 ordinal=1`
3. 返回 `Control 回复 was not found in the fresh UI hierarchy`

### 修复建议
- 在 suffix 匹配中改为：匹配 ` 回复` 词边界（空格+回复），允许后面跟随 ` 翻译`
- 或者更通用：匹配文本中包含 `回复` 子串且该子串不在 `翻译` 之前被截断

### 验收标准
- [ ] 带「翻译」按钮的评论可被 reply-input 正确解析并打开回复编辑器
- [ ] 无「翻译」的评论回归不退化
- [ ] 同时有「回复」和「翻译」时，优先匹配「回复」

---

## 缺口 7：部分评论面板 `xhs.observe` 分类失败

**优先级**：P2  
**状态**：mitigated（操作链路已改用 UI/滚动/专用回复事务绕行）  
**相关事件**：DCI-0055

### 问题现象
- 某些帖子的评论面板调用 `xhs.observe` 返回 502 或无法分类
- 已通过改用 `device.ui` + `device.scroll` + `xhs.comment.reply-input` 等专用命令绕行

### 当前状态
- 操作链路已不依赖 `observe` 的评论面板分类
- 但 `observe` 本身仍未修复

### 验收标准（如果要修）
- [ ] 评论面板 observe 返回 200，能识别当前在评论面板
- [ ] 返回可见评论列表（序号、内容摘要、点赞数）

---

## 缺口 8：`device.back` 偶发 fingerprint 不稳

**优先级**：P2  
**发现者**：hermes-agent 2026-07-17

### 问题现象
- 在小红书首页随机点击循环中，6 轮里有 1 轮 `device.back` 返回后
- 服务端报告 `UI did not produce two identical normalized hierarchy fingerprints 500ms apart within 8 seconds`
- 但后续 `xhs.observe` 仍能读到 `HOME_FEED`，说明实际已返回成功

### 修复建议
- fingerprint 校验的容差放宽：允许 minor 差异（如动态时间戳、广告轮播）
- 或缩短等待窗口，以 `observe` 确认页面类型为准

### 验收标准
- [ ] `device.back` 从帖子详情返回首页的成功率 > 95%
- [ ] 偶发 fingerprint 不稳时返回 `mitigated` 而非 `500`

---

## 附：已修复（本轮，无需再动）

| 缺口 | 修复者 | 验证者 | 日期 |
|------|--------|--------|------|
| 回复评论全角标点草稿验证失败 (DCI-0056) | kimi | kimi + hermes | 2026-07-18 |
| 4号机 UI hierarchy 不完整 (DCI-0049) | codex | hermes | 2026-07-17 |
| 视频详情页完整流程 285s→50.7s | codex | hermes | 2026-07-17 |
| `device.input` 缺失 | codex | hermes | 2026-07-16 |
| 本地网关无法重载 | codex | hermes | 2026-07-16 |
| 跨设备并发串行 | codex | hermes | 2026-07-17 |

---

## 文件位置

| 文件 | 用途 |
|------|------|
| `docs/XHS_CAPABILITY_ROADMAP.md` | 能力地图总表 |
| `docs/CAPABILITY_GAPS.md` | 缺口详细报告 |
| `config/device-control-incidents.json` | 事件账本 |
| `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` | 设备控制手册 |
| `docs/device-task-handoffs/` | 交接文档目录 |

---

*报告生成：hermes-agent 2026-07-18*
