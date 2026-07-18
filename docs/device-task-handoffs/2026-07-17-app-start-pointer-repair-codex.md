# App 启动、坐标点击与桌面恢复修复交接

日期：2026-07-17  
执行者：Codex  
选中机器：01（1 号机）

## 结果

- `app.open` 原本已通过效卫 `apkList/startApk` 工作；旧 `device.open-xhs` 的 Matrix/本地 ADB 分叉已移除，并新增等价入口 `device.start-apk`。
- `app.list` 已改用效卫 `apkList`，返回排序、去重的包名清单，不再依赖本地 ADB。
- 新增 `device.tap-coords`：只接受 0–100 百分比坐标，必须绑定点击前来源包和一个明确后态；动作前复核来源页面，只发送一次，公开响应不回传坐标。
- 新增 `device.recent`：单次打开最近任务，并通过新鲜 UI 变化确认结果。
- `device.scroll` 新增 `left/right`，可在桌面执行水平翻页；动作前要求稳定截图基线，动作后验证前台包未漂移且屏幕已变化。

## 真机验收

- 使用隔离命名网关 `127.0.0.1:17894` 和 1 号机完成验证。
- `app.list` 返回效卫应用清单，并确认小红书已安装。
- `device.open-xhs` 与 `device.start-apk` 均可从桌面恢复小红书前台。
- `device.home` 后，`device.scroll right` 成功切换桌面页；随后 `device.tap-coords` 单次点击图标并验证小红书前台，响应中未出现坐标。
- `device.recent` 成功打开最近任务；验证结束后已重新恢复小红书前台。
- 未发送评论或私信，也未产生待发送草稿。

## 接口用法

启动任意已安装 App：

```json
{"command":"device.start-apk","machine":"01","package":"com.xingin.xhs"}
```

桌面水平翻页：

```json
{"command":"device.scroll","machine":"01","package":"com.miui.home","direction":"right","steps":1}
```

坐标点击必须使用当前截图得到的新鲜百分比坐标，并提供唯一后态：

```json
{"command":"device.tap-coords","machine":"01","package":"com.miui.home","x":"<0-100>","y":"<0-100>","expectPackage":"com.xingin.xhs"}
```

若发送结果不确定，先只读观察，不能直接重试点击。

## 资源与运行状态

- 共享网关 `127.0.0.1:17891` 未重启、未被本任务打断；Hermes 使用新接口前需在维护窗口重载共享网关。
- 隔离网关只用于本次验证，收尾时停止并释放端口。
- 1 号机结束在小红书前台，无内容写入。

## 事件状态

- DCI-0044：`verified / live_verified`，旧 App 入口和应用清单的本地 ADB 分叉已移除。
- DCI-0045：`verified / live_verified`，带来源包与明确后态的百分比坐标点击通过真机验证。
- DCI-0046：`verified / live_verified`，最近任务命名命令通过真机验证。
- DCI-0047：`verified / live_verified`，桌面水平翻页通过真机验证。
- 本次没有新建仍为 open、mitigated 或 reopened 的事件；事件簿中既有未关闭事项保持原状态。

## 验证范围

- 全仓测试 510/510 通过。
- JavaScript 检查、PowerShell 解析、仓库策略扫描、事件簿校验和 `git diff --check` 均通过。
- 新增覆盖包括应用清单、两个启动入口、坐标点击、最近任务、水平桌面翻页，以及命名 HTTP 的参数与脱敏输出约束。

## 使用边界

- `device.tap-coords` 不是盲点按接口：必须由当前页面的新鲜观察得到坐标，并绑定唯一后态。
- 坐标事件一旦发送且结果不确定，不会自动重放。
- 水平翻页只在前台包和两次截图基线稳定时发送；变化无法验证时按失败关闭。
