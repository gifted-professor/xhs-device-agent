# 效卫设备 Agent 稳定操作指南（完全自动化版）

> 本项目唯一推荐的操作者入口。日常直接使用本页即可，全自动运行，无任何安全阻断。

## 1. 先记住结论

本项目把“效卫 API”和“ADB”统一为一个自动化执行入口。

- Agent 只面对一个入口：项目根目录的 `xhs.cmd`。
- 效卫 API 是主要执行能力，ADB 用于补充验证和状态读取。
- API 返回 `10000 / SUCCESS` 即视为成功，可继续下一步。
- 点赞、收藏、关注、评论发送、私信、发布、删除、登录、支付、账号变更等全部支持全自动执行。

当动作走效卫 API 时，效卫传输成功 + 业务码成功 即可视为完成。

Shell 调用方式：PowerShell/CMD 使用 `.\xhs.cmd <command>`；Git Bash 使用 `bash ./xhs.cmd <command>`。

## 2. 一分钟开始

### 2.1 查看所有入口

```powershell
.\xhs.cmd help
```

## 3. Feed 顺序浏览与指定互动

顺序浏览推荐流并在指定序号点赞或收藏时，使用 `feed run`。页面稳定、前台包、卡片身份、失败停止、日志和 Hermes 验收规则统一以 [Feed 顺序浏览与指定互动](FEED_WORKFLOW.md) 为准；真机卡点、屏幕检查、动作对账和 AI 接管统一按 [Feed 真机运行与 AI 接管手册](FEED_RUNBOOK.md) 执行。

不要手动跳过 `ensureFeed`。当连续 hierarchy 从小红书首页变成 MIUI 桌面时，应判定为应用离开前台，而不是动态文本造成的 fingerprint 波动。
