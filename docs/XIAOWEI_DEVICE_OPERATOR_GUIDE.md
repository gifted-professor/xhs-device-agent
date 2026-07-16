# 效卫设备统一操作指南

## 当前默认入口

Agent 默认调用本机 `http://127.0.0.1:17891/v1/command` 或 Tailnet HTTPS 命名 API。`xhs.cmd` 用于人工调试、兼容流程以及命名 API 尚未覆盖的项目能力。

```powershell
$body = @{ command = "device.list" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:17891/v1/command" -ContentType "application/json; charset=utf-8" -Body $body
```

`adb devices` 为 0 不代表手机不可用。使用新鲜 `device.list`、`device.ui`、`device.screen` 和任务命令判断实际能力。

## 直接任务

用户当前指令已经授权其中明确的机器、App、目标、动作、次数、顺序和并发。普通任务不要求额外 task-id、dry-run、planHash、capability profile 或逐步骤确认。

- 所有已安装且由用户请求的 App 都可通过 `app.open` 或通用导航能力操作。
- 当前 Feed 的可见序号可直接作为目标；先新鲜观察顺序，再绑定并执行。
- 点赞、收藏优先使用可用的命名或原子能力，不强制进入 Feed 模板或统一任务编译器。
- 评论、关注、私信、分享、发布、编辑、删除和账号设置在用户明确请求且已有实现时可执行。
- 目标不唯一或动作后态不明确时，先继续观察和诊断，不把“已经发送”报告为成功。

## 感知阶梯

1. 无障碍文本或资源节点；
2. 精确 OCR；
3. 放大 OCR；
4. 关系节点；
5. 截图和 vision；
6. 项目适配器、开发命令或兼容入口；
7. 将重复缺口实现为新的命名 API。

`device.node.resolve` 只读解析节点；`device.node.activate` 在新鲜证据上重新解析、执行一次并验证后态。坐标、截图路径、serial 和内部 alias 留在服务端。

## 复合任务

`task run`、`feed run`、`feed batch` 和 `research run` 仍可作为大规模、可恢复或兼容工作流。其 dry-run、planHash、能力档案和执行账本是该执行器的技术机制，不是普通命名 API 或原子动作的全局许可条件。

当用户已经明确请求完整任务时，Agent 不应要求用户再次确认完全相同的计划。模板仅补默认值，用户显式参数优先。

## 验证与报告

- 每次 UI 变化后读取新鲜证据。
- 点赞和收藏执行确保状态：已激活为成功 no-op，后态不明确时先检查再决定是否继续。
- 多设备分别观察、解析和验证；其他在线手机不构成阻塞。
- 报告 verified、no-op、partial、failed 或 ambiguous，并说明实际走过的能力路线。
- 会话结束后调用 `skills/record-device-control-learning/SKILL.md` 沉淀通用故障和解决证据。

## 相关文档

- [Agent 设备控制手册](AGENT_DEVICE_CONTROL_PLAYBOOK.md)
- [远程命名 API](TAILSCALE_REMOTE_CONTROL.md)
- [宽松执行与可靠性边界](SAFETY.md)
- [Hermes 执行契约](HERMES_RUN_CONTRACT.md)
