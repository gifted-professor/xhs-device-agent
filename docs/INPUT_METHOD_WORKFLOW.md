# 中文输入法与 Hermes 流程

## 结论

中文输入按“逐机、逐输入法、逐动作验收”选择通道，不能按品牌或包名全局推断。优先级为：已验收的效卫 `imeList`/`selectIme`/`inputText` 组合，其次是已标定的原生中文输入法，再次是人工批准的 Unicode 设备输入法，最后由人工在效卫单机画面粘贴。无论走哪条通道，只有目标输入框精确回显、前台包名仍正确且原输入法已恢复，才算成功。

这里的判断是基于当前设备行为，不把某个包名强行解释成所有设备上的“熊猫键盘”。每台设备仍需重新盘点和校准。

## 运行状态机

1. `IME_INVENTORY`：通过已验收的效卫 API 或 ADB 读取已安装输入法、当前默认输入法和语言子类型，只做盘点。
2. `IME_SELECT`：只选择该设备别名明确批准的效卫桥接服务、原生中文输入法或 Unicode 设备输入法；禁止猜测服务名。若效卫桥接已安装但未启用，只有逐机档案明确设置 `AllowTemporaryEnable` 时才可临时启用，并且不能重复发送 `selectIme` 掩盖失败。
3. `IME_CALIBRATE`：在安全的本地可编辑字段中完成一次中文模式校准。若输入法有 `中/英` 开关，按当前设备 UI 完成切换。
4. `IME_VERIFY`：输入固定探针 `测试`，从当前编辑框读取文本并做精确比对；失败时清空探针，不提交搜索或其他页面动作。
5. `TEXT_INPUT`：Hermes 每次输入前确认焦点和目标输入法，输入后立即读取编辑框并校验完整回显。
6. `RESTORE`：任务结束时恢复任务开始前的默认输入法；若桥接由本次任务临时启用，再恢复原启用状态。两项都验证通过后才记录 `restoreVerified=true`。

`adb shell input text` 不作为中文输入路径。它适合 ASCII 诊断，但在当前环境下不能可靠编码中文；中文输入必须走已逐机验收的效卫文本 API、已经校准的原生输入法 UI，或经过批准的 Unicode 输入通道。

当前执行器在原生输入法路径中只注入 ASCII 拼音，并从新鲜 UI 层级中查找与目标短语完全一致的候选节点；找不到完整候选、候选有歧义或最终编辑框回显不一致时都停止。执行器不会用候选栏固定坐标，也不会接受近似词。

部分原生输入法不把候选栏暴露给 UI 层级。对已逐机批准 `AllowVerifiedFirstCandidate` 的档案，执行器可以逐字发送拼音按键并用一次 `SPACE` 提交首候选，但仍以编辑框完整回显作为唯一成功条件；不完全相等时立即清空并停止。这个后备不使用候选坐标，也不能跨设备继承批准状态。

如果输入法连 `中/英` 按键也不暴露给 UI 层级，可在单台设备档案中配置经人工确认的 `ChineseModeToggle`。执行器只有在设备别名、输入法服务、分辨率、密度、键盘可见状态和当前焦点编辑框全部匹配时才会点击；点击后仍必须通过固定探针的精确回显。坐标不得复制到另一台设备，系统或键盘布局变化后必须重新校准。

## Hermes 调度契约

Each approved Xiaowei device profile must explicitly select one exact echo
mode. `ui_text` is used only when that app build exposes the real focused
EditText value. `local_ocr` is used only for a device/build profile proven to
expose a fixed hint instead of the real value. The latter captures a fresh
screenshot, crops it to the current semantic EditText bounds, sends only a
normalized expected-text hash to Windows OCR, and requires two exact matches.
It never uses a full-screen substring match and never returns raw OCR text.

For `local_ocr`, the hierarchy hint cannot prove that clearing succeeded.
The adapter performs bounded deletion in both directions, and the audit keeps
`clearVerified=false` until the final cropped OCR equals the requested value
exactly. A mismatch or unavailable OCR clears the pending field, restores the
prior IME, and stops without submitting search.

Hermes 不需要猜坐标，也不跨设备复用输入法状态。每台设备先生成一个不含真实序列号的档案：

```text
deviceAlias
imeService
chineseSubtype
modeCalibration
defaultImeBeforeRun
lastEchoVerifiedAt
```

调度顺序固定为：

```text
preflight -> selectIme -> calibrateOnce -> focusField -> input -> verifyExactEcho -> restore
```

如果当前通道未安装、未被该别名批准、缺少所需子类型或回显不一致，只能切换到该设备配置中下一个已批准的通道。校准或回显连续失败两次后停止该设备，保留截图和 UI 层级供人工处理，不静默选择未知输入法，也不把一台设备的批准复制给另一台。

## 安全边界

- 校准只使用安全的本地编辑字段，不提交搜索、不点赞、不评论、不关注、不私信、不发布。
- 每台设备独立保存输入法档案、候选服务和校准状态；不得把一台设备的坐标或模式状态复制给另一台。
- 报告只返回设备别名、输入法服务、中文子类型、回显校验结果和失败原因，不输出真实序列号、账号或凭据。
