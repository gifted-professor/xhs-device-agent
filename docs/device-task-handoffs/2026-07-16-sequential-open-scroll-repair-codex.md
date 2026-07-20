# DCI-0036 / DCI-0037 / DCI-0038 修复交接

日期：2026-07-16  
执行者：codex

## 任务预留与资源

- 机器预留：`none`。本次只修改和测试仓库代码，没有发送真机动作。
- 共享服务：未重启、替换或重载主 HTTP 网关；未占用临时端口，也没有遗留进程。
- 设备状态：未改变；无需设备恢复，任务结束时无设备资源占用。

## 修复结果

- `xhs.open-visible`：从 `IMAGE_NOTE` / `VIDEO_NOTE` 调用时先发送一次 BACK，确认 `HOME_FEED` 后再重新定位并打开目标；从 `COMMENT_PANEL` 最多执行两段已验证返回。任何阶段不能确认页面转换时停止，不重放动作。
- `device.node.resolve/activate`：允许仅提供 `contentDesc` 的 selector；服务端自动补齐同名 label、button 角色与 accessibility 来源。`text`、`resourceId` 也可作为缺省 label。
- `device.scroll`：补齐远程网关、统一 CLI、PowerShell 适配器和设备执行器。公开参数为 `direction: down|up`、`steps: 1..5`（默认 1）及可选 package；每步要求同一滚动容器稳定且动作后规范化 UI 指纹变化。

## 自动验证

- `XHS visible-card opening returns from detail, verifies home, then opens exactly once`
- `content-description shorthand derives a bounded accessibility button selector`
- `device.scroll rechecks one container, sends one directional event, and verifies fresh UI change`
- 统一 CLI 和远程网关参数/公开响应契约测试
- 全仓结果：`npm run check` 通过；`npm test` 492/492 通过；仓库策略扫描通过；事件簿校验通过。

## 文件变更

- `scripts/xiaowei-device-read.mjs`
- `scripts/device-node-engine.mjs`
- `scripts/xhs-remote-gateway.mjs`
- `scripts/xhs-agent.mjs`
- `scripts/Invoke-XiaoweiDeviceRead.ps1`
- `tests/xiaowei-device-read.test.mjs`
- `tests/device-node-engine.test.mjs`
- `tests/xhs-remote-gateway.test.mjs`
- `tests/xhs-agent-cli.test.mjs`
- `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`
- `docs/XHS_CAPABILITY_ROADMAP.md`
- `docs/CAPABILITY_GAPS.md`
- `config/device-control-incidents.json`

## 事件状态

- DCI-0036：`open` → `resolved`
- DCI-0037：`open` → `resolved`
- DCI-0038：`open` → `resolved`

三条均未标记为 `verified`，因为本任务没有占用真机，也没有重启共享网关进行命名 HTTP 复验。

## 待 Hermes 真机复验

1. 在首页调用 `xhs.open-visible` 打开帖子；从详情页再次调用另一 ordinal，确认自动返回首页并成功打开，连续执行至少 3 次。
2. 用仅含 `contentDesc` 的 selector 调用 `device.node.resolve`，再以有明确后态的按钮调用 `device.node.activate`。
3. 在存在唯一滚动容器的首页或详情页调用 `{ "command": "device.scroll", "machine": "01", "direction": "down" }`，确认 HTTP 200 与 `status: verified`。
4. 若任一步动作已经发送但返回失败，不要盲目重试；先读取当前 UI 状态。
