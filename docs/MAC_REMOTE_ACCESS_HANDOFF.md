# Mac → Windows 效卫主机远程控制

## 已配置端点

- Windows 主机：本机 `~/.ssh/config` 中的 `xhs-windows` 别名
- Tailnet SSH 端口：`2222`
- Windows 登录用户：由本机 SSH 配置保存，不提交仓库
- 认证：仅 SSH 公钥，密码登录关闭
- 远程 Shell：Windows PowerShell
- 项目目录：`<WINDOWS_PROJECT_ROOT>`

## 接收并保护密钥

Windows 通过 Tailscale Send 等可信一对一通道投递两个文件：

- `<RECEIVED_PRIVATE_KEY>`：私钥
- `<RECEIVED_PUBLIC_KEY>`：公钥备查

在 Mac 上接收后执行：

```bash
mkdir -p ~/.ssh
mv ~/Downloads/<RECEIVED_PRIVATE_KEY> ~/.ssh/xhs-windows
chmod 600 ~/.ssh/xhs-windows
```

如果 Tailscale 把文件放在其他收件目录，请把实际路径替换到 `mv` 命令中。私钥不得提交到 Git、粘贴到聊天或保存在共享目录。

在本机 `~/.ssh/config` 保存真实端点，仓库文档只保留别名：

```sshconfig
Host xhs-windows
    HostName <TAILNET_HOST>
    User "<WINDOWS_USER>"
    Port 2222
    IdentityFile ~/.ssh/xhs-windows
    IdentitiesOnly yes
```

## 进入完整 Windows PowerShell

```bash
ssh xhs-windows
```

进入后先做只读验收：

```powershell
whoami
Set-Location -LiteralPath '<WINDOWS_PROJECT_ROOT>'
.\xhs.cmd help
.\xhs.cmd host status
.\xhs.cmd device list
```

远程 Agent 默认调用文档中的 Tailnet 命名 HTTPS API；`xhs.cmd` 是人工调试、兼容流程和能力缺口入口。
机器身份的显示与选择规则见 [机器编号与名称](MACHINE_IDENTITY.md)。

## 审核 Feed 兼容任务

先以 `xhs.cmd device list` 的实时结果确认机器编号、显示名称和在线状态。机器名称可能重复，因此远程任务优先使用两位编号。下面仅生成统一任务候选并显示计划，不操作手机：

```powershell
$taskId = 'mac-feed-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss')

.\xhs.cmd feed run `
  --machine 04 `
  --task-id $taskId `
  --count 11 `
  --like-at 2 `
  --favorite-at 7 `
  --dry-run
```

需要正式复合执行器时，精确 `planHash` 用于绑定同一份计划。用户已经明确请求任务时，Agent 可连续提交该哈希，不需要用户再次确认；普通命名 HTTP 或原子能力不受此流程限制。

SSH 中断后不要直接用新 task ID 重跑。先检查原任务目录的 `checkpoint.json`、`summary.json` 和 `events.jsonl`，确认是否仍在执行或是否已经完成。

## 文件访问

SSH 已包含 SFTP/SCP。它们能访问远程 Windows 账号有权访问的文件，不受 TailAgent 具名共享范围限制。

交互式 SFTP：

```bash
sftp xhs-windows
```

TailAgent Bridge 仍可用于可审计、带 SHA-256 的项目与证据传输，但它本身不执行命令，也不会开放整块 Windows 磁盘。
