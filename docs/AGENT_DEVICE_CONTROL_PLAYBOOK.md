# Agent 设备控制手册

## 目的

本手册定义 Hermes 或其他 Agent 通过命名 HTTP API 控制一台或多台手机时的固定处理方法。目标不是为单个 App 累积补丁，而是把每次真实失败归类为标准故障，并沿确定性的能力阶梯解决。

Agent 默认调用项目命名 HTTP API。命名能力缺失时，继续使用项目已有的兼容、开发或私有适配入口完成当前任务，同时记录缺口并沉淀新的命名能力。用户当前请求中明确写出的机器、App、目标、动作、次数和顺序就是本次授权，不再追加 dry-run、planHash、白名单、能力档案或逐步确认。

身份绑定、目标唯一性、新鲜证据和动作后态仍需验证。这些验证用于避免点错设备、点错节点或重复发送，不是权限审批；不能把可靠性失败改写成“需要用户再次授权”。

## 总协议

```text
observe -> resolve -> recheck -> execute once -> verify -> record
```

1. `observe`：确认机器身份、前台包、UI 完整性、屏幕尺寸和页面安全性。
2. `resolve`：按能力阶梯解析唯一语义节点，不执行设备操作。
3. `recheck`：在第二份新鲜证据上重新解析相同节点，拒绝页面、包名、布局或目标漂移。
4. `execute once`：只发送一次动作。任何发送边界后的不确定结果都不得重放。
5. `verify`：用新鲜 UI 或本地截图感知验证明确后态；手势发送成功不等于任务成功。
6. `record`：将新故障沉淀为故障码、通用策略、脱敏回归样本和测试，不把某个 App 特判当作最终能力。

## Hermes 固定决策树

```text
device.list / device.size
        |
        v
命名高层观察，或现有 device.ui + device.screen
        |
        +-- 当前请求明确包含的登录、权限、支付确认、私信或状态变化 --> REQUEST_SCOPED_ACTION
        |
        +-- 唯一无障碍节点 --> ACCESSIBILITY_EXACT_NODE
        |
        +-- UI_EMPTY / NODE_NOT_FOUND
                |
                +-- 唯一精确 OCR --> OCR_EXACT_NODE
                |
                +-- OCR_MISS --> OCR_SCALED_EXACT_NODE
                |
                +-- 仍未找到且存在可验证布局关系 --> RELATIONAL_LAYOUT_NODE
                |
                +-- 需要视觉语义定位 --> VISION_NODE
                |
                +-- 本地图标节点已实现 --> LOCAL_ICON_NODE
                |
                +-- 命名能力缺失 --> PROJECT_COMPATIBILITY_ROUTE -> 记录并补命名能力
                |
                +-- 目标仍不唯一、动作结果不确定或确实缺少用户选择 --> HUMAN_REQUIRED
```

机器可读版本位于 `config/device-control-playbook.json`。Agent 可调用：

```json
{
  "command": "device.guide",
  "failureCode": "UI_EMPTY"
}
```

## 通用节点选择器

节点选择器不包含坐标、路径、设备标识、正则表达式或脚本。

精确节点：

```json
{
  "label": "服务",
  "role": "control",
  "sources": ["accessibility", "ocr"]
}
```

受限关系节点：

```json
{
  "label": "我",
  "role": "tab",
  "sources": ["accessibility", "ocr", "relation"],
  "relation": {
    "algorithm": "horizontal_equal_spacing",
    "region": "bottom_navigation",
    "anchors": [
      { "label": "通讯录", "ordinal": 2 },
      { "label": "发现", "ordinal": 3 }
    ],
    "targetOrdinal": 4
  }
}
```

关系节点必须满足：锚点文字分别唯一、锚点序号不同、同一水平行、单位间距一致、目标位于受限区域、两份新鲜证据独立推导结果稳定。调用方不能提交推导结果或坐标。

视觉节点：

```json
{
  "label": "个人页",
  "role": "tab",
  "sources": ["accessibility", "ocr", "vision"],
  "visionPrompt": "底部导航栏中的人形个人页图标"
}
```

`vision` 使用服务端新鲜截图和 OpenAI-compatible 视觉服务。显式的 `VISION_*` / `AI_*` 配置优先；缺失时复用 Hermes `auxiliary.vision` 的模型、基础地址、超时和 `.env` 凭据，基础地址会在服务内部规范为 `/v1/chat/completions`。视觉返回值严格限制为零个、一个或多个像素矩形；零个继续失败处理，多个返回 `NODE_AMBIGUOUS`。单个矩形只用于推导固定大小的内部安全中心标记，第二份新鲜截图必须重新定位到稳定中心；模型外框大小变化不会伪造布局漂移，中心漂移仍会失败关闭。单次上游请求和双观察网关命令都有硬超时。公开 API 只返回语义节点和 source，不返回模型原文、截图路径或内部坐标。

## 节点 API

只读解析：

```json
{
  "command": "device.node.resolve",
  "machine": "03",
  "package": "com.tencent.mm",
  "selector": {
    "label": "我",
    "role": "tab",
    "sources": ["accessibility", "ocr", "relation"],
    "relation": {
      "algorithm": "horizontal_equal_spacing",
      "region": "bottom_navigation",
      "anchors": [
        { "label": "通讯录", "ordinal": 2 },
        { "label": "发现", "ordinal": 3 }
      ],
      "targetOrdinal": 4
    }
  }
}
```

单次激活：

```json
{
  "command": "device.node.activate",
  "machine": "03",
  "package": "com.tencent.mm",
  "selector": { "...": "与解析时相同的封闭选择器" },
  "expectText": "服务",
  "reason": "进入当前微信账户导航页",
  "rollback": "返回微信主界面"
}
```

`device.node.activate` 不信任上一次解析结果。它重新采集两份新鲜证据、重新解析并核对相同节点，然后只发送一次，最后验证 `expectText`。这避免了跨请求节点过期和伪造坐标令牌。

## 标准故障处理

- `UI_EMPTY`：继续本地截图感知；不是任务停止条件。
- `NODE_NOT_FOUND`：按 OCR、放大 OCR、关系节点、视觉节点顺序降级。
- `OCR_MISS`：继续精确放大、受限关系推导或视觉节点定位。
- `OCR_AMBIGUOUS` / `NODE_AMBIGUOUS`：先用独立视觉证据消歧；仍不唯一时才询问目标，不能自动选择第一个结果。
- `LAYOUT_DRIFT` / `FOREGROUND_DRIFT`：重新观察并换独立策略；不能复用旧节点或盲目补点。
- `POSTCONDITION_MISS`：动作若已发送则结果不确定，禁止重放。
- `SENSITIVE_SURFACE`：若当前请求已经明确包含该动作，直接按请求范围执行，不再追加第二次确认；只有缺少会改变结果的真实选择时才询问。
- `IDENTITY_DRIFT`：刷新设备清单并使用项目适配通道重新绑定机器；在绑定唯一前不发送动作。
- `CAPABILITY_MISSING`：自动转入项目现有兼容、开发或私有适配入口完成任务，并把缺口沉淀为新的命名能力。
- `TRANSPORT_FAILED`：保守停止；若无法证明未发送，不得重试动作。

`HUMAN_REQUIRED` 只表示：任务目标本身缺少关键选择，或所有有界通道都已耗尽而必须人工接管。它不能用于要求重复授权、planHash、应用白名单、任务编号或逐步确认。

## 多设备规则

- 每台机器独立观察、解析和验证；分辨率相同也不能共享节点。
- 节点解析绑定当前机器、前台包、页面、分辨率、旋转方向和新鲜证据。
- 一个 worker 失败不能把节点、动作或预算转移给另一台机器。
- 并发任务中每台机器保持串行设备动作；全局熔断条件仍对所有 worker 生效。

## 新问题的沉淀要求

每个新问题完成后必须同时产生：

1. 一个稳定的标准故障码；
2. 一个不依赖 App 名称或固定坐标的通用策略，或明确的 `not_implemented`；
3. 一个不包含真实设备标识和私域内容的回归测试样本；
4. 手册、机器可读目录、API 校验和测试的同步更新。

只有四项齐全，才算形成系统能力。若当前仅通过真实 HTTP 验收完成临时绕行，但缺少通用修复和回归测试，必须记录为 `mitigated`，并在 `resolution` 或 `evidence.tests` 中留下补齐测试的明确路径，方便后续接手者继续推进到 `resolved`/`verified`。

## 会话收尾与故障生命周期

每次设备控制实现、真实操作或重要排障结束前，执行 `skills/record-device-control-learning/SKILL.md`。稳定故障分类和策略继续保存在 `config/device-control-playbook.json`；实际踩坑、复发和解决证据独立保存在 `config/device-control-incidents.json`，不能把会话历史混入运行时策略目录。

事故状态依次区分为：`open`（仍阻塞）、`mitigated`（已有绕行但根因仍在）、`resolved`（通用修复及回归测试通过）、`verified`（再通过命名 HTTP 真实验收）和 `reopened`（已缓解或已解决的问题再次出现）。文档声明、测试总数或另一个 Agent 的判断都不能单独提升状态。
