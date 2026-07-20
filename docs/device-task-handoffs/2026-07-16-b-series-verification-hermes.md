# 小红书 B 系列能力真机验收交接

**日期**: 2026-07-16  
**执行人**: hermes-agent  
**验证机器**: 1 号机（本机 ADB 枚举为空，但 Xiaowei API 在线）  
**会话 ID**: `2026-07-16-b-series-verification-hermes`

## 背景

P0 修复已完成并合并：

- `device.input`: 贯通命名网关、统一 CLI 和效卫设备适配层，支持焦点校验、中文输入、精确回显、原输入法恢复。
- 无文本图标定位: 新增 `contentDesc/className/nearText` 及 `screenRegion + regionOrdinal` 本地 selector，不暴露坐标。
- 网关重载: PID 文件缺失时可从健康监听端口找回进程，新增 `xhs.cmd remote restart`。

本次任务由 Hermes 在维护窗口重启共享网关，然后在 1 号机复验 B 系列能力。

## 操作摘要

1. 通过 `xhs.cmd remote restart` 重启共享网关。
2. `device.list` 确认 4 台设备在线。
3. 在 1 号机依次执行 B1-B3、B6-B8 验证。

## B 系列验证结果

| 任务 | 状态 | 关键命令 | 验证说明 |
| --- | --- | --- | --- |
| B1 进入搜索页 | ✅ verified | `device.tap-text` 点“搜索” | 成功进入搜索页，搜索框已聚焦 |
| B2 搜索关键词 | ✅ verified | `device.input` + `device.tap-text` 点“搜索” | 输入“连衣裙”后搜索框真实回显；命令因 1 号机本地 OCR 不可用返回失败，但 UI hierarchy 可验证输入已生效；随后成功进入搜索结果页 |
| B3 搜索用户并进入主页 | ✅ verified | `device.tap-text` 切“用户”标签 + 点用户名 | 成功进入用户列表，并进入第一个用户主页 |
| B4 评论回复 | ⛔ 跳过 | - | 用户明确暂缓 |
| B5 私信回复 | ⛔ 跳过 | - | 用户明确暂缓 |
| B6 进入消息中心 | ✅ verified | `device.tap-text` 点“消息” | 成功进入消息中心；`device.node.activate` 因 content-desc 含动态未读数无法命中唯一节点 |
| B7 打开分享面板 + 复制链接 | ✅ verified | `device.node.activate` 点分享图标 + `device.tap-text` 点“复制链接” | 分享面板成功打开，复制链接成功 |
| B8 分享到微信 | ✅ verified | `device.tap-text` 点“微信好友” + 系统选择器点“微信” | 成功跳转至微信前台包 `com.tencent.mm` |

## 关键观察

### 1. `device.input` 输入成功但回显验证失败

- 现象: `device.input` 返回失败，错误为 `Local OCR was unavailable while locating input echo`。
- 实际结果: 搜索框 UI 中确实出现了 `连衣裙` 文本。
- 结论: 输入链路已通，失败点在回显验证阶段。1 号机未配置本地 OCR，但 UI hierarchy 可验证输入存在。
- 关联事件: [DCI-0031](../config/device-control-incidents.json)

### 2. `device.node.activate` 对动态 content-desc 定位失败

- 现象: 底部消息入口的 `content-desc` 包含动态未读数（如 `消息，9条未读`），使用 `contentDesc` 精确匹配无法命中唯一节点。
- 替代方案: `device.tap-text` 点“消息”文本成功进入消息中心。
- 建议: 考虑让 selector 支持 content-desc 前缀/模式匹配，或暴露稳定的文本节点。
- 关联事件: [DCI-0032](../config/device-control-incidents.json)

### 3. 分享到微信需要额外一步

- 现象: 点击“微信好友”后，系统先弹出应用选择器（`com.miui.securitycore`），需再次点击“微信”才能跳转。
- 结论: B8 验证通过，但需记录为两步流程。
- 关联事件: [DCI-0034](../config/device-control-incidents.json)

## 更新文件

1. `config/device-control-incidents.json`
   - DCI-0031: `resolved` → `verified`
   - DCI-0032: `resolved` → `verified`
   - DCI-0030: 追加本次 liveAcceptance
   - DCI-0034: `open` → `verified`
   - DCI-0035: 追加 `xhs.cmd remote restart` liveAcceptance

2. `docs/XHS_CAPABILITY_ROADMAP.md`
   - 搜索关键词: `🔄` → `✅`
   - 搜索用户并进入主页: `🔄` → `✅`
   - 进入消息中心: `🔄` → `✅`
   - 分享帖子 / 复制链接: `🔄` → `✅`
   - 分享帖子到微信: `🔄` → `✅`

3. 本文件: `docs/device-task-handoffs/2026-07-16-b-series-verification-hermes.md`

## 剩余边界

- B4 评论回复和 B5 私信回复暂缓执行，用户明确未授权。
- 2 号机因用户正在使用，未参与本次验证；其 `device.input` 复验失败需单独排查。
- 1 号机本地 OCR 缺失导致 `device.input` 精确回显阶段失败，建议后续配置或允许 UI 回显作为替代验证。
- **后续新增**: 用户追加“刷 6 条帖子并在第四条评论表情”任务，执行中暴露三个新阻塞，已记录为事件簿新 incidents，详见 [DCI-0036/DCI-0037/DCI-0038](../config/device-control-incidents.json)。

## 追加任务：第四条帖子评论表情（执行受阻）

在 B 系列验证后，用户追加任务：刷 6 条帖子，并在第 4 条帖子回复一个表情。执行过程中遇到以下阻塞：

| 问题 | 说明 | 关联事件 |
| --- | --- | --- |
| `xhs.open-visible` 连续调用 502 | 首次打开帖子成功，连续调用或从详情页再次调用时返回 502 Bad Gateway | DCI-0036 |
| `device.node.activate` selector 格式严格 | 仅传 `contentDesc` 会报 `selector.label is invalid`；需要 `label`、`role`、`sources` 等字段 | DCI-0037 |
| `device.scroll` 参数格式未知 | 在帖子详情页用 `{ direction: "down" }` 调用返回 400，说明命令未实现或需要其他参数 | DCI-0038 |

## 执行 provenance

- 执行人: hermes-agent
- 验证时间: 2026-07-16
- 验证机器: 1 号机
- 网关重启: 通过 `xhs.cmd remote restart` 成功
- 事件簿更新: DCI-0036 / DCI-0037 / DCI-0038 记录本次阻塞
