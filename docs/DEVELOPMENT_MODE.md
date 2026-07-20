# 开发验收模式

当前本地配置已打开 `Xiaowei.Api.DevelopmentMode = $true`，用于联调效卫客户端和安卓设备。这个开关只影响显式的 `dev` 通道；普通 `device`、`app`、`task` 命令仍然经过原有安全门禁。

## 主机与 ADB

```powershell
# 重新枚举 ADB，并探测一次效卫设备列表
.\xhs.cmd host refresh

# 重启本机 ADB server，然后重新枚举设备并探测效卫设备列表
.\xhs.cmd host restart-adb

# 查看项目映射后的设备
.\xhs.cmd device list
```

`restart-adb` 只重启电脑上的 ADB server，不会重启手机系统，也不会清除设备数据。

## 本机 ADB 为 0 时的稳定验证

普通 Agent 不需要因为 `adb devices` 显示 0 台在线而停止。以下命令通过效卫 API 获取证据：

```powershell
.\xhs.cmd device ui --machine 02
.\xhs.cmd device screen --machine 02
.\xhs.cmd device home --machine 02
.\xhs.cmd app open --machine 02 --package com.eg.android.AlipayGphone
```

`device.ui` 使用固定的效卫 `adb_shell + uiautomator` 读取 XML；`device.screen` 使用固定的“手机内 `screencap` → 正式 `pullFile` → PNG 校验 → 手机临时文件清理”流程。`device.home` 使用正式 `pushEvent` 并验证默认桌面包；`app.open` 使用正式 `apkList/startApk` 并验证批准包前台。四个命令都由项目内部解析机器号到设备身份，不要求 Agent 提供 `serial`。不要直接用正式 `screen` action 判断截图成功，因为 9.10.113 可能返回 `SUCCESS` 但不创建文件。

`device.ui` 的 XML 只有在 `fsync`、原子重命名和完整回读均通过，且字节数与 SHA-256 和内存内容一致后才返回。`device.tap-text` 直接读取新鲜 XML 并在内存解析目标，使用固定 `wm size` 的物理尺寸换算效卫百分比坐标；它不复用 `device.ui` 文件，也不依赖本机 ADB。

## 效卫内部 API（开发期）

效卫 v9.10.113 的窗口按钮会调用内嵌 Tauri 命令。项目当前首先接入了
`get_device_list`（只返回脱敏数量）和 `restart_adb`。内部 API 调试端点只监听
本机，并且只有 `DevelopmentMode = $true` 时才会优先用于 `host restart-adb`。

```powershell
# 写入仅针对 xiaowei.exe 的 WebView2 开发参数；需要完整退出并重开效卫一次
.\xhs.cmd host enable-private-api

# 重开效卫后验证内部 Tauri API
.\xhs.cmd host private-api-status

# 优先调用效卫自己的 restart_adb；不可用时才明确回退到主机 ADB
.\xhs.cmd host restart-adb

# 验收结束后移除开发参数，再完整退出并重开效卫一次
.\xhs.cmd host disable-private-api
```

内部接口不是官方 31 项 WebSocket API，当前实现固定绑定效卫 v9.10.113；升级效卫后应重新验收命令名和参数。

## 直接调用效卫 action

```powershell
# 指定单台设备；machine 可以是机器编号、机器名或设备别名
.\xhs.cmd dev invoke --action adb --machine 04 --data-json '{"command":"devices"}'

# 执行 ADB shell 类 action
.\xhs.cmd dev invoke --action adb_shell --machine 04 --data-json '{"command":"getprop"}'

# 对全部已配置设备发送 action
.\xhs.cmd dev invoke --action <效卫action> --all --data-file .\data\xiaowei-request-data.json
```

`dev invoke` 会解除普通入口的 action 白名单、单设备限制和授权验收限制，因此可以覆盖效卫 action catalog 中的 `adb`、`adb_shell`、多设备 selector 以及其他尚未开放给普通入口的 action。它要求显式传入 `--development-mode` 的等价配置开关，默认不会因为配置缺失而放行。

## 验收完成后锁回

编辑本地配置，将下面的值改回 `$false`：

```powershell
Xiaowei = @{
    Api = @{
        DevelopmentMode = $false
    }
}
```

锁回后，`xhs.cmd dev invoke` 会直接拒绝；普通入口的生产门禁不受这次开发模式影响。
