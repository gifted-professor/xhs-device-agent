# 效卫内部 API 差集目录

适用版本：效卫 `9.10.113`。这些能力来自效卫桌面端内嵌 Tauri IPC，和官方
WebSocket 的 31 个 action 是两套入口。升级效卫后必须重新核对命令名与参数。

## 已接入

| xhs.cmd | 效卫内部命令 | 状态 |
| --- | --- | --- |
| `host private-api-status` | Tauri IPC 探测 | 已完成，只读 |
| `device.list` / 私有设备摘要 | `get_device_list` | 已完成；命名 API 只输出机器号、可见名称和脱敏在线状态 |
| `device.size` | `get_size` | 已完成，服务端注入设备标识并只输出数字宽高 |
| `host restart-adb` | `restart_adb` | 已完成，API 优先、主机 ADB 后备 |

## 已发现、待逐项封装

| 优先级 | 用户能力 | 已发现的内部命令 |
| --- | --- | --- |
| P0 | 刷新/重新连接/关闭投屏 | `get_device_list`, `reconnect_device`, `close_device`, `device_disconnect` |
| P0 | 设备参数 | `get_device_info`, `get_size`, `get_density`, `get_device_mode`, `get_root`, `get_serial_ip` |
| P1 | USB/WIFI/OTG 模式 | `usb_to_tcp`, `switch_adb_mode`, `otg_scanning`, `otg_all_scanning`, `push_scan_ips` |
| P1 | 键盘、文字、剪贴板 | `install_input`, `get_ime_list`, `get_ime_info`, `switch_ime`, `input_text`, `paste_text`, `get_clipboard`, `put_clipboard`, `pull_clipboard` |
| P1 | 应用与文件 | `get_apk_list`, `get_apk_info`, `install_apk`, `launch_app`, `uninstall_apk`, `push_file` |
| P2 | 动作与自动化 | `action_play`, `action_act`, `exec_autojs`, `exec_autojs_check`, `stop_autojs` |
| P2 | HID/无障碍控制 | `switch_accessible_mode`, `device_is_accessible`, `switch_hid_model`, `install_hid_app`, `check_hid_app_installed` |
| P3 | 高权限系统能力 | `adb_command`, `exec_command`, `merge_adb_auth_key`, `install_magisk`, `install_xwdb`, `reboot`, `reboot_ext` |

每个命令按同一流程接入：先做只读参数探测，再用单台测试机验收，最后增加稳定的
`xhs.cmd` 名称、脱敏输出、超时结果和后备策略。开发期可以放开调用；锁回生产模式时，
仅保留已逐项验收并绑定当前效卫版本的命令。

## 已确认参数与传输修复

- `get_size`：参数 `{ "serial": "<内部设备标识>" }`，02 号机实测返回 `1080x2400`。普通 Agent 只使用命名 HTTP `device.size` 并提交 `machine`；内部设备标识只由服务端解析和注入。
- `launch_app`：效卫 9.10.113 要求参数 `serial` 和 `package`。该命令仍属于开发验收通道；普通 Agent 应使用 `app.open`。`app.open` 已由项目内部完成机器号到设备身份的映射，优先调用正式 `apkList/startApk` 并通过新鲜 UI 验证，不要求本机 ADB 在线，也不向 Agent 暴露 `serial`。
- HTTP `private.invoke` 仍接收普通 `args` JSON 对象。网关内部改用 Base64 传给统一入口，再写入受控临时 JSON 文件交给私有 API 客户端，避免 Windows 命令行将嵌套 JSON 的引号解析掉。
