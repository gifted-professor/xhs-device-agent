# 小红书设备控制能力缺口报告

> 本文件记录当前 xhs-device-agent 项目中 **需要代码层修复** 的能力缺口。
> 每个缺口说明：问题现象、影响能力、修复建议、相关事件、验证路径。
> 修复后，请由修复者通知验证者（hermes-agent）重新跑通并沉淀到 `config/device-control-incidents.json`。

---

## 缺口总览

| 优先级 | 缺口 | 影响能力 | 状态 | 相关事件 |
| --- | --- | --- | --- | --- |
| P0 | 缺少文本输入命令 | 搜索、回复私信/评论、昵称修改 | resolved，待真机复验 | DCI-0031 |
| P0 | 本地网关无法重载 | 新 selector 在常驻网关无法生效 | resolved，待维护窗口重启复验 | DCI-0035 |
| P0 | 无文本图标按钮无法定位 | 评论点赞、分享入口、底部导航 | resolved，待分享/消息真机复验 | DCI-0004, DCI-0030, DCI-0032 |
| P0 | 评论编辑器切换输入法后失焦 | 评论、私信及回复评论等重建编辑器 | verified，普通评论与回复评论均已真机通过 | DCI-0039 |
| P0 | “发送”文字点击未绑定来源包和业务后态 | 评论可能点错控件或误判成功 | verified，三段式评论事务已真机通过 | DCI-0040 |
| P1 | 话题标签未拆分为可点击节点 | 点击话题标签 | open | DCI-0033 |
| P1 | 视觉服务超时 | 图标识别、复杂 OCR 定位 | open | DCI-0023 |
| P1 | `xhs.dm.send` API 验证超时 | 私信发送调用方无法确认消息送达 | open | 2026-07-17 hermes-agent |
| P1 | 4 号机 UI hierarchy 不完整 | 04 的 `device.ui` / `scroll` / `observe` 502 | verified（已修复） | 2026-07-17 hermes-agent + codex |
| P2 | Hermes `terminal()` 工具层串行化 | 并发测试方法论；不影响网关本身，但阻碍 hermes-agent 验证并发 | open | 2026-07-17 hermes-agent |
| P2 | `xhs.observe` 搜索结果页分类失败 | 搜索流程中断链，无法确认搜索结果 | open | 2026-07-17 hermes-agent |
| P1 | 全流程性能基准 187s | `tap-coords` 9-10s(28%)、`device.back` 7-8s(23%)、`open-visible` 12-14s(14%) | open | 2026-07-17 hermes-agent |
| P2 | 部分评论面板 `xhs.observe` 分类失败 | 评论面板结构化观察 | mitigated，操作链路改用 UI、滚动和专用回复事务 | DCI-0055 |
| P2 | 视频详情页完整流程耗时 ~6min | 滚动找视频占 56%，open-visible 超时白等 35s | verified（285s→50.7s） | 2026-07-17 hermes-agent + codex |

---

## 缺口 1：缺少文本输入命令

**修复状态（2026-07-16，Codex）**：已实现 `device.input` 的网关、统一入口和效卫适配链路；输入前验证唯一聚焦 `EditText` 与前台包，使用逐机批准的输入法配置，输入后精确验证 UI 或本地 OCR 回显，并在成功/失败路径恢复原输入法。回归测试已通过，尚待 Hermes 真机命名 HTTP 复验。

**补充修复（2026-07-16，Codex）**：输入法切换导致编辑器资源或边界重建时，现从两份新鲜 UI 重新绑定同一包内唯一且自身稳定的新编辑器，只补一次聚焦。评论已拆为 `xhs.comment.open`、`xhs.comment.input`、`xhs.comment.send`；快捷表情与 IME 文字均已在共享网关真机发送成功。文字分支固定使用 EditText 精确 UI 回显，并在恢复输入法收起评论框时只重新打开一次验证原草稿。

**回复编辑器补充修复（2026-07-17，Codex）**：回复编辑器在选择输入法时可能完全消失，无法使用“仍存在节点”的通用重绑定。新增 `xhs.comment.reply-input`，把当前可见回复序号绑定到输入事务；输入法切换或恢复导致编辑器收起时，只重新打开同一序号一次并验证精确草稿。02、04 两台机均完成“评论面板滚动 → 回复输入 → 单次发送 → 草稿清空与评论数增加”真机闭环。

### 问题现象
- 调用 `device.input` 返回：`Remote command is not implemented: device.input`
- 搜索框、私信输入框、评论输入框均无法通过命名 API 输入文字

### 影响能力
- 搜索用户并进入主页
- 搜索关键词
- 回复私信
- 回复评论
- 修改昵称 / 编辑资料
- 任何需要键盘输入的场景

### 修复建议
1. 实现 `device.input` 或 `device.text` 命令
2. 支持聚焦目标输入框后写入文本
3. 若需要中文输入，走已批准的输入法桥接（参考 `docs/INPUT_METHOD_WORKFLOW.md`）
4. 输入后提供验证：读取输入框内容确认文字已写入

### 相关事件
- DCI-0029 `search-input-command-not-implemented`

### 验证路径
1. 进入搜索页，点击搜索框
2. 调用 `device.input` 输入用户名
3. 读取 UI 确认搜索框中出现目标文字
4. 点击搜索，确认进入结果页
5. 选择用户进入主页，确认页面跳转到该用户主页

---

## 缺口 2：无文本图标按钮无法定位

**修复状态（2026-07-16，Codex）**：通用 selector 已支持 `contentDesc`、`className`、`resourceId`、`clickable`、`nearText`，并新增不暴露坐标的 `screenRegion + regionOrdinal` 本地图标策略。评论计数祖先、无文本消息导航和右上区域图标均已有回归测试；分享/消息仍需 Hermes 在常驻网关重启后真机复验。

### 问题现象
- 多个关键按钮是 `ImageView` 或 `Button`，没有 `text` 和 `content-desc`
- 包括：评论点赞心形、分享按钮、底部导航图标
- `device.tap-text` 无法命中；`device.node.resolve` 当前只支持 `role` 和 `relation`，不支持 `class` / `bounds` / `content-desc`

### 影响能力
- 评论点赞（DCI-0023）
- 分享帖子 / 复制链接（DCI-0030）
- 进入消息中心（DCI-0031）
- 分享帖子到微信（DCI-0032）

### 修复建议（任选其一）
1. **扩展节点 selector 字段**：让 `device.node.resolve` 支持 `class`、`bounds`、`content-desc`、`nearText` 等
2. **实现 LOCAL_ICON_NODE 策略**：本地识别常见图标（心形、分享、消息、搜索）
3. **实现 VISION_NODE 修复**：当前视觉服务 120 秒超时，需要配置或修复视觉后端

### 相关事件
- DCI-0023 `comment-like-button-icon-no-text`
- DCI-0030 `copy-post-link-from-share-panel`
- DCI-0031 `bottom-nav-message-no-text-target`
- DCI-0032 `share-to-wechat-not-tested`

### 验证路径
1. 进入帖子详情，调用 `device.node.resolve` 定位分享图标（通过 `description` 或 `icon` 语义）
2. 点击后确认分享面板打开
3. 点击“复制链接”，确认面板关闭并返回帖子详情
4. 对评论点赞：进入评论列表，定位心形图标，点击后确认计数变化

---

## 缺口 3：本地网关无法重载

**修复状态（2026-07-16，Codex）**：管理脚本不再只信任 PID 文件；PID 文件缺失或陈旧时，会从 `127.0.0.1:17891` 唯一监听者反查进程，并同时校验 Node 进程和网关健康标记。新增 `xhs.cmd remote restart`，终止失败时可转交管理员权限，重启前等待端口释放。当前只做了无侵入 `remote status` 现场检查，已正确识别原 PID 42424；共享网关未在本任务中实际重启。

### 验证路径
1. 在没有 `data/remote-gateway.pid` 的情况下运行 `xhs.cmd remote status`
2. 确认返回 `running=True`、`health=True`
3. 在维护窗口运行 `xhs.cmd remote restart`
4. 调用带 `text`、`contentDesc` 或 `screenRegion` 的 `device.node.resolve`，确认新代码已加载

---

## 缺口 4：话题标签未拆分为可点击节点

### 问题现象
- 帖子正文中的多个话题标签（如 `#想穿漂亮衣服 #衣服推荐`）全部位于一个 `TextView` 中
- 没有独立的 clickable span 或子节点
- `device.tap-text` 无法单独命中某个话题

### 影响能力
- 点击话题标签跳转搜索
- 点击 @用户 跳转主页（同理）

### 修复建议
1. 实现文本内 span 定位：通过 OCR 或 vision 识别 `#话题` 在 TextView 中的像素位置并点击
2. 或实现“点击文本中第一个匹配模式”的命令

### 相关事件
- DCI-0033 `topic-tag-inside-single-textview`

### 验证路径
1. 进入帖子详情，确认正文包含 `#话题`
2. 调用话题定位命令
3. 确认页面跳转到话题搜索/聚合页
4. 读取 UI 确认顶部出现话题名称和相关笔记

---

## 缺口 5：视觉服务超时

### 问题现象
- `device.node.resolve` 使用 `vision` source 时，请求 120 秒超时
- 当前环境可能未配置视觉服务或视觉后端不可用

### 影响能力
- 所有依赖视觉识别的能力：图标定位、复杂布局、无文本按钮、OCR 无法命中的场景

### 修复建议
1. 检查视觉服务配置（环境变量、API key、本地模型）
2. 确认 `device.node.resolve` 的 vision 超时是否合理
3. 在视觉服务不可用时给出明确错误，而不是无响应

### 相关事件
- DCI-0023 `comment-like-button-icon-no-text`（视觉节点尝试也失败）

### 验证路径
1. 在帖子详情调用 `device.node.resolve` 指定 `vision` 识别“分享图标”
2. 确认在 5-10 秒内返回结果
3. 点击返回的节点，确认分享面板打开

---

## 2026-07-16 补丁状态：连续打开、selector 简写与滚动

- DCI-0036：`xhs.open-visible` 已在详情/评论状态下执行有界 BACK 恢复，确认 `HOME_FEED` 后重新解析并单次打开；代码和回归测试完成，待命名 HTTP 真机复验。
- DCI-0037：`contentDesc`、`text` 或 `resourceId` 可推导 selector label；仅含 `contentDesc` 的按钮默认使用 `role: button` 和 `sources: [accessibility]`。代码和回归测试完成，待真机复验。
- DCI-0038：新增正式 `device.scroll` 命令，参数为 `direction: down|up`、可选 `steps: 1..5`、可选 `package`；每步核对滚动容器并验证新 UI 指纹。代码和回归测试完成，待真机复验。

---

## 缺口 6：`xhs.dm.send` API 验证超时

**发现时间**：2026-07-17
**发现者**：hermes-agent
**状态**：open

### 问题现象
- 1 号机小红书私信会话页已用 `device.input` 输入草稿「你好，测试私信」
- 调用 `xhs.dm.send`（`expectedDraft: "你好，测试私信"`）后，API 超时 35 秒返回 timeout
- 截图确认消息**实际已发送**（蓝色气泡出现，输入框已清空）
- 问题在验证阶段：内部读取 UI 层级确认发送完成，UI dump 本身 10-15s/次，多次重试后总耗时超 35s

### 影响能力
- 私信作者（调用方无法确认消息是否送达）
- 回复私信
- 任何需要 `xhs.dm.send` 的自动化流程

### 修复建议
1. 增加 `xhs.dm.send` 超时至 60s，给 UI dump 更多时间
2. 优化验证逻辑：发送后只读 1-2 次 UI，读不到返回 `mitigated` 而非 timeout
3. 发送后先检查草稿是否清空作为快速验证路径

### 相关文件
- `scripts/xiaowei-device-read.mjs` → `extractUiHierarchy()`
- DCI-0039/DCI-0043
- handoff: `docs/device-task-handoffs/2026-07-17-machine04-incomplete-hierarchy-gap-hermes.md`

---

## 缺口 7：4 号机 UI hierarchy 不完整

**发现时间**：2026-07-17
**发现者**：hermes-agent
**修复者**：codex（2026-07-17）
**状态**：verified

### 修复结果
- 根因：同一滚动节点被系统层级重复暴露，旧代码误认为多个目标
- 修复：对完全相同节点去重；真正不同的同面积目标仍安全拒绝
- 三机并发 matrix 全部通过：`app.list` / `device.size` / `device.ui` / `device.screen` / `app.open` / `xhs.observe` / `device.scroll` / `xhs.open-visible` / `device.back`
- 04 `verifiedSteps=3`，`maxActive=3`，HTTP 200 verified
- 相关修改：`scripts/xiaowei-device-read.mjs:2126`（滚动执行器）、回归测试、`AGENT_DEVICE_CONTROL_PLAYBOOK.md:231`、DCI-0049 verified

### 问题现象
- 4 号机在线且 `device.screen` / `device.size` / `device.start-apk` 正常
- `device.ui`、`device.scroll`、`xhs.observe`、`xhs.open-visible` 返回 502
- 错误：`Xiaowei UI response did not contain a complete hierarchy`
- `uiautomator dump /dev/tty` 返回的 XML 缺少 `</hierarchy>` 闭合标签
- 视频详情页更严重（SurfaceView/TextureView）

### 影响能力
- 04 上所有依赖 UI hierarchy 的命令全部 502
- 不影响 02/03（同期正常）

### 修复方向
1. 首页 vs 视频详情对照，dump raw 长度/闭合标签
2. 效卫侧：检查 UI dump 包体是否截断
3. 设备侧：检查 04 无障碍服务是否异常
4. 代码侧：`extractUiHierarchy` 失败时返回可审计摘要

### 相关文件
- handoff: `docs/device-task-handoffs/2026-07-17-machine04-incomplete-hierarchy-gap-hermes.md`
- `scripts/xiaowei-device-read.mjs` → `extractUiHierarchy()` L151-158

---

## 缺口 8：Hermes `terminal()` 工具层串行化

**发现时间**：2026-07-17
**发现者**：hermes-agent
**状态**：open（非代码缺口，测试方法论问题）

### 问题现象
- 用 Hermes `execute_code` + `hermes_tools.terminal` 多线程调用 17891，并发命令表现为串行（wall ≈ sum）
- 用纯 Python `urllib.request` + `ThreadPoolExecutor` 同样调用 17891，并发是真并行（wall ≈ max）
- 结论：网关支持并行，Hermes `terminal()` 工具层有自己的串行化队列

### 影响范围
- 仅影响 hermes-agent 的并发测试方法
- 不影响网关并发能力，不影响 Codex 或其他 HTTP 客户端

### 解决方案
- 并发测试必须用纯 HTTP 客户端（Python `urllib` / `httpx`）
- 已在 `skills/xhs-device-operator/SKILL.md` 的 `Concurrency measurement pitfall` 中记录

### 相关文件
- `skills/xhs-device-operator/SKILL.md` → `Concurrency measurement pitfall`
- `references/2026-07-17-gateway-concurrency-measurement-pitfall.md`

---

## 修复协作流程

1. **修复者**选择本报告中的一个缺口，修改代码或配置
2. **修复者**在相关事件中追加 `fixedBy` 和修复摘要（若 schema 已扩展）
3. **修复者**通知 `hermes-agent` 重新验证
4. **hermes-agent** 按真实操作验证，通过后更新事件状态为 `verified` 或 `mitigated`
5. **hermes-agent** 更新 `docs/XHS_CAPABILITY_ROADMAP.md` 状态为 ✅ 或 🔄

---

## 缺口 9：视频详情页完整流程耗时 ~6min

**发现时间**：2026-07-17
**发现者**：hermes-agent
**修复者**：codex（2026-07-17）
**状态**：verified

### 修复结果
- 完整流程：285s → 50.7s（**-82%**）
- `xhs.find-video`：5.0s（新增命令，最多滚动3次，28s预算）
- `xhs.open-visible`：14.0s，超时率 0
- 视频详情 `xhs.observe`：4.4s（原 33s，-87%）
- 视频详情 `device.ui`：4.7s（原 17s，-72%）
- 524/524 测试通过
- 02/04 并发读取通过
- 修复手段：observe 返回稳定 ordinal；`xhs.find-video` 新命令；VIDEO_NOTE 单次 hierarchy；UI 5s 超时+sdcard 降级

### 问题现象
- 04 从首页滚动找视频 → 打开视频详情 → `device.ui` → 返回首页，总耗时 ~285s（~6min）
- 时间分布：滚动找视频 160s（56%）> open-visible 超时 35s（12%）> observe 详情 33s（12%）> device.ui 17s（6%）> 其他 40s（14%）

### 影响范围
- 所有需要从首页定位并打开视频帖的操作
- 不影响已知 ordinal 的直接打开

### 根因分析
1. **滚动找视频**：8 次 scroll + observe，每次 ~20s，无视频定位 API
2. **open-visible 超时**：35s 超时但实际成功，白等
3. **observe 详情页**：33s，视频页 UI dump 比图文慢

### 能力验证
- `device.ui` 在 `VIDEO_NOTE` 页面返回 OK（16.9s）✅
- 功能能力完整，仅性能问题

### 优化建议
1. `xhs.observe` 返回 `mediaType`，可直接判断有无视频，省掉每次截图确认
2. `open-visible` 超时缩短或改异步（先返回 accepted，后台验证）
3. 新增 `xhs.find-video` API：直接定位当前页面第一个视频帖并返回 ordinal
4. `device.ui` 视频页 16.9s 可接受，但也可考虑缓存或增量更新

### 相关事件
- 04 hierarchy 修复（DCI-0049）已验证视频页 `device.ui` OK

---

## 文件位置

- 本报告：`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/CAPABILITY_GAPS.md`
- 事件簿：`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/config/device-control-incidents.json`
- 能力地图：`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/XHS_CAPABILITY_ROADMAP.md`
- 输入方法工作流：`C:/Users/windows 10/Desktop/coding/control_Test/xhs-device-agent/docs/INPUT_METHOD_WORKFLOW.md`
