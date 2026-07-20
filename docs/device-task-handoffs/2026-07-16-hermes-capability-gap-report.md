# Hermes 设备控制能力缺口报告

> **报告类型**：能力缺口与修复请求  
> **discoveredBy**：hermes-agent  
> **fixedBy**：Codex（2026-07-17）  
> **verifiedBy**：Codex 隔离网关真机验证；待 Hermes 在共享网关重载后复验  
> **会话 ID**：2026-07-16-hermes-comment-live-acceptance  
> **生成时间**：2026-07-16  
> **选中机器**：01（1 号机）  
> **共享网关**：127.0.0.1:17891

## 2026-07-17 修复回填

- ✅ GAP-001 / TRY-001：`device.input` 现可安全聚焦同包内唯一、稳定但未聚焦的 `EditText`，并容忍输入法切换期间的短暂编辑器重建；1 号机私信页真机输入“测试”返回 verified。
- ✅ GAP-002 / TRY-001：新增 `xhs.dm.send`，以精确草稿、编辑框同行右侧发送控件、草稿清空和独立消息回显完成一次性发送；1 号机已真实发出一条“测试”私信，未跳转其他应用。
- 🔄 TRY-002：`device.tap-text` 新增 `match: "suffix"` + 必填 `ordinal`，1 号机已成功点击第一条评论元数据末尾的“回复”并验证编辑器出现；回复内容输入与发送尚未做完整闭环，因此不标为全量完成。
- ✅ 通用“发送”安全边界：`device.tap-text` 始终绑定来源 `package`，同包同名节点仍歧义即停止。私信页实测存在两个同包“发送”节点，因此发送场景应使用 `xhs.comment.send` 或 `xhs.dm.send`，不能要求通用点击猜选。
- ℹ️ 本次只重载 `127.0.0.1:17892` 隔离网关；共享网关 `17891` 未重启。Hermes 复验前需在维护窗口重载共享网关代码。

---

## 状态图例

- ✅ 已验证：Hermes 已真机验证
- 🔄 部分验证：有 workaround 或局部可用，但未闭环
- ❓ 待验证：地图已有记录，但 Hermes 尚未执行
- ⛔ 明确不做：业务边界
- 🚫 暂不做：当前阶段不投入

---

## 一、Hermes 实测发现的能力缺口（需要立即补）

这些能力是 Hermes 在真机执行时直接踩到的坑，当前代码或接口不足以稳定闭环。

---

### GAP-001：`device.input` 在评论框中焦点丢失

| 字段 | 内容 |
|------|------|
| 状态 | ✅（2026-07-17 修复并真机验证） |
| 影响能力 | 帖子文字评论、回复评论、私信输入 |
| 发现场景 | 在 `xhs.comment.open` 打开评论框后，调用 `device.input` 输入表情/文字 |
| 实际命令 | `{"command":"device.input","machine":"01","text":"[微笑R]"}` |
| 实际响应 | 502，错误信息包含 `The focused editor changed while preparing device.input` |
| 根因判断 | 评论框编辑器在 `device.input` 准备期间被重建或焦点丢失，当前 `device.input` 只适应一次性稳定焦点的输入框 |
| 已验证 workaround | 使用 `xhs.comment.input` 三段式 API 的快捷表情分支可以成功，但通用 `device.input` 在评论场景仍不稳定 |
| 涉及文件 | `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-text-input.mjs` |
| 修复结果 | 通用输入接受唯一稳定的未聚焦编辑器，内部只聚焦一次并有界等待；输入法导致节点重建时以两份新鲜观察改绑，精确 UI 回显优先于 OCR |
| 验证标准 | 1. 打开评论框 2. 直接用 `device.input` 输入文字 3. 返回 200 且 UI 中草稿与输入一致 |
| 相关事件 | DCI-0039（已 verified，但依赖的是 `xhs.comment.input` 而不是通用 `device.input`） |

---

### GAP-002：通用发送按钮点击容易误触其他应用

| 字段 | 内容 |
|------|------|
| 状态 | ✅（安全边界和私信专用发送已验证） |
| 影响能力 | 评论发送、私信发送、任何需要点击右下角“发送”按钮的场景 |
| 发现场景 | 手动拆三段式评论时，尝试用 `device.tap-text` 点击“发送” |
| 实际命令 | `{"command":"device.tap-text","machine":"01","text":"发送"}` |
| 实际响应 | 502，且屏幕跳转到微信/支付宝 |
| 根因判断 | `device.tap-text` 的解析范围或坐标映射不够精确，评论面板/键盘区域的“发送”按钮与底部系统导航/其他应用图标发生误匹配 |
| 已验证 workaround | `xhs.comment.send` 已封装，可稳定发送；但任何需要直接点“发送”的其他页面仍可能踩坑 |
| 涉及文件 | `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/device-tap-text.mjs`、`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-device-read.mjs` |
| 修复结果 | 通用文本点击绑定来源包且同包歧义即停止；评论继续使用 `xhs.comment.send`，私信新增 `xhs.dm.send`，按精确草稿和编辑框同行关系选取发送控件并验证后态 |
| 验证标准 | 1. 在评论框输入文字后 2. `device.tap-text` 点击“发送” 3. 评论数增加，且未离开小红书 |
| 相关事件 | 暂无，建议新增 DCI |

---

### GAP-003：`device.back` 在评论面板/软键盘弹起时多次失败

| 字段 | 内容 |
|------|------|
| 状态 | 🔄 |
| 影响能力 | 关闭评论面板、关闭键盘、从二级页面返回 |
| 发现场景 | 调试 `xhs.comment-emoji` 失败后，尝试用 `device.back` 退出评论面板 |
| 实际命令 | `{"command":"device.back","machine":"01"}` 连续 3 次 |
| 实际响应 | 连续 502，页面仍停留在评论面板 |
| 根因判断 | 软键盘弹起或评论面板为 Dialog/Fragment 时，单次 `KEYCODE_BACK` 不足以关闭；需要识别面板类型并选择关闭策略 |
| 已验证 workaround | 使用 `dev.invoke` 的 `KEYCODE_BACK` 可以成功退出（但这不是稳定公开 API） |
| 涉及文件 | `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-device-read.mjs`、`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xhs-remote-gateway.mjs` |
| 修复建议 | 为 `device.back` 增加软键盘/面板检测：若键盘弹起先关闭键盘；若评论面板打开，先关闭面板；每次发送后等待 UI 状态变化，最多重试 3 次 |
| 验证标准 | 1. 打开评论面板 2. 调用 `device.back` 3. 在 5 秒内回到帖子详情页且返回 200 |
| 相关事件 | DCI-0036（open-visible 的返回逻辑已处理，但通用 back 仍需修复） |

---

### GAP-004：`xhs.comment.input` 返回字段与文档不一致

| 字段 | 内容 |
|------|------|
| 状态 | 🔄 |
| 影响能力 | 三段式评论的 `send` 步骤 |
| 发现场景 | 按 `docs/TAILSCALE_REMOTE_CONTROL.md` 调用 `xhs.comment.input` 后，尝试取 `emptyEditorStateHash` |
| 实际命令 | `{"command":"xhs.comment.input","machine":"01","text":"[微笑R]","expectedEditorStateHash":"..."}` |
| 实际响应 | 返回 `status: verified`，`inputMethod: shortcut`，`draftLength: 5`，但**无 `emptyEditorStateHash` 字段** |
| 根因判断 | 实现与文档不一致，或快捷表情分支没有生成该字段 |
| 已验证 workaround | 用 `xhs.comment.open` 返回的 `editorStateHash` 作为 `send` 的 `expectedEmptyEditorStateHash` 可成功 |
| 涉及文件 | `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-device-read.mjs:1575`、`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/TAILSCALE_REMOTE_CONTROL.md:346` |
| 修复建议 | 方案 A：`xhs.comment.input` 统一返回 `emptyEditorStateHash` 和 `draft`；方案 B：更新文档，说明 `send` 的 `expectedEmptyEditorStateHash` 可用 `open` 的 `editorStateHash` 替代；方案 B 更轻量 |
| 验证标准 | 文档与代码行为一致，且三段式调用不依赖未文档化的字段 |
| 相关事件 | DCI-0039、DCI-0040 |

---

## 二、尚未真机验证，需要 Hermes 先走一遍的能力（发现不行再修）

这些地图上是 ❓ 或 🔄，但 Hermes 还没实际执行。建议按以下顺序逐个走通，失败一项即沉淀为 incident。

---

### TRY-001：回复私信（✅ Codex 真机闭环，待 Hermes 复验）

| 字段 | 内容 |
|------|------|
| 入口 | 作者主页 → `device.tap-text` 或 `device.node.activate` 点击“发私信” |
| 需要验证 | 1. 进入私信页 2. 输入文字 3. 点击发送 4. 验证消息出现在对话中 |
| 预期风险 | `device.input` 在私信输入框可能同样焦点丢失；发送按钮可能误触 |
| 建议 API 序列 | 见下方“尝试序列” |
| 验证结果 | `device.input` 精确回显后，`xhs.dm.send` 单次发送成功；编辑框清空并出现同文消息气泡 |

---

### TRY-002：回复评论（🔄 已打开回复框）

| 字段 | 内容 |
|------|------|
| 入口 | 帖子详情页 → 评论区 → 点击某条评论的“回复”按钮 |
| 需要验证 | 1. 定位评论 2. 打开回复框 3. 输入文字 4. 发送 5. 验证回复出现 |
| 预期风险 | 评论列表滚动、回复框定位、发送按钮与主评论框混淆 |
| 建议 API 序列 | 先尝试 `device.tap-text` 点击“回复”，失败后转 `device.node.activate` 按 contentDesc |
| 验证结果 | `device.tap-text` 使用 `match: "suffix"`、`ordinal: 1` 成功打开回复编辑器；尚未发送真实回复 |

---

### TRY-003：展开评论回复（❓）

| 字段 | 内容 |
|------|------|
| 入口 | 帖子详情页 → 评论区 → 点击“展开 N 条回复” |
| 需要验证 | 1. 定位“展开 x 条回复” 2. 点击后进入子评论列表 3. 能返回主评论列表 |
| 预期风险 | 展开后页面层级变化，无通用返回命令 |

---

### TRY-004：私信列表（❓）

| 字段 | 内容 |
|------|------|
| 入口 | 首页底部“消息”→ 点击“私信” |
| 需要验证 | 1. 进入消息中心 2. 切换到私信列表 3. 读取会话条目 |
| 预期风险 | 私信入口可能无稳定文本，需依赖 contentDesc 或图标 |

---

### TRY-005：搜索商品（❓）

| 字段 | 内容 |
|------|------|
| 入口 | 搜索框输入商品关键词 → 切换到“商品”tab |
| 需要验证 | 1. 搜索关键词 2. 切换到商品 tab 3. 进入商品详情 |
| 预期风险 | 商品 tab 的文本定位、商品详情页结构 |
| 业务依赖 | 如无电商需求，可列为 🚫 |

---

## 三、建议修复优先级

| 优先级 | 能力 | 原因 |
|--------|------|------|
| P0 | GAP-001 `device.input` 评论框焦点 | 阻塞文字评论、私信、回复评论 |
| P0 | GAP-002 通用发送按钮误触 | 阻塞所有发送类能力 |
| P1 | GAP-003 `device.back` 软键盘/面板 | 阻塞二级页面返回、错误恢复 |
| P1 | GAP-004 文档/字段一致性 | 影响后续 Agent 正确调用三段式 API |
| P2 | TRY-001 回复私信 | 高价值商业/社交链路，但已有评论链路可参考 |
| P2 | TRY-002 回复评论 | 高价值互动，实现后社交链路完整 |
| P3 | TRY-003 展开评论回复 | 中价值，依赖回复评论 |
| P3 | TRY-004 私信列表 | 中价值，可配合回复私信一起做 |
| P4 | TRY-005 搜索商品 | 业务决定 |
| P5 | 个人中心、购物链路、消息通知 | 低价值或业务边界 |

---

## 四、可复现的 API 序列（给修复者参考）

### 复现 GAP-001

```json
{"command":"app.open","machine":"01","package":"com.xingin.xhs"}
{"command":"xhs.open-visible","machine":"01","ordinal":1}
{"command":"xhs.comment.open","machine":"01"}
{"command":"device.input","machine":"01","text":"好看"}
```

### 复现 GAP-002

```json
{"command":"xhs.comment.open","machine":"01"}
{"command":"xhs.comment.input","machine":"01","text":"[微笑R]","expectedEditorStateHash":"<open返回的hash>"}
{"command":"device.tap-text","machine":"01","text":"发送"}
```

### 复现 GAP-003

```json
{"command":"xhs.comment.open","machine":"01"}
{"command":"device.back","machine":"01"}
{"command":"device.back","machine":"01"}
{"command":"device.back","machine":"01"}
```

---

## 五、涉及文件清单

| 文件 | 用途 |
|------|------|
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-text-input.mjs` | 文本输入实现，GAP-001 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/device-tap-text.mjs` | 文本点击实现，GAP-002 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xiaowei-device-read.mjs` | 设备读取、评论三段式、返回逻辑，GAP-003/004 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/scripts/xhs-remote-gateway.mjs` | 命令注册与路由，GAP-003 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/TAILSCALE_REMOTE_CONTROL.md` | 三段式调用文档，GAP-004 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/XHS_CAPABILITY_ROADMAP.md` | 能力地图，TRY 系列完成后更新 |
| `C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/config/device-control-incidents.json` | 事件簿，新增缺口沉淀 |

---

## 六、Hermes 当前可用结论

| 能力 | 状态 | 备注 |
|------|------|------|
| 打开帖子 + 点赞 + 收藏 + 评论表情 | ✅ | 已真机闭环 |
| 文字评论 | ✅ | 评论专用三段式已验证；通用 `device.input` 也已补齐未聚焦/重建编辑器处理 |
| 回复评论 | 🔄 | “回复”入口已验证，完整输入发送未验证 |
| 回复私信 | ✅ | Codex 在隔离命名网关完成输入与真实发送，待 Hermes 在共享网关重载后复验 |
| 展开评论回复 | ❓ | 未验证 |
| 其他 | ❓ | 见 TRY 系列 |

---

**下一步**：维护窗口重载共享网关后，由 Hermes 复验 `device.input`、`xhs.dm.send` 和 `device.tap-text` suffix + ordinal；GAP-003 及回复评论完整发送仍是后续独立工作。
