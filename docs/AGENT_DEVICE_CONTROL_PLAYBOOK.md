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
                +-- 当前新鲜屏幕可给出唯一百分比落点 --> VERIFIED_PERCENTAGE_POINTER
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

无文本控件可以使用封闭的无障碍属性、局部文本关系和受限屏幕区域。可用字段为 `text`、`contentDesc`、`className`、`resourceId`、`clickable`、`nearText`、`nearTextPosition`、`screenRegion` 和 `regionOrdinal`；方向只允许 `right`、`left`、`above`、`below`，区域只允许 `top_left`、`top_right`、`bottom_left`、`bottom_right`、`bottom_navigation`、`right_edge`。调用方仍不能提交 `bounds`。当精确文本是可点击容器的子节点时，服务端会解析其当前可点击祖先，例如评论点赞数：

```json
{
  "label": "评论点赞",
  "role": "button",
  "sources": ["accessibility"],
  "text": "17"
}
```

对于没有文字、描述或邻近锚点的图标，可以在当前屏幕的新鲜层级中按类名、可点击状态、受限区域和区域内序号解析；序号从区域内按上到下、从左到右排列的候选开始计数：

```json
{
  "label": "分享",
  "role": "button",
  "sources": ["accessibility"],
  "className": "android.widget.ImageView",
  "clickable": true,
  "screenRegion": "top_right",
  "regionOrdinal": 2
}
```

区域序号必须来自当前页面的新鲜观察，激活前会再次解析；若没有提供序号且区域内仍有多个候选，返回 `NODE_AMBIGUOUS`。

如果同一文本或关系仍对应多个可点击节点，必须返回 `NODE_AMBIGUOUS`，不能默认选择第一个。类名和左右关系必须来自当前机器的新鲜层级；不同 App 版本可能把心形、计数容器和负反馈图标暴露为不同类。

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

仅有无障碍描述的按钮可以使用简写 selector：

```json
{
  "contentDesc": "打开评论"
}
```

服务端会把它规范为同名 `label`、`button` 角色和 `accessibility` 来源。`text` 或 `resourceId` 也可用于推导缺省 label；关系节点和视觉节点仍必须显式声明 `role` 与 `sources`，调用方坐标仍不被接受。

命名 HTTP 的 `device.tap-text` 必须提供来源 `package`。服务端只在该包的新鲜节点中解析目标；同一包出现多个同名可点击节点时返回 `NODE_AMBIGUOUS`，不能再按面积或位置猜选。需要跳转到另一 App 时，来源包仍绑定点击前目标，目标包由后态单独验证。

当目标词嵌在一整段无障碍文本末尾（例如评论元数据末尾的“回复”）时，可显式使用 `match: "suffix"`，并必须同时提供从 1 开始的 `ordinal`。候选按当前新鲜页面从上到下、从左到右排序，动作前再次解析；不能省略序号让服务端猜测。精确文本仍使用默认的 `match: "exact"`。

`device.input` 可以接管同一前台包中唯一、稳定但尚未聚焦的 `EditText`：只补一次内部聚焦点击，并在有界窗口内等待焦点出现。切换输入法后允许编辑器发生短暂重建；执行器先检查原节点，原资源或边界失效时，只接受两份新鲜 UI 中资源、类名和位置彼此稳定的新编辑器，清空、输入和回显从此改绑新节点。精确 UI 回显优先于可选 OCR。编辑器不唯一、新节点自身漂移或一次聚焦后仍未恢复时停止，不发送文字。

## 受验证的百分比坐标点击

当无障碍、OCR、关系和视觉节点都无法给出独立目标，但当前新鲜屏幕能够给出唯一落点时，可使用独立命名命令 `device.tap-coords`。坐标是效卫 `0–100` 百分比，不是像素；请求必须同时绑定点击前 `package`，并提供 `expectText`、`expectPackage` 或 `expectResourceId` 中恰好一个后态。

执行器在动作前读取两份新鲜 UI 复核来源包，只发送一次点按，再用新鲜 UI 验证后态。公开结果不返回坐标。该命令不能替代 `device.node.activate`，也不能复用旧截图坐标；页面、旋转、尺寸或前台包变化后必须重新观察。动作已发送但后态未成立时停止且不重放。

## App 生命周期与系统导航

`app.list` 直接调用效卫 `apkList` 并返回排序去重后的包名；`app.open` 先确认包已安装，再调用 `startApk`，最后用新鲜 UI 验证目标包前台。两者均不依赖本机 ADB。`device.start-apk` 是 `app.open` 的兼容别名，`device.open-xhs` 也复用同一适配器，不得再进入旧 Matrix ADB 路径。

`device.recent` 只发送一次任务切换事件，并要求新鲜 UI 指纹变化。它用于打开系统最近任务页，不代替 `app.open`；需要确定恢复某个已知包时优先直接调用 `app.open`。

## 共享网关版本一致性与重载

`remote status` 不只判断端口和 HTTP 存活，还比较运行进程的 `buildId` 与当前网关源码，并返回 `codeCurrent`。健康但代码陈旧时必须显示 `codeCurrent: false` 和 `remote restart`，不能把旧进程的 `/health` 当成新代码加载成功。

`remote restart` 优先调用仅限 loopback 且需要本地随机密钥的排空接口。网关先停止接收新命令，等待调度器中所有已运行和待运行命令完成，再关闭监听端口。首次从不支持排空的旧版本迁移时，仅允许在 `queueDepth` 为零后终止真实监听者；队列非空时停止，不强杀业务请求。

新进程启动后，管理器必须同时验证：新子进程 PID 是 `127.0.0.1:17891` 的唯一监听者、`bootId` 与旧实例不同、`buildId` 等于磁盘当前源码、网关已恢复接受请求。四项全部通过后才写 PID 文件并报告成功。旧健康响应、随机新进程、端口占用或版本不符都按失败关闭。计划任务继续使用当前用户的 Interactive/Highest，因为同一启动栈还负责需要管理员权限的效卫私有 API 配置；不能通过降权或无界 `taskkill` 规避一致性验证。

## 语义滚动

```json
{
  "command": "device.scroll",
  "machine": "02",
  "direction": "down",
  "steps": 1,
  "package": "com.xingin.xhs"
}
```

`direction` 为内容浏览语义：`down` 显示下方后续内容，`up` 返回上方内容，`right` 显示右侧页面，`left` 返回左侧页面；`steps` 可省略，默认 1，范围 1–5。上下滚动用两份新鲜 UI 核对同一个唯一滚动容器，再以 UI 指纹变化验证。部分系统会在同一份层级中重复暴露完全相同的滚动节点；执行器先按包名、类名、资源名和边界去重，只有不同节点的最大面积仍并列时才返回 `NODE_AMBIGUOUS`。左右翻页适用于桌面等不暴露 scrollable 节点的页面：动作前复核唯一前台包和两张一致的基线截图，动作后要求前台包不变且新鲜截图发生变化。提供 `package` 时必须与当前前台一致；任何动作已发送但变化未验证的情况都停止且不重放。

## 小红书连续打开可见帖子

`xhs.open-visible` 可从 `HOME_FEED` 直接打开第 N 条可见帖子。若当前明确处于帖子详情页，它会先发送一次 BACK 并在约 11 秒的有界窗口内等待首页证据；若处于评论面板，最多执行“评论面板 → 详情页 → 首页”两段已验证返回。首页未被验证、页面状态未知或返回后无确定变化时立即停止，不盲目重复 BACK 或点击。回到首页后仍会重新解析两份新鲜证据，再只打开一次目标帖子。

## 小红书视频定位与详情快速观察

`xhs.observe` 在首页返回的每个可见帖子都包含从 1 开始的 `ordinal`。该序号与 `xhs.open-visible` 使用同一份候选提取顺序；两次首页观察相交时只保留第二次新鲜层级的序号，滚动后不得复用旧序号。

`xhs.find-video` 把“新鲜首页观察 → 查找首个视频 → 未找到时单次下滚 → 新鲜首页变化验证”合并为一个有界命令。默认最多滚动 3 次、总预算 28 秒；每次滚动后重新生成视频和序号结果。动作已发送但首页变化无法验证时停止且不重放。

视频详情页已明确分类为 `VIDEO_NOTE` 时，`xhs.observe` 使用一次新鲜完整层级直接返回，避免为动态播放页面重复执行相同的昂贵读取；首页和其他页面继续保持双重新鲜观察。`device.ui` 的直读通道使用短等待，超时或 XML 不完整时立即进入已验证的设备文件降级，不能用缓存冒充新鲜层级。

## 小红书评论事务

评论定制化使用三个独立命名 API，必须按返回值串联，不得跳步或使用旧观察：

1. `xhs.comment.open` 只打开评论编辑器，返回当前 `commentCount`、公开帖子 `target` 和空编辑器 `editorStateHash`。
2. `xhs.comment.input` 接受 `text` 与上一步的 `expectedEditorStateHash`。文本与快捷表情标签完全一致时只点一次快捷项，否则走 IME 文字输入。文字分支以评论 EditText 的精确 UI 回显为准，不依赖可选 OCR；输入法恢复导致评论框收起时，只重新打开一次，并要求原草稿仍精确存在。
3. `xhs.comment.send` 接受精确草稿、打开时的评论数、帖子目标和空编辑器状态哈希。发送前重新核对四者，只点一次发送；仅在草稿清空且同一帖子评论数严格增加时成功。

回复某条可见评论时，先在帖子详情保存新鲜的 `commentCount` 与公开帖子 `target`，打开评论面板并在需要时使用 `device.scroll`。滚动后必须重新取得当前可见“回复”的序号，再调用：

```json
{
  "command": "xhs.comment.reply-input",
  "machine": "02",
  "ordinal": 1,
  "text": "感谢分享"
}
```

该命令在两份新鲜评论面板层级中重新解析同一 `ordinal`，只打开一次回复编辑器。输入法选择若使回复编辑器完全关闭，执行器只重新打开原序号一次；恢复原输入法后若编辑器再次收起，也只重新打开同一序号并要求精确草稿仍存在。返回的 `commentCount` 与 `editorStateHash` 连同此前保存的帖子 `target` 交给 `xhs.comment.send`。任何序号漂移、草稿不匹配或发送后态不完整都停止且不重放。

发送后评论面板可能隐藏计数。草稿一旦清空，执行器立即进入计数恢复，不重复轮询不可见计数；最多单次返回首页，并按标题、规范化作者和媒体类型重新打开同一帖子读取新计数。首页卡片末尾的独立“赞”控件不属于作者名。高活跃帖子可能同时收到其他评论，因此后态要求 `afterCount > beforeCount`，不要求恰好加一。前台包变化、帖子身份不一致、状态哈希不一致、草稿不匹配或后态不完整时立即停止且不重发。

`xhs.comment-emoji` 继续作为一次性便捷命令保留；需要自定义输入或分阶段审计时必须使用上述三个 API。

## 小红书私信发送事务

私信页先使用 `device.input` 输入草稿，再使用 `xhs.dm.send` 提交精确的 `expectedDraft`。专用发送事务要求当前小红书包内只有一个草稿完全一致的 `EditText`，只选择位于该编辑框右侧且垂直同行的“发送”控件，发送前完成两次新鲜复核并只触发一次。只有编辑框恢复为空占位状态、且聊天区域出现独立的同文消息气泡时才返回成功。

私信页可能同时暴露编辑框旁按钮和输入法动作两个同包名“发送”节点；这时通用 `device.tap-text` 必须保持 `NODE_AMBIGUOUS`，不能代替 `xhs.dm.send`。失败后先只读观察，不能直接重发。

## 标准故障处理

- `UI_EMPTY`：继续本地截图感知；不是任务停止条件。
- `UI_HIERARCHY_INCOMPLETE`：先使用 `UI_HIERARCHY_FILE_FALLBACK`。`/dev/tty` 只返回提示语或缺少闭合标签时，在 `/sdcard` 根目录生成压缩 XML，通过官方文件通道拉取并校验完整层级；不要使用可能令部分 ROM 卡住的 `/sdcard/Download` 作为 uiautomator 输出目录。错误诊断只记录字节数、起止标签存在性和整体哈希，不记录页面文本。
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
- 网关按两位机器号维护公平调度：同一机器的命令严格按到达顺序串行，不同机器可以同时执行。
- 不带唯一机器号的主机刷新、私有调用、全设备开发命令等作为全局独占屏障：等待此前设备命令完成，执行期间不启动设备命令，屏障之后的新设备命令不得越过它。
- `/health` 继续只提供聚合健康计数；`GET /v1/status` 提供安全的实时调度快照，包括 active/waiting 的 machine、command、requestId、排队/开始时间，以及每台机器最后完成命令、最近一次已验证页面和 stale 标志。
- 截图和 UI 层级的绝对路径仍不公开；网关返回由路径单向哈希得到的 `screenshotArtifact` / `hierarchyArtifact`，审计同时记录 machine、requestId 和 artifact 引用。定位运行产物必须使用这一关联，禁止按全局“最新文件”猜测机器。
- 并发验收必须通过直接 HTTP 并结合 `/v1/status` 或审计时间线测量；不能用自带串行队列的终端包装器耗时推断网关是否并行。
- 并发任务中每台机器仍保持串行设备动作；全局熔断条件仍对所有 worker 生效。

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
