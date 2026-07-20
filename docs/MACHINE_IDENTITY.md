# 机器编号与名称

## 对操作者的唯一身份契约

- 咨询、命令和结果报告使用两位机器编号与可见名称，例如“机器 04 / `<显示名称>`”。
- 两位编号是主键。可见名称允许重复；名称匹配到多台机器时，命令会拒绝执行并要求改用编号。
- 内部设备绑定和 ADB 标识只存在于被 Git 忽略的 `config/local.psd1` 与执行层，不写入聊天、命令示例或面向操作者的状态表。
- 每次任务前以 `xhs.cmd device list` 的实时结果为准，不根据旧 runbook 或截图猜测在线状态。

## 本地配置

在 `config/local.psd1` 中为每个内部设备绑定增加一个机器目录项：

```powershell
Machines = @{
    "01" = @{
        Name = "VISIBLE_NAME_01"
        DeviceAlias = "INTERNAL_BINDING_01"
    }
    "02" = @{
        Name = "VISIBLE_NAME_02"
        DeviceAlias = "INTERNAL_BINDING_02"
    }
}
```

编号必须唯一并写成两位。每个内部绑定必须恰好属于一个编号；显示名称可以重复。

## 命令

```powershell
.\xhs.cmd device list
.\xhs.cmd device screen --machine 04
.\xhs.cmd device screen --machine-name <唯一显示名称>
.\xhs.cmd feed run --template trusted-10 --machine 04 --task-id <新任务ID>
```

旧的内部绑定参数只为现有自动化兼容保留，不属于操作者接口。
