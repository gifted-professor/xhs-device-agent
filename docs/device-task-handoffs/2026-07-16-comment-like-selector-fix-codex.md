# 评论点赞 selector 修复交接

## 基本信息

- 日期：2026-07-16
- 执行者：Codex
- 状态：已完成，存在已记录限制与现场副作用
- 任务范围：扩展通用节点 selector，并验证评论点赞路径

## 设备分配

- 分配依据：当次协作中已有明确临时安排，Hermes 使用 02 号机，Codex 使用 04 号机。
- 实际操作：仅对 04 号机执行定向操作；未对 02 号机执行定向操作。
- 分配性质：仅对该任务有效，不构成项目默认设备，也不得被后续任务继承。
- 当前占用：任务已结束，Codex 不再占用任何设备。

## 实现与文件范围

- `scripts/device-node-engine.mjs`：selector 新增 `text`、`contentDesc`、`className`、`resourceId`、`clickable`、`nearText`、`nearTextPosition`；继续禁止调用方 `bounds`。
- `scripts/xiaowei-device-read.mjs`：支持计数子节点映射到当前可点击祖先，并允许本地 OCR 不可用时由新鲜 UI 独立验证后态。
- `tests/device-node-engine.test.mjs`：覆盖封闭属性 selector、关系字段和非法输入拒绝。
- `tests/xiaowei-device-read.test.mjs`：覆盖关系定位、歧义失败关闭、计数子节点到可点击祖先以及无 OCR 计数递增验证。
- `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md`、`config/device-control-playbook.json`：同步通用策略说明。
- `docs/XHS_CAPABILITY_ROADMAP.md`：评论点赞更新为已验证，并保留适用边界。
- `config/device-control-incidents.json`：DCI-0022、DCI-0023 合并更新为 `verified`。

## 现场验证

- 在 04 号机通过隔离的命名 HTTP 网关完成 `device.node.resolve` 到 `device.node.activate`。
- selector 从两份新鲜无障碍观察中解析唯一目标；激活只发送一次事件，并由新鲜计数递增确认后态。
- 当次完整测试为 482/482 通过；事件簿校验和项目策略扫描通过。
- 证据等级：DCI-0022、DCI-0023 均为 `live_verified`。

## 共享服务

- 常驻 17891 网关未重启、未替换，当时保持健康。
- 新代码使用临时 17892 网关隔离验收；验收后该临时进程已停止，端口已释放。
- 交接时常驻 17891 仍运行旧的内存代码，需要在其他任务结束后的正常维护窗口重载，才会启用新 selector。
- 本任务没有遗留进程或临时端口。

## 现场状态变化

- 修正 selector 后，成功点赞两条测试评论。
- 首次按另一版本页面结构假设图标类型时，04 号机实际命中负反馈图标并隐藏一条评论；发现后没有重放该动作。
- 为避免继续改变账号和评论状态，没有执行额外回滚。接手者不得假设测试前的评论列表和点赞状态仍然存在。

## 仍未解决或有限制

- 独立 `LOCAL_ICON_NODE` 仍未实现。
- 零计数或重复计数场景仍可能需要 `className`、`nearText` 或方向关系进一步消歧。
- 不同 App 版本可能把心形、计数容器和负反馈图标暴露为不同节点类型，必须依据当前机器的新鲜层级解析，不能复用本次结构假设。

## 事件状态

- 新增事件：无。
- 新增缓解：无。
- 已验证：DCI-0022、DCI-0023。
- 仍开放：本地图标节点能力，以及零计数或重复计数的通用消歧边界。

本文件只保存跨智能体交接事实，不代替事件簿、回归测试或实时设备状态。
