# 评论回复草稿验证失败（01 号机）

## 元信息

| 项 | 值 |
|---|---|
| 日期 | 2026-07-17 |
| 发现人 | hermes-agent |
| 机器 | 01（1号机） |
| 网关 | 17891 共享（codeCurrent=true） |
| 关联 | DCI-0039/DCI-0042（Codex 回复闭环修复） |

---

## 问题本质（一句话）

`xhs.comment.reply-input` 在 01 上完成了 90% 流程（找回复→点→进编辑器→输入文字），但最后一步草稿 echo 验证失败（`POSTCONDITION_MISS`），回复未发送。02/04 通过，01 不通过。

---

## 可复现序列

```python
import json, urllib.request, time

URL = "http://127.0.0.1:17891/v1/command"

def post(body, timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
        headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# 1. 启动小红书
post({"command":"device.start-apk","machine":"01","package":"com.xingin.xhs"})
time.sleep(2)

# 2. 打开帖子
post({"command":"xhs.open-visible","machine":"01","ordinal":1})
time.sleep(2)

# 3. 点评论图标（不开编辑器）
post({"command":"device.tap-coords","machine":"01","package":"com.xingin.xhs",
      "x":"85","y":"93","expectPackage":"com.xingin.xhs"})
time.sleep(2)

# 4. reply-input
j = post({"command":"xhs.comment.reply-input","machine":"01",
          "ordinal":1,"text":"感谢分享！"})
# 期望：status=verified, commentCount 增加
# 实际：502 POSTCONDITION_MISS
```

---

## 01 实测流程

| 步骤 | 结果 | 耗时 |
|---|---|---|
| `device.start-apk` | ✅ | 4s |
| `xhs.open-visible(1)` | ✅ | 12s |
| `tap-coords(85,93)` 评论图标 | ✅ 评论面板打开，无编辑器 | 10s |
| `reply-input` 找「回复」 | ✅ | — |
| `reply-input` 点击「回复」 | ✅ 编辑器打开 | — |
| `reply-input` 输入文字 | ✅ 已发送 | — |
| **`reply-input` 草稿验证** | ❌ POSTCONDITION_MISS | 54s |
| `xhs.comment.send` | ❌ 未到达 | — |

---

## 错误原文

```
[POSTCONDITION_MISS] Comment input was sent once but the exact draft 
was not verified; input will not be replayed
```

---

## 与 02/04 的差异

| 项 | 02/04 | 01 |
|---|---|---|
| 输入法 | 未记录 | 可能不同（MIUI 版本/输入法配置） |
| 编辑器重建行为 | 重建后验证通过 | 重建后验证失败 |
| 最终结果 | 评论数+1 | 回复未发送 |

---

## 根因猜测

1. **输入法差异**：01 的输入法在回复编辑器中切换时，编辑器重建行为和 02/04 不同
2. **编辑器重建次数**：Codex 的修复只重新打开同一序号一次，但 01 可能需要多次
3. **草稿 echo 格式**：01 回复编辑器的 echo 格式（如「回复 @username：」前缀）可能和 02/04 不一致

---

## 优化方向

1. **放松验证**：回复编辑器场景的草稿验证可以从「精确匹配」改为「包含匹配」
2. **多次重试**：编辑器重建后多试几次验证，而不是只试一次
3. **降级策略**：验证失败时返回 `mitigated` 而非 502，让调用方决定是否重试

---

## 验收标准

- [ ] 01 号机 `reply-input` 返回 `status=verified`
- [ ] 01 号机 `xhs.comment.send` 后评论数+1
- [ ] 02/04 回归不退化

---

## 公开报告脱敏

- 不输出 serial / 内部 alias
- 私信内容不涉及本报告
