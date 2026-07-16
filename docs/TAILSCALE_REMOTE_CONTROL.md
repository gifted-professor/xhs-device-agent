# 效卫本机与 Tailscale 远程控制 API

> 当前状态：本机和同一 Tailnet 内的其他机器都可以通过 HTTP JSON 调用效卫及项目手机控制能力，不需要人工打开 CMD 或点击效卫界面。

## 1. 当前可用入口

| 使用位置 | API 地址 | 用途 |
| --- | --- | --- |
| 本机 Agent | `http://127.0.0.1:17891/v1/command` | 本机直接调用，优先使用 |
| Tailnet 内远程 Agent | `https://desktop-3i1evhe.tail400674.ts.net/v1/command` | 其他 Tailscale 机器远程调用 |
| 人工调试 | `.\xhs.cmd ...` | 排障、验收和兼容旧流程 |

健康检查：

```text
GET http://127.0.0.1:17891/health
GET https://desktop-3i1evhe.tail400674.ts.net/health
```

控制请求统一使用：

```text
POST /v1/command
Content-Type: application/json
```

## 2. 推荐架构

```text
本机 Agent ── HTTP ───────────────┐
                                  ├─> 统一控制网关
远程 Agent ─ Tailscale HTTPS ─────┘       │
                                          ├─ 效卫正式 API（31 actions）
                                          ├─ 效卫 Tauri 私有 API（70 commands）
                                          └─ 受控 ADB/UI（回退和后态验证）
                                                   │
                                                安卓设备
```

API 是 Agent 的主要入口。`xhs.cmd` 保留为人类可读的调试客户端和兼容入口，不应要求 Agent 打开终端窗口或点击 Codex/效卫界面。

Agent 不得直接调用裸 ADB、效卫私有 WebSocket 或未经网关封装的私有命令。`adb devices` 显示 0 台不构成停止条件；设备是否可读以新的 `device.list`、`device.ui` 和 `device.screen` 结果为准。普通 Agent 查询屏幕尺寸时只提交 `device.size` 与两位 `machine`，不得读取、传递或覆盖 serial。

当前本机配置可临时启用 `Xiaowei.TemporaryRelaxedNamedCommands = $true`。启用期间，`app.open`/`app.stop` 接受任意语法合法的包名，`device.tap-text` 不再受固定文字标签白名单限制；仍保留机器身份绑定、单设备选择、显式后态、状态变化确认、命名网关和脱敏审计。将该值改回 `$false` 即恢复 `ApprovedAppPackages` 和安全标签白名单。

### 当前实现边界

- 对调用者而言，本机和远程都已经是 HTTP API。
- 当前网关收到命名命令后，会直接调用 Node 动作路由；其中部分设备动作仍会启动现有 PowerShell 动作脚本。
- 因此现在已经解决“Agent 如何稳定调用”的问题，但尚未完成“服务内部完全不创建子进程”的重构。
- 后续可把动作实现提取为常驻服务模块；届时 `xhs.cmd` 也改为只向本机 API 发请求。

## 3. 服务生命周期

```powershell
.\xhs.cmd remote start
.\xhs.cmd remote status
.\xhs.cmd remote install
.\xhs.cmd remote stop
.\xhs.cmd remote uninstall
```

- `start`：启动本机网关；Tailscale Serve 路由由 Tailscale 服务持久保存。
- `status`：检查进程、健康状态、监听地址和登录启动任务。
- `install`：安装 `XhsDeviceAgentRemoteStack` 登录启动任务，以最高权限启动私有通道和网关。
- `stop`：只停止本机网关；现有 Serve 配置仍保留，但后端不可用。
- `uninstall`：只移除登录启动任务，不自动停止当前进程或重置 Serve。

Tailscale Serve 路由为：

```text
HTTPS 443 -> http://127.0.0.1:17891
```

网关只允许监听 `127.0.0.1:17891`。不要把效卫的 `9223`、官方 WebSocket `22222` 或本机网关端口直接暴露到局域网/公网，也不要启用 Funnel。

## 4. 本机 API 调用示例

本机 Agent 直接请求 localhost，不需要经过 Tailscale：

```powershell
$body = @{ command = "device.list" } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:17891/v1/command" `
  -ContentType "application/json; charset=utf-8" `
  -Body $body
```

读取 1 号机 UI：

```json
{
  "command": "device.ui",
  "machine": "01"
}
```

打开批准应用：

```json
{
  "command": "app.open",
  "machine": "01",
  "package": "com.eg.android.AlipayGphone"
}
```

## 5. 远程 API 调用示例

远程 Agent 使用完全相同的 JSON，只替换 API 地址。项目运行环境已经包含 Node.js，可以直接调用：

```javascript
const response = await fetch(
  "https://desktop-3i1evhe.tail400674.ts.net/v1/command",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "device.list" })
  }
);

console.log(await response.json());
```

前提是调用机器已加入允许访问该主机的 Tailnet。该地址不是公网入口。部分旧版 Windows PowerShell 5.1 的 HTTPS/TLS 栈可能报告“发送时发生错误”；当前机器已用 Node `fetch` 和系统 `curl` 验证远程入口正常，此类错误不代表网关离线。

## 6. 已公开的命名命令

### 主机与目录

| command | 参数 | 说明 |
| --- | --- | --- |
| `doctor` | 无 | 项目诊断 |
| `host.status` | 无 | 效卫主机状态 |
| `host.refresh` | 无 | 刷新设备 |
| `host.restart-adb` | 无 | 调用效卫重启 ADB，失败时按项目规则回退 |
| `host.private-api-status` | 无 | 检查私有 API |
| `api.probe` | 无 | 探测正式 API |
| `api.catalog` | 无 | 读取正式 API action 目录 |
| `private.catalog` | 无 | 读取当前版本私有命令目录 |

### 手机与应用

| command | 参数 | 说明 |
| --- | --- | --- |
| `device.list` | 无 | 读取项目设备清单 |
| `device.size` | `machine` | 读取物理屏幕宽高，不暴露设备标识 |
| `device.ui` | `machine` | 读取新鲜 UI hierarchy |
| `device.screen` | `machine` | 获取手机截图证据 |
| `device.home` | `machine` | 返回 HOME 并后验 |
| `device.back` | `machine` | 返回上一页并后验 |
| `device.screen-on` | `machine`, `reason`, `rollback` | 亮屏，需要确认信息 |
| `device.screen-off` | `machine`, `reason`, `rollback` | 熄屏，需要确认信息 |
| `device.settings` | `machine`, `reason`, `rollback` | 打开系统设置，需要确认信息 |
| `app.list` | `machine` | 读取批准应用清单 |
| `app.open` | `machine`, `package` | 打开批准应用 |
| `app.stop` | `machine`, `package`, `reason`, `rollback` | 停止批准应用 |
| `device.tap-text` | 见下文 | 语义点击一次，并验证一个后态 |
| `device.tap-ocr` | `machine`, `package`, `text`, `expectText`, `reason`, `rollback` | UI 层级为空时，基于新鲜截图唯一识别、复核并点击一次，再用新截图验证后态 |
| `device.guide` | `failureCode` | 返回标准故障对应的有序策略，不包含设备信息 |
| `device.node.resolve` | `machine`, `package`, `selector` | 用两份新鲜证据只读解析一个唯一语义节点，不返回坐标 |
| `device.node.activate` | `machine`, `package`, `selector`, `expectText`, `reason`, `rollback` | 重新独立解析并复核节点，只发送一次，再验证新鲜后态 |
| `wechat.wallet-balance` | `machine` | 在微信零钱页双截图稳定读取余额，只返回人民币金额 |
| `xhs.observe` | `machine` | 连续两次读取当前小红书公开页面，返回稳定交集 |
| `xhs.open-visible` | `machine`, `ordinal` | 按一开始的可见卡片序号打开一条公开笔记，只点击一次并双 UI 验证详情 |

所有 `machine` 使用两位机器编号，例如 `01`、`04`。

语义点击示例：

```json
{
  "command": "device.tap-text",
  "machine": "01",
  "text": "理财",
  "expectResourceId": "com.alipay.android.widget.fortunehome:id/fh_tv_assets_amount_num",
  "reason": "进入支付宝理财页读取总资产",
  "rollback": "返回支付宝首页"
}
```

`expectText`、`expectPackage`、`expectResourceId` 必须且只能提供一个。

## 7. 开发期完整效卫能力

### 效卫正式 API

正式 action 通过 `dev.invoke` 调用：

```json
{
  "command": "dev.invoke",
  "action": "adb_shell",
  "machine": "04",
  "data": {
    "command": "getprop"
  }
}
```

也可以使用 `"all": true` 选择全部已配置设备，但不能同时传入 `machine`。

### 效卫 Tauri 私有 API

先获取当前版本命令目录：

```json
{
  "command": "private.catalog"
}
```

再调用命令：

```json
{
  "command": "private.invoke",
  "privateCommand": "restart_adb",
  "args": {}
}
```

私有 API 当前固定绑定效卫 `9.10.113`，升级效卫后必须重新检查目录、参数和真实设备后态。Agent 不应直接连接效卫私有 WebSocket；统一通过本项目 API 调用、脱敏和审计。

### 不依赖本机 ADB 的 UI 与截图验证

`device.list`、`device.size`、`device.ui` 和 `device.screen` 已改为效卫 API 优先的稳定读通道。本机执行 `adb devices` 即使显示 0 台在线，这些命令仍可工作。

`device.list` 内部调用只读 `get_device_list`，并将效卫记录中的 serial 与本地 `AcceptedDeviceSerialsByAlias`、机器目录和内部绑定做精确三方匹配。它不限制在线机器数量：效卫当前正确识别并唯一映射多少台，就如实显示多少台 `online: true`。未映射、重复、字段冲突或身份漂移仍 fail closed。HTTP 成功响应是按机器号排序的数组，每项只含 `machine`、可见 `name`、`online`、`transport` 和 `localAdbRequired: false`。

`device.size` 示例：

```json
{
  "command": "device.size",
  "machine": "02"
}
```

服务端从机器目录解析并注入内部 serial，然后调用只读 `get_size`。调用方提交 `args.serial`、`serial` 或其他覆盖字段会被拒绝。返回值必须严格是单一 `宽x高` 字符串；空值、非法格式、对象、数组或多设备结果都会失败。HTTP 成功响应只含 `machine`、数字 `width`、数字 `height`、`transport` 和 `localAdbRequired: false`。

UI 与截图示例：

```json
{
  "command": "device.ui",
  "machine": "02"
}
```

```json
{
  "command": "device.screen",
  "machine": "02"
}
```

实现方式：

1. `device.ui` 通过效卫正式 `adb_shell` 执行固定的 `uiautomator dump /dev/tty`，从返回值中提取完整 XML，再保存为 `window.xml`。
2. `device.screen` 通过效卫正式 `adb_shell` 在手机临时目录生成 PNG，等待远端文件稳定后只调用一次 `pullFile`，等待本机文件稳定，校验 PNG 结构与尺寸，最后删除手机临时文件。
3. 两个命令都经过项目设备身份映射、设备锁、效卫版本绑定、路径限制、序列号脱敏和审计；远程 Agent 不直接提交任意 `adb_shell`。

不要直接使用效卫正式 `screen` action 作为证据源。效卫 9.10.113 实测会返回 `SUCCESS`，但不一定创建 `savePath` 文件；`SUCCESS` 不能替代文件存在性和图片解码校验。

2026-07-15 在 02 号机、本机 ADB 在线数为 0 的条件下验收：

- 本机 HTTP `device.ui` 返回 200，生成 36,639 字节完整 XML。
- 本机 HTTP `device.screen` 返回 200，生成 1080×2400 PNG，并完成手机临时文件清理。
- Tailscale HTTPS `device.ui` 返回 200，证明远程入口使用同一验证通道。

`private.invoke` 的 `args` 仍按普通 JSON 对象提交。网关内部已改为 Base64 加临时 JSON 文件传递，避免 Windows 命令行破坏引号。效卫 9.10.113 的 `launch_app` 参数为 `serial` 和 `package`；普通任务仍优先使用不暴露原始序列号的 `app.open`。

`app.open` 和 `device.home` 也不再依赖本机 ADB 在线列表。项目内部按两位机器号解析已验收的设备身份，并分别调用效卫正式 `startApk`、`pushEvent`；随后使用同一条效卫 `adb_shell + uiautomator` 通道验证前台包。`app.open` 会先通过 `apkList` 确认批准包已安装。普通 Agent 只提交 `machine` 和批准包名，不读取、提交或接收原始 `serial`。

2026-07-15 在 02 号机、本机 ADB 在线数为 0 的条件下补充验收：`device.home` 成功验证默认桌面前台；`app.open` 成功确认支付宝已安装、调用 `startApk` 并验证支付宝前台；本机 HTTP `app.open` 返回 200、`ok=true`。

`device.ui` 保存 XML 时执行临时文件写入、`fsync`、原子重命名、完整回读、字节数比对和 SHA-256 比对。只有磁盘内容与内存中的完整 XML 完全一致才返回成功；结果同时包含 `bytes`、`sha256` 和 `persistenceVerification=fsync_rename_readback_exact`。2026-07-15 在 02 号机连续验证，报告字节数、立即读取长度和 600ms 后长度均为 79,619，SHA-256 一致。

`device.tap-text` 不复用另一次 `device.ui` 的文件。它在一次设备锁内直接取得新鲜 XML、在内存中解析目标及可点击父节点、通过固定 `wm size` 读取物理屏幕尺寸、换算效卫百分比坐标并只发送一次 `pointerEvent`，随后重新读取 UI 验证指定后态。不能使用 UI 层级最大底边代替物理屏幕高度；支付宝当前层级底边为 2,175，而物理屏幕为 2,400，混用会把点按送入系统导航区。修正后 02 号机“理财”导航及资源 ID 后验通过。

当微信等应用只返回根节点时，普通 Agent 使用组合式高层命令，不接触截图路径或坐标：

```json
{
  "command": "device.tap-ocr",
  "machine": "04",
  "package": "com.tencent.mm",
  "text": "我",
  "expectText": "服务",
  "reason": "进入已确认的账户导航页",
  "rollback": "返回上一个页面"
}
```

服务端获取第一张截图并要求目标文字唯一匹配，再获取第二张截图复核目标位置与前台包未漂移，只发送一次 `pointerEvent`。发送后重新截图并要求 `expectText` 唯一出现；目标缺失或重复、中文 OCR 不可用、目标移动、前台包变化、后态原本已存在或后态未验证时均失败关闭且不重放。HTTP 调用不接受 `serial`、`x`、`y`、`screenId` 或截图路径。

微信底部孤立单字“我”曾暴露出一个通用问题：无障碍层级为空，精确 OCR 又可能漏掉孤立短文本。现在该问题归入通用节点系统，不再由微信特判定义能力。Agent 先按 `UI_EMPTY` 或 `OCR_MISS` 调用 `device.guide`，再用 `device.node.resolve` 提交封闭选择器。选择器可依次声明 `accessibility`、`ocr`、`relation`；当前关系算法只允许 `horizontal_equal_spacing + bottom_navigation`，并要求两个精确锚点、各自序号和目标序号。服务端在两份新鲜证据上独立解析，调用方不能提交或接收坐标。

`device.node.activate` 不信任之前的解析响应，也不接受节点令牌。它重新采集两份新鲜 UI/截图、验证前台包、按同一选择器重新解析、确认来源和位置稳定，然后最多发送一次；发送后必须在新证据上验证 `expectText`。重复节点、OCR 多结果、锚点缺失、布局漂移、前台漂移、后态预先存在或发送后未出现，都会失败关闭。完整决策树见 `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`，机器可读目录为 `config/device-control-playbook.json`。

2026-07-15 在 04 号机微信主界面验收：`device.ui` 仅返回 382 字节根层级，`device.screen` 返回有效 1080×2400 PNG；命名 `device.tap-ocr` 将“我”唯一识别并在第二张截图上复核后只点击一次，随后在新截图中两次稳定识别“服务”，HTTP 返回 200、`verificationOutcome=verified`。公开响应不包含 serial、deviceId、内部 alias、坐标或截图路径。

2026-07-16 在 03 号机补充验收：微信同样只返回 382 字节根层级；孤立“我”连续无法直接 OCR，但“通讯录”和“发现”在两张截图中唯一且稳定。受限导航锚点回退只点击一次并验证“服务”，随后“服务 → 钱包 → 零钱”均通过原有精确 OCR；`wechat.wallet-balance` 双截图返回 `CNY 2559.00`。03 的小红书 `xhs.observe` 与 `xhs.open-visible` 也均返回 HTTP 200。

微信零钱页使用更高层的只读命令，普通 Agent 不再自行组合截图和 OCR：

```json
{
  "command": "wechat.wallet-balance",
  "machine": "04"
}
```

服务端先验证微信前台与“零钱/充值/提现”页面标识，再在两张新鲜截图上分别多次读取唯一人民币金额；页面、尺寸或金额漂移均失败。HTTP 只返回 `machine`、`currency`、`balance`、`transport`、`localAdbRequired:false`。04 号机真实验收返回 `CNY 25.00`。

小红书公开页面读取示例：

```json
{
  "command": "xhs.observe",
  "machine": "04"
}
```

`xhs.observe` 要求小红书位于前台、页面规则分类明确且不属于敏感/人工接管页面，并只返回连续两次新鲜 UI 的稳定交集。首页可返回公开卡片的标题、作者、图文/视频类型和公开指标；详情页可返回标题、作者、正文、日期地区、媒体数量及点赞/收藏/评论数。消息、未读提示、草稿、账号设置和设备标识不进入公开结果。

打开当前可见的第 2 张公开卡片：

```json
{
  "command": "xhs.open-visible",
  "machine": "04",
  "ordinal": 2
}
```

序号按本次新鲜首页 UI 中的公开卡片顺序从 1 开始。服务端在点击前再次解析同一序号并核对标题、作者和媒体类型，只发送一次 `pointerEvent`，随后要求详情页分类成立并连续两次读取稳定。调用方不能提交坐标或设备标识。04 号机真实验收打开“我将退出奶茶界”，稳定读取到作者“揽渡.”、6 张图、正文话题、`07-10广西`、点赞 804、收藏 220、评论 163。

## 8. 截图驱动的精确坐标控制

### 8.1 当前开发期调用方式

当前已经具备闭环所需的底层能力：

- `device.screen` 获取设备原始截图并保存证据。
- 效卫正式 action `pointerEvent` 发送坐标事件。
- `pointerEvent` 的 `x`、`y` 是 `0–100` 范围的数字字符串，不是直接传入手机像素。
- `type: "10"` 已在 4 号机实测为单次点击。

从原图像素转换为效卫坐标：

```text
xPercent = xPixel / screenWidth  * 100
yPercent = yPixel / screenHeight * 100
```

开发期请求示例：

```json
{
  "command": "dev.invoke",
  "action": "pointerEvent",
  "machine": "04",
  "data": {
    "type": "10",
    "x": "25.0926",
    "y": "11.7083"
  }
}
```

这个接口可以验证底层坐标映射，但普通 Agent 后续不应直接使用 `dev.invoke`。稳定入口应封装成 `device.capture` 和 `device.tap`。

### 8.2 4 号机实测结果

测试日期：`2026-07-15`。截图分辨率：`1080×2400`。

| 测试 | 截图坐标 | 效卫坐标 | 结果 |
| --- | --- | --- | --- |
| 支付宝底部“首页” | `(108,2280)` | `(10%,95%)` | 一次命中并切换到首页 |
| 支付宝底部“理财” | `(324,2280)` | `(30%,95%)` | 一次命中并恢复理财页 |
| 总资产眼睛图标 | `(271,281)` | `(25.0926%,11.7083%)` | 连续两次命中，隐藏后恢复金额显示 |
| 自动轮播卡片中的小 `+` | 截图时定位 | 点击前目标已移动 | 未命中；数值未变化 |

证据：

- 点击前：`data/matrix/runs/20260715-191034-089-f66bcc83/device-04/screen.png`
- 眼睛图标点击后：`data/matrix/runs/20260715-191114-483-a5ef330b/device-04/screen.png`
- 同坐标恢复后：`data/matrix/runs/20260715-191158-241-16e2e018/device-04/screen.png`
- 动态轮播目标失效：`data/matrix/runs/20260715-191255-260-181255bc/device-04/screen.png`

结论：

- 静止页面中几十像素大小的小目标已经可以可靠命中。
- 百分比坐标可以使用小数映射回原图像素，但尚未测量效卫内部最终取整方式，不能宣称单像素误差已经被证明。
- 动态页面的主要风险不是坐标换算，而是截图到点击之间目标发生位移。
- API 返回 `SUCCESS` 仍然只是“已发送”；必须使用点击后的新截图/UI 证明结果。

### 8.3 计划中的稳定截图接口

```json
{
  "command": "device.capture",
  "machine": "04"
}
```

建议返回：

```json
{
  "ok": true,
  "screenId": "screen-abc123",
  "machine": "04",
  "width": 1080,
  "height": 2400,
  "rotation": 0,
  "capturedAt": "2026-07-15T19:10:35.695+08:00",
  "sha256": "...",
  "imageUrl": "/v1/screens/screen-abc123"
}
```

远程 Agent 应通过受限的临时 `imageUrl` 读取图片，不接触主机任意文件路径。

### 8.4 计划中的稳定像素点击接口

```json
{
  "command": "device.tap",
  "machine": "04",
  "screenId": "screen-abc123",
  "coordinateSpace": "screen_px",
  "x": 271,
  "y": 281,
  "maxAgeMs": 1000,
  "reason": "切换金额显示状态",
  "rollback": "再次点击相同控件",
  "postcondition": {
    "type": "fresh_screenshot_change",
    "region": { "left": 220, "top": 220, "right": 330, "bottom": 350 }
  }
}
```

服务端必须在发送点击前完成：

1. 校验 `screenId` 属于同一台设备，且图片未过期。
2. 校验分辨率、旋转方向、前台应用和设备身份未变化。
3. 再截取目标附近区域；静态目标应与参考区域一致。
4. 动态目标应重新定位参考图块/边界框，而不是继续使用旧坐标。
5. 目标消失、移动超限或置信度不足时拒绝点击并返回新截图。
6. 坐标在服务端转换为效卫百分比；必要时使用受控 ADB 整数像素作为已验收回退。
7. 只发送一次点击，随后自动获取新截图/UI 验证，不因超时自动重放。

要缩短截图与点击之间的时间，`device.capture`、目标复核和 `device.tap` 最终应由常驻服务处理，避免每一步启动新的 PowerShell 子进程。

## 9. API 返回格式

`device.list`、`device.size`、`device.guide`、`device.node.resolve`、`device.node.activate`、`wechat.wallet-balance`、`xhs.observe` 和 `xhs.open-visible` 是结构化业务结果：成功时 HTTP body 直接返回上述最小脱敏结构，不包含通用进程字段或 `stdout`。其他命名命令仍使用下面的兼容格式。

成功示例：

```json
{
  "ok": true,
  "requestId": "...",
  "code": 0,
  "timedOut": false,
  "truncated": false,
  "stdout": "...",
  "stderr": ""
}
```

当前 `stdout`/`stderr` 是经过脱敏的字符串；如果底层命令输出 JSON，调用方需要再解析 `stdout`。后续服务化重构应把命名动作改为直接返回结构化 `data`。

HTTP 状态：

- `200`：动作执行进程返回成功；业务结果仍需后态验证。
- `400`：请求字段、参数或 JSON 无效。
- `401`：启用严格身份模式后缺少 Tailscale 身份。
- `502`：底层动作返回失败。
- `503`：网关执行异常。

API 返回成功不等于手机业务动作已经完成。页面导航、应用启动、设置变化等必须继续读取 UI、前台应用、系统状态或截图。

## 10. 并发、超时与审计

- 单个请求超时为 120 秒。
- 请求体最大 64 KiB；开发调用的 `data`/`args` 最大 32 KiB。
- 输出最多保留 1 MiB，并对设备序列号、令牌、密码等字段脱敏。
- 当前网关全局串行执行请求，队列最多等待 16 个请求。
- 同一设备禁止并发状态变化动作；未来多设备任务应由高层任务服务内部实现“跨设备并行、单设备串行”。
- 审计日志位于 `data/remote-gateway-audit.log`，记录请求编号、来源、命令、时间和退出码，不提交到仓库。

## 11. 当前开发权限

目前采用开发验收策略：

- 同一 Tailnet 中能够通过 Tailscale 访问控制规则到达本机的节点，可以调用完整网关能力。
- 没有用户身份头的 tagged 节点当前也允许调用，并记录为 `tailnet_or_local_unidentified`。
- Tailscale Serve 会处理远程身份头；调用方不能用普通 HTTP 头伪造可信身份。
- Funnel 关闭，因此服务没有公开到互联网。

完成验收后可以设置：

```text
XHS_REMOTE_REQUIRE_IDENTITY=true
```

并进一步通过 Tailscale grants、命令级授权、设备范围、审批门和速率限制收紧权限。

## 12. 下一阶段

1. 把剩余 PowerShell 动作脚本迁移为常驻服务内直接调用。
2. 让 `xhs.cmd` 变成同一 HTTP API 的轻量客户端。
3. 给命名动作返回稳定的结构化 `data`，不再要求 Agent 解析 `stdout`。
4. 实现带 `screenId`、尺寸、旋转方向和临时图片地址的 `device.capture`。
5. 实现带截图新鲜度、点击前目标复核和点击后验证的 `device.tap`。
6. 增加高层业务动作，例如 `finance.alipay-assets`。
7. 增加任务 ID、进度查询、取消、逐设备锁和证据索引。
8. 将 API 描述转换为 MCP/Agent Tool schema，供 AI 直接发现和调用。
