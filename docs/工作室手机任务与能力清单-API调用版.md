# 工作室手机任务与能力清单（API 调用版）

> 用途：规定本机 Agent 和 Tailnet 远程 Agent 如何通过统一 HTTP API 操作效卫及安卓设备，并记录任务、能力、后态和证据。
>
> 原则：没有明确下一步时不操作手机；每次状态变化前确认目标设备，动作后读取新鲜状态。API 返回“成功”不等于手机业务结果已经完成。

## 1. 控制方式

### 1.1 统一入口

| 场景 | 入口 |
| --- | --- |
| 本机 Agent | `http://127.0.0.1:17891/v1/command` |
| Tailnet 远程 Agent | `https://desktop-3i1evhe.tail400674.ts.net/v1/command` |
| 人工调试与兼容 | `xhs.cmd` |

Agent 默认调用 HTTP API，不打开终端窗口、不点击 Codex 界面，也不依赖效卫窗口坐标。

`xhs.cmd` 是人工调试和旧流程兼容入口；当前 HTTP 网关已直接调用 Node 动作路由，其中部分设备动作仍会复用 PowerShell 动作脚本，后续再迁移为常驻服务直接调用。

### 1.2 通道分层

必须区分三个概念：

- `transport`：请求怎样到达控制主机，即 `local_http` 或 `tailscale_https`。
- `controlBackend`：动作由什么执行，即 `xiaowei_official`、`xiaowei_private` 或 `controlled_adb_ui`。
- `verificationBackend`：用什么证明结果，即 UI hierarchy、前台包名、系统状态或手机截图。

推荐优先级：

```text
高层语义 API
  -> 效卫正式 API（已验收时优先）
  -> 效卫私有 API（开发期、版本绑定）
  -> 受控 ADB/UI（能力回退和后态验证）
  -> 人工处理（登录、验证码、支付和安全确认）
```

禁止普通任务直接连接裸 ADB、`adb_shell`、效卫私有 WebSocket 或任意桌面点击。开发期完整能力只能经过 `dev.invoke`/`private.invoke`，并接受网关参数校验、脱敏和审计。

## 2. 任务状态

```text
待定义 -> 待执行 -> 执行中 -> 待人工确认 -> 已验证
                         |              |
                         +-> 需封装能力  +-> 需人工处理
                         |
                         +-> 阻断
```

- `待定义`：任务已提出，目标、设备或后态尚不完整。
- `待执行`：目标设备、动作和预期结果已经明确。
- `执行中`：API 请求或后态读取正在进行。
- `待人工确认`：出现登录、验证码、权限、支付、提交或安全验证。
- `已验证`：新鲜 UI、前台应用、系统状态或截图证明结果。
- `需封装能力`：底层可能可调用，但还没有稳定的高层动作和验收标准。
- `需人工处理`：只能由人在设备上完成后再继续。
- `阻断`：设备、身份、权限、页面、后态或安全条件不满足。

## 3. API 调用协议

所有动作：

```text
POST /v1/command
Content-Type: application/json
```

健康检查：

```text
GET /health
```

最小请求：

```json
{
  "command": "device.list"
}
```

返回成功只表示底层命令进程成功结束。状态变化动作必须再发送只读请求，例如 `device.ui` 或 `device.screen`，验证业务后态。

当前网关会全局串行处理请求；Agent 不应同时向同一设备发送多个状态变化动作。后续高层多设备任务由服务内部实现逐设备锁。

## 4. 任务记录格式

```yaml
taskId: STUDIO-API-001
name: 待定义
status: 待定义
createdAt: YYYY-MM-DDTHH:mm:ss+08:00
transport: local_http / tailscale_https
endpoint: http://127.0.0.1:17891/v1/command
device:
  machine: "1号机"
  machineId: "01"
  selectionConfirmed: false
  lockId: null
app:
  name: 待提供
  package: 待提供
goal: 待提供
inputData:
  # 不记录密码、验证码、支付信息、令牌或完整设备序列号
steps:
  - stepId: "1"
    instruction: 待提供
    requestBody: {}
    controlBackend: 待判定
    expectedState: 待提供
    verificationRequest: {}
    confirmationRequired: false
    requestId: null
    status: 待定义
    evidence: []
    result: 待执行
capabilitiesNeeded: []
rollback: 待提供
notes: []
```

## 5. 单步执行协议

每次只推进一个可验证步骤：

```text
1. 调用 device.list，确认机器号、显示名称和在线状态
2. 调用 device.ui 或 device.screen，读取新鲜前态
3. 记录动作意图、目标设备、预期后态和回滚方式
4. 发送一次状态变化请求；超时不自动重发
5. 再次读取 UI、前台应用、系统状态或截图
6. 判定：已验证 / 失败 / 不确定 / 需人工处理
7. 保存 requestId、证据路径、摘要和下一步
```

如果动作来自截图坐标，还必须记录 `screenId`、截图尺寸、旋转方向、截图时间、目标像素坐标和点击前目标复核结果。动态目标不能使用已经移动的旧截图坐标。

设备身份必须使用项目的两位机器编号，例如 `01`。如果效卫设备身份与 ADB 后态无法对齐，不得用另一台设备的状态证明本次动作。

## 6. 能力登记格式

```yaml
capabilityId: CAP-API-001
name: 待定义
purpose: 待定义
target: 单台设备 / 多台设备 / 主机
transport:
  - local_http
  - tailscale_https
apiCommand: 待定义
controlBackend: xiaowei_official / xiaowei_private / controlled_adb_ui / composite
verificationBackend: ui_hierarchy / foreground_package / screenshot / system_state
versionBinding: null
remoteExposed: true
auditRequired: true
preconditions: []
requestSchema: {}
verification: 待定义
confirmationGate: 无 / 需要确认 / 必须人工
rollback: 待定义
risk: 只读 / 导航 / 本地变化 / 破坏性
status: 候选
lastVerified: null
notes: []
```

## 7. 当前已确认能力

| 能力 | API command | 控制/验证方式 | 状态 |
| --- | --- | --- | --- |
| 网关健康检查 | `GET /health` | 本机服务状态 | 可用 |
| 设备清单 | `device.list` | 项目设备映射 | 可用 |
| UI hierarchy | `device.ui` | 效卫 API 返回 XML，不依赖本机 ADB | 可用，02 号机已验收 |
| 手机截图 | `device.screen` | 效卫生成 PNG + `pullFile` + 图片校验 | 可用，02 号机已验收 |
| HOME / BACK | `device.home` / `device.back` | 动作后读取新鲜 UI/截图 | 受限可用 |
| 亮屏 / 熄屏 | `device.screen-on` / `device.screen-off` | 需要原因和回滚 | 可用 |
| 系统设置 | `device.settings` | 需要原因和回滚 | 可用 |
| 应用清单 | `app.list` | 只读 | 可用 |
| 打开批准应用 | `app.open` | 正式 API 优先，受控回退 | 有条件可用 |
| 停止批准应用 | `app.stop` | 需要原因和回滚 | 可用 |
| 受限语义点按 | `device.tap-text` | 精确文字、一次动作、一个后态 | 可用 |
| 截图坐标点击 | `dev.invoke` + `pointerEvent` | 原图像素换算为效卫百分比坐标 | 开发期静态目标已验证 |
| 稳定截图会话 | `device.capture` | 返回 `screenId`、图片、尺寸、旋转和时间 | 待实现 |
| 稳定像素点击 | `device.tap` | 绑定 `screenId`，点击前复核、点击后验证 | 待实现 |
| 刷新效卫设备 | `host.refresh` | 主机动作 | 可用 |
| 重启 ADB | `host.restart-adb` | 效卫私有 `restart_adb` 优先 | 可用 |
| 正式 API 目录 | `api.catalog` | 31 actions | 可用 |
| 私有 API 目录 | `private.catalog` | 70 commands，效卫 9.10.113 | 开发期可用 |
| 正式 API 通用调用 | `dev.invoke` | 开发模式 | 开发期可用 |
| 私有 API 通用调用 | `private.invoke` | 版本绑定、网关审计 | 开发期可用 |

### 7.1 后态证据通道

从 2026-07-15 起，普通任务的 UI/截图后验不得再以“本机 ADB 在线”为前提：

- `device.ui` 固定经效卫 `adb_shell` 获取 `uiautomator` XML；项目只输出脱敏后的证据路径。
- `device.screen` 固定经效卫在手机生成临时 PNG，再由正式 `pullFile` 拉回；只有文件稳定、PNG 结构和尺寸有效且手机临时文件已执行清理后，才能报告成功。
- 效卫正式 `screen` action 返回 `SUCCESS` 但没有文件时，必须判定为“没有证据”，不能继续等待一个不会出现的文件，也不能把它当作截图成功。
- `adb devices` 为 0 只表示主机直连 ADB 不可用，不再等同于效卫控制下的手机离线。应以 `device.ui`、`device.screen` 或效卫设备清单的结果判断。

02 号机实测证据：本机 HTTP 的 `device.ui`、`device.screen` 均返回 200；截图为 1080×2400。Tailscale HTTPS 的 `device.ui` 也返回 200。

## 8. 已有底层通道但尚未形成稳定高层能力

以下能力不能写成“完全不可用”，因为开发期可以通过效卫正式/私有 API 探索；但在完成参数、目标限制、回滚和真实后态验收前，不得作为普通任务的稳定能力：

- 语义节点点击和受限容器滑动
- 逐机可验证文字输入
- 剪贴板读写
- 文件上传、下载和存在性验证
- APK 安装、版本检查和卸载回滚
- 分辨率、DPI 修改和恢复
- 效卫界面中其余尚未封装的设置项
- 带截图新鲜度和目标重定位的稳定像素点击

这些能力应按“底层可调用 -> 单机验收 -> 多机验收 -> 高层命名命令 -> 普通任务开放”的顺序推进。

## 9. 截图驱动的精确像素点击

### 9.1 使用定位

推荐顺序：

1. UI hierarchy/资源 ID 能稳定定位时，优先语义动作。
2. UI 没有有效节点、画布控件或视觉按钮无法语义定位时，使用截图视觉定位。
3. 坐标点击必须绑定产生坐标的那张截图，并在动作后读取新鲜后态。

截图点击不是“看到大概位置就盲点”。它是一个带设备身份、截图版本、目标复核和后态验证的受控动作。

### 9.2 当前开发期方式

当前通过 `device.screen` 获取原图，再用效卫正式 `pointerEvent` 验证底层坐标：

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

换算公式：

```text
xPercent = xPixel / screenWidth  * 100
yPercent = yPixel / screenHeight * 100
```

这个开发入口不提供 `screenId` 新鲜度保护，不能作为最终普通任务接口。

### 9.3 4 号机实测

测试日期：`2026-07-15`，原图为 `1080×2400`。

- 底部“首页”中心 `(108,2280)` 一次命中。
- 底部“理财”中心 `(324,2280)` 一次命中并恢复。
- 总资产眼睛图标中心 `(271,281)` 连续命中两次：第一次隐藏金额，第二次恢复。
- 眼睛图标属于几十像素的小目标，证明静态小控件可以可靠点击。
- 自动轮播卡片中的小 `+` 在截图后发生位移，因此旧坐标没有命中；数值没有变化，也没有发送错误的恢复动作。

证据：

- `data/matrix/runs/20260715-191034-089-f66bcc83/device-04/screen.png`
- `data/matrix/runs/20260715-191114-483-a5ef330b/device-04/screen.png`
- `data/matrix/runs/20260715-191158-241-16e2e018/device-04/screen.png`
- `data/matrix/runs/20260715-191255-260-181255bc/device-04/screen.png`

当前结论是“静态小目标已验证”，不是“单像素误差已证明”或“动态页面永不点偏”。

### 9.4 计划中的正式接口

截图：

```json
{
  "command": "device.capture",
  "machine": "04"
}
```

返回至少包含：

```json
{
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

点击：

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

服务端执行规则：

1. `screenId` 必须来自同一设备，且未超过允许时间。
2. 分辨率、旋转方向、前台应用和设备身份必须保持一致。
3. 点击前重新读取目标附近区域；目标移动时重新定位或拒绝。
4. 坐标越界、目标消失、置信度不足或页面敏感时停止。
5. 只发送一次点击，不因超时自动重放。
6. 点击后自动获取新截图/UI，并按 `postcondition` 判定结果。
7. 密码、验证码、支付、转账、购买、赎回和提交按钮即使坐标明确，也必须进入人工确认。

### 9.5 动态页面规则

动态轮播、动画、弹窗、键盘升降和横竖屏变化可能让旧坐标失效。对这类目标：

- Agent 应同时提交参考边界框或目标图块。
- 服务端在点击前获取目标附近的新图并重新匹配。
- 位移超过阈值时返回 `stale_screen` 和新截图，不发送点击。
- 不能仅靠“API 返回 SUCCESS”判定命中。

## 10. 支付宝理财总资产统计

### 10.1 当前结论

本机和远程 Agent 都可以通过新 API 完成支付宝理财总资产统计，不需要点击效卫或 Codex 窗口。

当前还没有单条 `finance.alipay-assets` 命令，因此由 Agent 编排现有命名动作。登录、验证码、人脸、安全确认、支付和资金变更仍由人工处理。

### 10.2 单机流程

#### 1. 确认设备

```json
{
  "command": "device.list"
}
```

目标机器必须在线，且机器编号与任务一致。

#### 2. 读取前态

```json
{
  "command": "device.ui",
  "machine": "01"
}
```

如果页面是登录、验证码、支付或安全确认，停止该设备并记录 `需人工处理`。

#### 3. 打开支付宝

```json
{
  "command": "app.open",
  "machine": "01",
  "package": "com.eg.android.AlipayGphone"
}
```

动作后再次调用 `device.ui`，验证前台包名为支付宝。底层命令即使返回失败，只要独立的新鲜后态证明支付宝已经在前台，也可以把业务步骤记为成功。

#### 4. 进入理财页

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

动作只能发送一次。理财页动态内容导致后验超时时，不得自动再次点击“理财”；应改为只读 `device.ui` 诊断。

#### 5. 读取金额

```json
{
  "command": "device.ui",
  "machine": "01"
}
```

同时满足以下条件才能计入：

- 前台包名为 `com.eg.android.AlipayGphone`。
- 页面存在 `总资产(元)`。
- 金额资源 ID 为 `com.alipay.android.widget.fortunehome:id/fh_tv_assets_amount_num`。
- 金额文本不是掩码、空值或旧证据。
- UI 读取时间晚于进入理财页动作。

金额先转换为整数“分”，汇总后再格式化为两位小数，禁止使用二进制浮点直接累加。

#### 6. 保存截图证据

```json
{
  "command": "device.screen",
  "machine": "01"
}
```

截图用于人工复核；机器读取金额优先使用 UI hierarchy，不使用未经验证的 OCR 猜测。

### 10.3 四机统计

对 `01`、`02`、`03`、`04` 分别执行单机流程：

- 当前网关全局串行，请求按设备逐步发送，不要在客户端无控制地并发。
- 一台设备失败不应污染其他设备的金额。
- 离线、未登录、金额隐藏、设备锁占用或后态不确定的设备不计入合计。
- 输出必须包含每台设备状态、单机金额、证据、未计入原因和已验证合计。

推荐结果格式：

```json
{
  "taskId": "STUDIO-API-001",
  "currency": "CNY",
  "totalCents": 12345678,
  "total": "123456.78",
  "devices": [
    {
      "machine": "01",
      "status": "verified",
      "amountCents": 5000000,
      "amount": "50000.00",
      "requestIds": [],
      "evidence": []
    },
    {
      "machine": "02",
      "status": "human_required",
      "reason": "login_required",
      "requestIds": [],
      "evidence": []
    }
  ]
}
```

### 10.4 计划中的高层命令

后续建议封装：

```json
{
  "command": "finance.alipay-assets",
  "machines": ["01", "02", "03", "04"]
}
```

该命令尚未实现，不能提前作为现有能力调用。实现后应由服务内部负责跨设备并行、单设备串行、设备锁、后态验证、金额计算和证据索引。

## 11. 停止条件

出现以下任一情况立即暂停对应设备：

- 设备编号、显示名称、效卫身份和后态身份不一致。
- 设备离线、被占用或状态在动作期间变化。
- 登录、密码、验证码、人脸、权限确认或安全验证。
- 支付、转账、赎回、购买、提交或其他资金变化。
- 目标页面与预期不符，或金额字段不可验证。
- API 超时且无法确认动作是否已发送。
- 截图已过期、分辨率/旋转变化或视觉目标在点击前发生位移。
- 必须绕过统一 API 使用裸 ADB、任意坐标或私有 WebSocket。

超时后的默认动作是只读诊断，不是重发状态变化动作。

## 12. 已知问题

### 效卫 `screen` 的 SUCCESS 不代表文件已创建

效卫 9.10.113 的正式 `screen` action 可以在未创建本地文件时返回 `SUCCESS`。稳定命令已经绕开该行为：使用效卫 `adb_shell` 生成手机临时截图，再用正式 `pullFile` 拉回并校验。Agent 不应自行回退到裸 ADB，也不应直接调用 `screen` 后只检查返回码。

### 私有 API JSON 与 `launch_app` 参数

远程 `private.invoke` 的参数现由网关内部使用 Base64 和临时 JSON 文件传递，避免 Windows 参数解析丢失双引号。效卫 9.10.113 的 `launch_app` 要求 `serial` 和 `package`。普通业务不要自行读取或提交序列号，应调用 `app.open`；`private.invoke launch_app` 仅用于开发验收。

当前 `app.open` 已由项目内部完成机器号到设备身份的映射，不依赖本机 `adb devices`。执行顺序固定为：批准包校验 → 效卫正式 `apkList` 确认安装 → 效卫正式 `startApk` → 新鲜 UI 验证前台包。`serial` 不进入普通 HTTP 请求或返回值。`device.home` 同样通过效卫正式 `pushEvent` 和新鲜 UI 验证，不再被本机 ADB 为 0 阻断。

### 命令结果与业务结果不同

所有导航动作仍必须分别记录：

- `executionOutcome`：请求是否被接受、动作是否可能已发送。
- `verificationOutcome`：新鲜后态是否证明目标状态。
- `status`：最终能否安全报告成功。

### HOME 前台验证

`device.home` 先通过效卫固定只读命令解析当前设备的默认 HOME 包，再发送一次 `pushEvent`，最后用新鲜 UI 验证该包已经前台。验证失败时不重复发送 HOME。

### 支付宝启动兼容性

`app.open` 使用效卫正式 `apkList`、`startApk` 和 UI 后验，不要求普通任务提供私有 `launch_app` 的 `serial`，也不因本机 ADB 为 0 停止。2026-07-15 已在 02 号机完成命令行与 HTTP 真机验收：支付宝安装确认、启动请求和前台包验证均成功。

### “理财”文字节点可能没有坐标

语义点按实现会从新鲜 UI 中回溯可点击父节点。普通任务只传递文字和后态，不传任意坐标。`device.tap-text` 已迁移到效卫 API 通道，不读取另一次 `device.ui` 的 `window.xml`，也不依赖本机 ADB。

坐标换算必须使用固定只读 `wm size` 返回的物理屏幕尺寸，不能使用 UI 层级节点的最大底边。02 号机支付宝首页实测 UI 最大底边为 2,175、物理屏幕高度为 2,400；旧换算会误触系统 HOME。修正后“理财”只发送一次点按，并由指定资源 ID 证明进入理财页。

### UI XML 落地完整性

`device.ui` 和 `device.tap-text` 的 XML 证据使用临时文件写入、`fsync`、原子重命名、完整回读、字节数和 SHA-256 双重比对。若磁盘文件与内存 XML 不完全一致，命令直接失败，不会返回一个可能为空或未完成的路径。02 号机实测报告 79,619 字节，立即读取和 600ms 后读取均为 79,619 字节，哈希一致。

### 理财页面是动态页面

广告、推荐和倒计时会使两次 UI 不完全一致。只验证支付宝包名、页面标题和金额资源 ID，不要求整棵 UI 树完全相同。

## 13. 权限与安全阶段

当前为开发验收阶段：Tailnet 内可达节点可以调用完整网关能力，私有 API 和 `dev.invoke` 也已接通。这个“全部放开”只表示控制通道开放，不取消任务级安全规则和人工确认门。

验收完成后再逐步限制：

1. 强制 Tailscale 身份。
2. 按 Agent、设备和命令授权。
3. 普通任务只开放高层命名动作。
4. `dev.invoke`/`private.invoke` 只对维护身份开放。
5. 对资金变化、系统设置、安装卸载等增加审批和速率限制。

## 14. 后续优化清单

- 实现 `finance.alipay-assets` 高层业务 API。
- 实现带 `screenId`、临时图片地址、尺寸、旋转和时间戳的 `device.capture`。
- 实现带截图新鲜度、点击前目标复核、动态重定位和点击后验证的 `device.tap`。
- 将网关内部动作迁移为常驻服务直接调用，减少 PowerShell/Node 子进程启动。
- 让 `xhs.cmd` 改为本机 API 的轻量客户端。
- API 直接返回结构化 `data`，不再要求 Agent 二次解析 `stdout`。
- 增加任务创建、进度查询、取消、设备锁和证据索引。
- 为 HOME 增加 launcher UI/截图后验。
- 增加异常分类：未登录、启动失败、前台误报、动态页面超时、设备离线、设备锁占用。
- 将稳定命令发布为 MCP/Agent Tools，供 AI 按 JSON Schema 直接调用。

## 15. 历史记录说明

原始《工作室手机任务与能力清单》中的 `STUDIO-001` 是旧 CLI 入口下的历史执行记录，应继续保留，不能改写成当时已经通过 HTTP API 执行。

从本文件启用后的新任务使用 `STUDIO-API-*` 编号，并记录 endpoint、requestId、controlBackend、verificationBackend 和新鲜证据时间。
