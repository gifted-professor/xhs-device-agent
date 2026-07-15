# 通过 Tailscale 远程控制效卫与小红书任务

## 结论

这台 Windows 主机使用传统 Windows OpenSSH Server 提供完整 PowerShell，Tailscale Serve 只在 tailnet 内发布 SSH 端口。远端进入 PowerShell 后，设备操作仍统一通过项目根目录的 `xhs.cmd` 执行。

Windows 目前不能作为 Tailscale SSH 服务端，因此这里不是 `tailscale up --ssh`。它是“OpenSSH Server + Tailscale 私网转发”：

```text
远端自有设备
  -> Tailscale/WireGuard
  -> tailnet TCP 2222
  -> Tailscale Serve
  -> 本机 127.0.0.1:22
  -> Windows PowerShell
  -> xhs.cmd
  -> 本机效卫/ADB
  -> 小红书手机
```

公开网络和局域网不开放 SSH 端口。安装脚本关闭 OpenSSH 自动创建的公网/局域网入站防火墙规则，并禁用密码登录；实际身份认证使用 SSH 公钥。Tailscale 的 tailnet 访问控制仍会在连接进入主机前生效。

官方依据：

- [Tailscale SSH 的 Windows 服务端限制](https://tailscale.com/kb/1193/tailscale-ssh#limitations)
- [Tailscale Serve TCP 转发](https://tailscale.com/docs/reference/tailscale-cli/serve#use-a-tcp-forwarder)
- [Microsoft Windows OpenSSH Server 安装说明](https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse)

## 一次性安装

### 1. 在远端控制设备生成密钥

在准备发起远程控制的电脑上执行：

```powershell
$KeyPath = Join-Path $HOME '.ssh/xhs-device-agent'
ssh-keygen -t ed25519 -f $KeyPath
```

把生成的 `xhs-device-agent.pub` 公钥文件复制到这台效卫主机。私钥 `xhs-device-agent` 留在远端控制设备，不要复制到效卫主机。

### 2. 在效卫主机安装

使用当前 Windows 账号打开“以管理员身份运行”的 PowerShell，然后执行：

```powershell
Set-Location -LiteralPath '<WINDOWS_PROJECT_ROOT>'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\Install-TailscaleOpenSsh.ps1 `
  -PublicKeyPath 'C:\path\to\xhs-device-agent.pub'
```

脚本会完成以下操作：

1. 安装并启动 Windows OpenSSH Server。
2. 把当前管理员账号配置为公钥登录。
3. 禁用 SSH 密码登录。
4. 把远程默认 Shell 设置为 Windows PowerShell。
5. 关闭 OpenSSH 自动创建的普通网络端口 22 入站规则。
6. 持久配置 Tailscale Serve：tailnet 端口 `2222` 转发到本机 `127.0.0.1:22`。

重复执行是幂等的：已有公钥和配置会保留，目标公钥只追加一次。

### 3. 本机检查

```powershell
.\scripts\Test-TailscaleOpenSsh.ps1
```

只有所有检查均为 `true` 时，状态才会返回 `ready`。

## 远端进入完整 Shell

安装脚本会返回 `TailnetHost`、`TailnetPort` 和 `WindowsUser`。在远端控制设备执行：

```powershell
$KeyPath = Join-Path $HOME '.ssh/xhs-device-agent'

ssh `
  -i $KeyPath `
  -p 2222 `
  -l '<WINDOWS_USER>' `
  '<安装脚本返回的 TailnetHost>'
```

这是当前 Windows 账号的完整 PowerShell，不是受限的设备命令网关。不要把私钥放到不受信任的设备；同时应在 Tailscale 管理后台把目标端口 `2222` 的访问范围限制到自己的控制设备或身份。

## 执行小红书“基操”runbook

进入远程 Shell 后先核对当前机器编号、显示名称和在线状态。名称可能重复，任务选择以两位编号为准：

```powershell
Set-Location -LiteralPath '<WINDOWS_PROJECT_ROOT>'
.\xhs.cmd device list
```

随后执行已经通过验收的 10 条 Feed 模板。`04` 仅在它仍是当前配置中唯一映射且在线的机器编号时使用：

```powershell
$taskId = 'remote-feed-trusted-10-' + (Get-Date -Format 'yyyyMMdd-HHmmss')

.\xhs.cmd feed run `
  --template trusted-10 `
  --machine 04 `
  --task-id $taskId
```

该模板保持已验收规格：浏览 10 条，第 5 条点赞，第 7 条收藏，视频按固定停留规格执行，并生成本地结果和证据目录。

如果 SSH 在任务执行中断线，不要立刻换一个新 task ID 重跑。先用原 task ID 检查任务目录里的 `checkpoint.json`、`summary.json` 和 `events.jsonl`，确认设备是否仍在执行或动作是否已经完成，避免重复点赞、收藏或浏览。

也可以从远端控制设备直接调用项目提供的参数安全封装，避免多层 Shell 引号破坏中文或空格：

```powershell
$KeyPath = Join-Path $HOME '.ssh/xhs-device-agent'
$InvokeXhs = Join-Path (Get-Location) 'scripts/Invoke-XhsOverTailscale.ps1'

& $InvokeXhs `
  -HostName '<安装脚本返回的 TailnetHost>' `
  -UserName '<WINDOWS_USER>' `
  -IdentityFile $KeyPath `
  -ProjectRoot '<WINDOWS_PROJECT_ROOT>' `
  -XhsArguments @(
    'feed', 'run',
    '--template', 'trusted-10',
    '--machine', '04',
    '--task-id', ('remote-feed-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  )
```

`Invoke-XhsOverTailscale.ps1` 把参数编码后在远端还原成参数数组，最终仍调用唯一公开入口 `xhs.cmd`，不会直接调用内部脚本或原始 ADB。

## 与 TailAgent Bridge 配合

TailAgent Bridge 负责文件，不负责命令执行。推荐把它配置成两项互不重叠的 Windows 共享：

| 建议共享名 | Windows 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| `xhs-device-agent` | 本项目根目录 | 只读 | Mac 查看代码、runbook、summary、checkpoint 和截图证据 |
| `xhs-agent-drop` | 独立目录，例如 `<WINDOWS_USER_HOME>\TailAgentInbox\xhs-device-agent` | 可读、create-only 写入 | Mac 投递新任务或补丁文件，不允许覆盖 |

不要把可写共享放进项目、`data`、启动目录、`.codex`、令牌目录或用户主目录。TailAgent 收到的文件也不会自动触发 SSH 或 `xhs.cmd`；是否执行仍由一次明确的 SSH 命令决定。

Windows 已有 TailAgent 配置时必须保留现有客户端目标，不能直接用 `tailagent init --force` 覆盖现有配置。

Windows 服务端推荐保持 TailAgent 只监听 `127.0.0.1:18765`，再通过 Tailscale Serve 在 tailnet 内发布 HTTPS 端口，例如 `8443`。给 Mac 的令牌只包含以下精确范围：

```text
share:xhs-device-agent:read
share:xhs-agent-drop:read
share:xhs-agent-drop:write
```

如果 Mac 只需要读取，则不要签发后两项 inbox 权限。令牌文件通过 Tailscale Send 或其他可信的一对一通道传递，不放进聊天、项目、日志或截图。

Mac 添加 Windows 为目标并完成 `doctor`、`probe`、`shares` 验收后，可以拉取结果证据；真正运行 Feed 任务仍通过本页的 SSH 命令。

## 能力边界

- `xhs.cmd doctor`、`host status`、`device list/screen/ui/open-xhs`、`feed run` 等命令可以通过 SSH 执行。
- 已经在交互桌面运行的效卫、其本机 WebSocket 和 ADB 可以由远程 `xhs.cmd` 使用。
- SSH 是命令会话，不是 Windows 桌面画面。如果要直接查看或点击效卫桌面窗口，应另走只经 Tailscale 开放的远程桌面工具。
- 若效卫没有在交互桌面启动，从 SSH 会话调用 `host start` 可能把 GUI 启动到非交互会话；更稳妥的做法是让效卫随当前用户登录启动，再远程调用设备命令。
- 每次正式任务前都运行 `xhs.cmd device list`。对操作者只使用机器编号和显示名称；内部设备绑定不写入咨询、命令示例或结果报告。
