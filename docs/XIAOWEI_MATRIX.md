# 效卫矩阵接入

本项目把效卫（包括绿箭定制版）定位为设备连接、投屏、分组和人工接管控制台，把 ADB 定位为正式自动执行通道。每台手机都按自己的应用版本、Android SDK、分辨率、DPI 和实时 UI 层级执行，效卫群组不会被视为同一套坐标布局。

## 通道策略

1. **ADB**：默认正式通道，负责启动包名、UI dump、截图、语义节点点击、滚动和后验验证。
2. **效卫桌面**：负责观察、设备分组和单机人工最终操作；中文自动输入不可用时由人工粘贴。
3. **效卫本地 API**：默认关闭的实验通道。只在探测成功、会员权限有效并完成逐动作验收后启用；接口成功仍需 ADB/UI 验证。

当前 API 因版本或会员限制不可用时，不影响 ADB 研究流程。不要尝试绕过会员限制，也不要把官网能力描述当作接口保证。

## Windows 10 截图兼容

Windows 10 22H2（build 19045）不提供 `Windows.Graphics.Capture.GraphicsCaptureSession.IsBorderRequired`；该属性从 build 20348 才可用。当前 Computer Use 截图组件在调用前没有完成系统版本门控时，会返回 `不支持此接口 (0x80004002)`。这是 Windows 截图接口兼容问题，不是效卫安装、会员或 ADB 故障。

`scripts/Matrix-Preflight.ps1` 会输出 `windowsCapture`：

- `computerUseWindowScreenshotCompatible=true`：使用 Computer Use 的窗口截图；
- `computerUseWindowScreenshotCompatible=false`：不要重试该截图调用。手机画面继续使用 ADB 截图和实时 UI 层级；确需查看效卫桌面时，先让效卫窗口处于前台、完整可见且无遮挡，再运行只读后备：

```powershell
$hwnd = (Get-Process -Name xiaowei | Where-Object MainWindowHandle -ne 0).MainWindowHandle
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File scripts/Capture-VisibleWindow.ps1 `
  -WindowHandle $hwnd -OutputPath xiaowei-view.png -AsJson
```

后备只复制该可见窗口的屏幕像素，不发送键鼠事件，不读取剪贴板，也不加载第三方原生插件。图片只能写入 Git 已忽略的 `data/windows-capture/`，文件存在时拒绝覆盖。窗口被最小化、不是前台、越出可见桌面或 HWND 失效时安全停止。

官方依据：[Microsoft `IsBorderRequired` 版本要求](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)；[Codex Windows 10 同类问题](https://github.com/openai/codex/issues/25411)。

## 正式设备标定

复制模板：

```powershell
Copy-Item config/matrix.example.psd1 config/local.psd1
```

真实映射只写在被 Git 忽略的 `config/local.psd1`：

- `Machines`：两位机器编号到可见名称和内部绑定；名称可重复，编号唯一；
- `Devices`：ADB 序列号到内部绑定，只供程序使用；
- `Groups`：任务分组到真实序列号列表；
- `AdbPath`：效卫内置或独立 ADB 的实际路径；
- 可选 `TextInput.UnicodeIme`：只有 `Enabled = $true`、`HumanApproved = $true`，并且设备别名在 `ApprovedAliases` 中时才允许使用。

所有当前在线手机都必须先完成真实编号和分组标定。某任务引用的分组不存在、为空、包含未映射设备或没有健康在线设备时，正式研究必须拒绝；不要临时把排序后的序列号当成业务编号。

Unicode 输入保持默认关闭。只有已安装、已标定的设备端输入法才可在本地配置中启用：

```powershell
TextInput = @{
    UnicodeIme = @{
        Enabled = $true
        HumanApproved = $true
        Action = "ADB_INPUT_B64"
        ExtraKey = "msg"
        ApprovedAliases = @("device-01")
    }
}
```

`Action` 和 `ExtraKey` 必须与已验收输入法完全一致；示例值不是安装或批准证明。

预检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Matrix-Preflight.ps1 -ProbeApi
```

报告写入 `data/matrix/preflight.json`。控制台和对外结果只使用机器编号和可见名称，不显示内部绑定或真实序列号。

## 能力与权限

| 效卫/ADB 能力 | 项目中的用法 | 默认权限 |
| --- | --- | --- |
| USB / OTG / Wi-Fi 连接 | 效卫维护连接，预检读取在线清单 | 允许 |
| 设备分组 | 仅选择目标；动作仍逐机解析、逐机记录 | 允许读取 |
| 打开 App、搜索、返回 | ADB 按当前 UI 语义执行并验证 | 只读允许 |
| 截图、UI 层级 | 保存到忽略的 `data/` | 允许 |
| 热搜、推荐、公开笔记和评论 | 确定性只读采集 | 允许 |
| 中文输入 | 已验收 API → 批准的 Unicode 输入法 → 人工粘贴 | 逐机批准 |
| APK、文件、DPI、分辨率、系统状态 | ADB 逐机执行并记录回滚信息 | 会话级确认 |
| 点赞、收藏、关注、评论、私信、发布、删除 | 只在效卫单机画面由人工完成 | 自动执行永久禁止 |
| 云手机 | 仅预留 provider 接口 | v1 不接入 |

## 通用矩阵动作

只读盘点和诊断：

```powershell
.\xhs.cmd device list
.\xhs.cmd device ui --machine 04
.\xhs.cmd device screen --machine 04
```

设备本地变更必须带本次人工确认、理由和回滚信息，例如熄屏：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/Invoke-MatrixAction.ps1 `
  -Action ScreenOff -Group all -ConfirmAction `
  -ConfirmationReason "用户确认本次将该分组设备熄屏" `
  -RollbackInfo "使用 ScreenOn 恢复屏幕"
```

确认开关不能解除外部互动禁令。`TapText` 只允许一台明确设备，不接受分组或多台目标；对点赞、收藏、关注、评论、发送、私信、分享、发布、删除、登录、验证和支付等控件始终拒绝，也不能点击上下文不明的“确定”“完成”等通用确认文字。

## 人工最终操作

人工审核队列选中候选后：

1. 在效卫中切换为一台手机；
2. 明确关闭群控同步、键鼠同步和批量输入；
3. 让脚本只导航到对应笔记并暂停；
4. 人工核对账号、笔记和页面；
5. 人工决定并完成操作。

确认单机画面和同步关闭后，可以让脚本完成只读精确导航：

```powershell
.\xhs.cmd handoff review `
  --task data/my-research-task.json `
  --candidate <candidateId> `
  --machine 04 `
  --confirm-single-device-and-sync-off
```

脚本要求机器编号只映射到一台在线设备，并且该设备属于任务分组。它只接受本地产物中的候选，必须在新搜索结果中精确匹配唯一卡片，并在打开后再次验证笔记 ID 或标题；任何歧义都停止。

评论辅助 Agent 只能在人工主动请求后给出一条草稿。草稿不得自动粘贴、填写或发送。

## 失败和降级

- 语义目标连续两次找不到时，停止该设备并保存截图/UI 层级路径。
- 两台设备出现相同页面或选择器失败签名时，全局熔断，不继续扩散。
- API 探测或动作失败时降级到 ADB，不通过桌面固定坐标补偿。
- 登录、验证码、风险、支付、私信和权限挑战立即转人工。
- 小红书版本变化时，旧的设备覆盖规则自动失效；重新标定前只使用公共语义规则。
- API 即使返回成功，也要用新的 UI 层级验证目标状态。

OTG、Wi-Fi、无障碍授权和云服务开通仍由设备所有者在效卫或手机上完成。项目不自动开启高敏感权限，也不处理登录验证。
