# 能力缺口报告：APP 启动与坐标级操控

## 元信息

| 项 | 值 |
|---|---|
| 报告日期 | 2026-07-17 |
| 报告人 | hermes-agent |
| 修复人 | Codex |
| 验证人 | Codex（隔离命名网关真机） |
| 目标机器 | 01（1号机，xiaowei-private-api） |
| 网关 | 隔离端口 17894（新代码已验证） |
| 触发场景 | 小红书综合搜索→用户 tab→找"天才较瘦"→发私信 |

---

## 2026-07-17 修复回填

- ✅ GAP-001：主命令 `app.open` 原本已经通过效卫 `apkList → startApk → 前台 UI 验证` 工作；真正缺口是旧 `device.open-xhs` 仍路由到 Matrix ADB。现已改为复用同一效卫适配器，并新增等价别名 `device.start-apk`。两个命名入口均在隔离网关真机恢复小红书前台。DCI-0044 `verified / live_verified`。
- ✅ GAP-002：新增 `device.tap-coords`。请求必须绑定点击前来源包和一个明确后态，坐标限定为 0–100 百分比；动作前复核两份新鲜 UI，只发送一次，响应不返回坐标。真机已从桌面点击小红书图标并验证小红书前台。DCI-0045 `verified / live_verified`。
- ✅ GAP-003：新增 `device.recent`，单次发送任务切换事件并以新鲜 UI 变化验证；真机通过。DCI-0046 `verified / live_verified`。
- ✅ GAP-004：`app.list` 已改走效卫 `apkList`，返回脱敏、排序、去重的包名清单；真机确认包含小红书包。纳入 DCI-0044 的旧入口依赖分叉修复。
- ✅ 补充：`device.scroll` 现支持 `left/right`。桌面无 scrollable 节点时通过前台包复核、单次水平事件和新鲜截图变化验证；真机成功从桌面第 1 屏翻到第 2 屏。DCI-0047 `verified / live_verified`。
- ℹ️ 本次使用隔离端口 17894；共享网关 17891 未重启。Hermes 复验前需在维护窗口重载共享网关。

---

## 缺口清单

### GAP-001：无法启动 App（GAP-APP-START）

| 项 | 值 |
|---|---|
| 优先级 | P0 |
| 现象 | 小红书退到后台后，无法通过 17893 网关恢复前台 |
| 根因 | `app.open` 已走效卫 API，但兼容入口 `device.open-xhs` 仍调用 `Invoke-MatrixAction.ps1`，造成入口能力分叉 |
| 影响 | 无法从桌面/后台恢复小红书，无法启动任意 App |
| 修复结果 | `device.open-xhs` 改走 `app.open` 适配器；新增 `device.start-apk` 兼容别名，均执行 `apkList/startApk/UI verify` |

**复现序列**

```bash
# 1. 小红书在前台
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.home","machine":"01"}'
# 2. 小红书退到后台
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.back","machine":"01"}'
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.back","machine":"01"}'
# 3. 尝试恢复 → 失败
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.open-xhs","machine":"01"}'
# 返回：No online ADB devices found
```

---

### GAP-002：无法通过坐标点击（GAP-POINTER-EVENT）

| 项 | 值 |
|---|---|
| 优先级 | P1 |
| 现象 | 无法点击屏幕任意坐标（如桌面图标、搜索框、tab 切换按钮） |
| 根因 | `pointerEvent` 只有内部语义节点和开发通道，没有接收当前屏幕百分比落点并强制后态的公开命名事务 |
| 影响 | 无法点击无文本/无 content-desc 的 UI 元素；无法处理 OCR 后的坐标点击 |
| 修复结果 | 新增 `device.tap-coords`，要求来源 `package`、0–100 百分比 `x/y` 和唯一后态；动作前复核来源包，单次发送后验证后态 |

**复现序列**

```bash
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"pointerEvent","machine":"01","type":"0","x":"50","y":"50"}'
# 返回：Remote command is not implemented: pointerEvent
```

---

### GAP-003：无法打开最近任务/切换 App（GAP-PUSH-EVENT-TASK）

| 项 | 值 |
|---|---|
| 优先级 | P1 |
| 现象 | 无法通过最近应用列表切换回小红书 |
| 根因 | `pushEvent` type=1（任务管理器）未注册到统一 CLI 和公开命名网关 |
| 影响 | 无法通过系统级多任务切换恢复 App |
| 修复结果 | 新增 `device.recent`，只发送一次并验证新鲜 UI 变化 |

---

### GAP-004：应用列表查询失效（GAP-ADB-DEPENDENCY）

| 项 | 值 |
|---|---|
| 优先级 | P2 |
| 现象 | `app.list` 返回 No online ADB devices found |
| 根因 | `app.list` 仍路由旧 Matrix `ListApps`，没有复用已存在的效卫 `apkList` |
| 影响 | 无法查询已安装应用，无法确认包名 |
| 修复结果 | `app.list` 改走效卫 `apkList`，返回排序去重包名，不读取本机 ADB |

---

## 已验证可用命令（无需修复）

| 命令 | 验证结果 | 备注 |
|---|---|---|
| `device.home` | ✅ | 回桌面 |
| `device.back` | ✅ | 返回键 |
| `device.screen` | ✅ | 截图，artifact 持久化 |
| `device.ui` | ✅ | UI 层级，artifact 持久化 |
| `device.scroll` | ✅ | 滚动，需 direction |
| `device.tap-text` | ✅ | 文本点击，需 postcondition |
| `device.input` | ✅ | 输入文本，需 package + EditText |
| `xhs.dm.send` | ✅ | 私信发送，需 expectedDraft |
| `xhs.observe` | ✅ | 小红书观察，需前台 |
| `device.list` | ✅ | 设备列表 |
| `device.size` | ✅ | 屏幕尺寸 |
| `api.catalog` | ✅ | API 能力目录 |
| `wechat.wallet-balance` | ✅ | 微信余额 |

---

## 建议修复后验证流程

修复 GAP-001 + GAP-002 后，以下流程应可全自动：

```bash
# 1. 启动小红书
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.start-apk","machine":"01","package":"com.xingin.xhs"}'

# 2. 截图确认首页
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.screen","machine":"01"}'

# 3. 点击搜索框（坐标或 OCR）
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.tap-coords","machine":"01","package":"com.miui.home","x":"50","y":"8","expectPackage":"com.xingin.xhs"}'

# 4. 输入"天才较瘦"
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.input","machine":"01","package":"com.xingin.xhs","text":"天才较瘦"}'

# 5. 点击"用户"tab
curl -s -X POST http://127.0.0.1:17893/v1/command -d '{"command":"device.tap-text","machine":"01","text":"用户","expectPackage":"com.xingin.xhs"}'

# 6. 找到目标用户后进入主页，点击"发私信"
# 7. device.input 输入草稿
# 8. xhs.dm.send 发送
```

---

## 附：当前自动恢复验证

修复后无需用户手动打开小红书：已分别通过 `device.start-apk` 和“桌面水平翻页 → `device.tap-coords`”恢复前台，并以小红书前台包作为明确后态完成真机验收。

---

*报告完*
