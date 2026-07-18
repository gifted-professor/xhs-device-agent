# 视频详情页完整流程性能优化方案

## 元信息

| 项 | 值 |
|---|---|
| 日期 | 2026-07-17 |
| 提出人 | hermes-agent |
| 配合执行 | Codex |
| 优先级 | P2（能力 OK，性能待优化） |
| 关联 | DCI-0049（04 hierarchy 修复，已 verified） |

---

## 问题本质（一句话）

**功能完整但慢**：从首页滚动找视频 → 打开视频详情 → `device.ui` → 返回首页，总耗时 ~285s（~6min）。

---

## 时间分布（04 真机实测）

| 阶段 | 耗时 | 占比 | 命令 |
|---|---|---|---|
| 滚动找视频 | ~160s | **56%** | `device.scroll` × 8 + `xhs.observe` × 8 |
| `open-visible` 超时 | 35s | 12% | `xhs.open-visible` |
| observe 视频详情 | 33s | 12% | `xhs.observe` |
| `device.ui` 视频详情 | 17s | 6% | `device.ui` |
| 其余 | ~40s | 14% | `start-apk` / `back` / `observe` |
| **总计** | **~285s** | **100%** | |

---

## 可复现 API 序列

### 完整序列（hermes-agent 实测）

```python
# 04 真机，共享网关 17891
import json, urllib.request, time

URL = "http://127.0.0.1:17891/v1/command"

def post(body, timeout=35):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
        headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

# 1. 启动小红书（~5s）
post({"command":"device.start-apk","machine":"04","package":"com.xingin.xhs"})

# 2. 滚动找视频（~160s，8轮×20s/轮）
for i in range(8):
    post({"command":"device.scroll","machine":"04","direction":"down"})  # ~13s
    result = post({"command":"xhs.observe","machine":"04"})              # ~8s
    # result.notes[*].mediaType == "video" 时停止
    # 注意：当前 observe 不返回 ordinal，需用 screenshot 确认

# 3. 打开视频帖（~35s，超时但实际成功）
post({"command":"xhs.open-visible","machine":"04","ordinal":2})

# 4. observe 确认视频详情页（~33s）
post({"command":"xhs.observe","machine":"04"})
# 返回 page.state == "VIDEO_NOTE"

# 5. device.ui 验证（~17s，旧失败点，现已 OK）
post({"command":"device.ui","machine":"04"})

# 6. 返回首页（~28s）
post({"command":"device.back","machine":"04"})
post({"command":"xhs.observe","machine":"04"})
```

### 最小验证序列（只测瓶颈）

```python
# 04 已在首页
post({"command":"device.scroll","machine":"04","direction":"down"})  # ~13s
post({"command":"xhs.observe","machine":"04"})                       # ~8s
# 如果有视频：post({"command":"xhs.open-visible","machine":"04","ordinal":N})
post({"command":"device.ui","machine":"04"})                          # ~17s
post({"command":"device.back","machine":"04"})                        # ~21s
```

---

## 根因分析（按阶段）

### 阶段 1：滚动找视频（160s / 56%）

**当前行为**：
- `device.scroll down` → `xhs.observe` → 检查 `mediaType` → 重复
- 每轮 ~20s，8 轮才找到视频

**问题**：
1. `xhs.observe` 返回的 `notes` 有 `mediaType` 字段，但**没有 `ordinal`**，无法直接用 `open-visible` 打开
2. 没有"跳过图文直达视频"的 API
3. 每轮都要完整 observe（读 UI + 解析），不能只做轻量检查

**涉及代码**：
- `scripts/xiaowei-device-read.mjs` → `xhs.observe` 实现
- `scripts/xhs-remote-gateway.mjs` → 命令映射

**优化方向**：
1. **`xhs.observe` 返回 `ordinal`**：每个 note 带上当前页面的可见序号，省掉截图确认
2. **新增 `xhs.find-video`**：滚动 + 视频检测一体化，返回第一个视频的 ordinal
3. **轻量 observe**：只返回 `mediaType` 列表，不解析全文

### 阶段 2：`open-visible` 超时（35s / 12%）

**当前行为**：
- `xhs.open-visible` 35s 超时，但实际已打开帖子
- 返回 timeout error，但截图确认已在详情页

**问题**：
- 超时阈值太低，视频帖加载比图文慢
- 超时后没有降级策略（不检查是否已进入详情页）

**涉及代码**：
- `scripts/xiaowei-device-read.mjs` → `openVisible` 函数
- `scripts/xhs-remote-gateway.mjs` → `commandTimeoutMs` 配置

**优化方向**：
1. **增加视频帖超时**：视频帖 `open-visible` 超时从 35s 增到 60s
2. **异步模式**：先返回 `accepted`，后台验证是否进入详情页
3. **超时后检查**：超时后检查当前是否已在详情页，如果是则返回 success

### 阶段 3：`observe` 视频详情页（33s / 12%）

**当前行为**：
- 视频详情页 `xhs.observe` 耗时 33s（图文帖 ~8s）

**问题**：
- 视频页 UI dump 比图文慢（SurfaceView/TextureView）
- `uiautomator dump` 在视频页更慢

**涉及代码**：
- `scripts/xiaowei-device-read.mjs` → `readUiHierarchy()` → `adb_shell uiautomator dump /dev/tty`

**优化方向**：
1. **视频页跳过 UI dump**：observe 直接用 screenshot + vision，不读 hierarchy
2. **增量 observe**：如果已在详情页，只更新 metrics，不重读全文
3. **缓存**：同一帖子短时间内重复 observe 直接返回缓存

### 阶段 4：`device.ui` 视频详情页（17s / 6%）

**当前行为**：
- `device.ui` 在 VIDEO_NOTE 页面返回 OK，耗时 17s

**状态**：
- ✅ 功能已 OK（DCI-0049 修复后）
- 17s 可接受，但仍有优化空间

**优化方向**：
1. **视频页 UI dump 缓存**：短时间内重复调用返回缓存
2. **增量更新**：只更新变化的节点

---

## 涉及文件清单

| 文件 | 函数/行号 | 优化点 |
|---|---|---|
| `scripts/xiaowei-device-read.mjs` | `openVisible` 函数 | 超时阈值、异步模式 |
| `scripts/xiaowei-device-read.mjs` | `readUiHierarchy()` L255 | 视频页 dump 优化 |
| `scripts/xiaowei-device-read.mjs` | `extractUiHierarchy()` L151 | 视频页 hierarchy 解析 |
| `scripts/xiaowei-device-read.mjs` | `xhs.observe` 实现 | 返回 ordinal、轻量模式 |
| `scripts/xhs-remote-gateway.mjs` | `commandTimeoutMs` | 视频帖超时配置 |
| `scripts/xhs-remote-gateway.mjs` | 命令映射 | 新增 `xhs.find-video` |
| `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` | 滚动找视频策略 | 文档更新 |

---

## 修复验收标准

### 功能验收（已通过）

- [x] `device.ui` 在 VIDEO_NOTE 页面返回 OK
- [x] `xhs.observe` 在 VIDEO_NOTE 页面返回 `page.state == "VIDEO_NOTE"`
- [x] `device.back` 从视频详情页返回首页

### 性能验收（待优化）

| 指标 | 当前 | 目标 | 验收方法 |
|---|---|---|---|
| 滚动找视频 | 160s（8轮） | <30s（1-2轮） | `xhs.find-video` 或 observe 带 ordinal |
| open-visible 超时率 | ~50% | 0% | 增加超时或异步模式 |
| observe 视频详情 | 33s | <15s | 视频页跳过 UI dump |
| device.ui 视频详情 | 17s | <10s | 缓存或增量更新 |
| **完整流程** | **285s** | **<60s** | 端到端测试 |

### 回归验收

- [ ] 02/03/04 并发 `device.scroll` 仍 PARALLEL
- [ ] 02/03/04 并发 `xhs.observe` 仍 PARALLEL
- [ ] 图文帖 `device.ui` 仍 OK
- [ ] 视频帖 `device.ui` 仍 OK
- [ ] DCI-0049 不回归

---

## 优先级建议

| 优化项 | 难度 | 收益 | 建议优先级 |
|---|---|---|---|
| `xhs.observe` 返回 ordinal | 低 | 高（省掉截图确认） | P0 |
| `open-visible` 超时增加 | 低 | 中（减少超时率） | P0 |
| 新增 `xhs.find-video` | 中 | 高（省掉滚动循环） | P1 |
| 视频页 observe 跳过 UI dump | 中 | 中（减少 33s→8s） | P1 |
| 视频页 UI dump 缓存 | 低 | 低（17s→5s） | P2 |
| 异步 open-visible | 高 | 高（彻底消除等待） | P2 |

---

## 公开报告脱敏

- 不输出 serial / 内部 alias / 截图路径
- 私信内容不涉及本报告
- 动作发送 ≠ 成功；本报告结论基于 verified 真机结果

---

## Codex 完成记录（2026-07-17）

### 已实现

- `xhs.observe.notes[*]` 返回稳定 `ordinal`，并与 `xhs.open-visible` 共用同一候选顺序。
- 两次首页观察相交时保留第二次新鲜层级的序号，滚动后不复用旧序号。
- 新增有界 `xhs.find-video`：默认最多滚动 3 次、总预算 28 秒，每次滚动后重新读取并验证首页变化。
- `VIDEO_NOTE` 的 `xhs.observe` 使用一次新鲜完整层级，首页和其他页面继续双读。
- UI 直读等待缩短为 5 秒；超时或 XML 不完整时立即进入 `/sdcard` 压缩文件拉取降级。
- 网关、统一 CLI、PowerShell 包装器、结构化响应校验和帮助链路均已接入新命令。

### 04 号机隔离实测

| 阶段 | 实测 | 目标 | 结果 |
|---|---:|---:|---|
| `xhs.find-video` | 5.0s | <30s | 通过 |
| `xhs.open-visible` | 14.0s | 超时率 0 | 通过，无超时 |
| 视频详情 `xhs.observe` | 4.4s | <15s | 通过 |
| 视频详情 `device.ui` | 4.7s | <10s | 通过 |
| 返回首页 | 7.0s | — | 通过 |
| 首页复核 | 7.9s | — | 通过 |
| 完整流程 | 约 50.7s | <60s | 通过 |

设备最终状态：04 号机已验证回到 `HOME_FEED`。本次仅导航和只读观察，没有执行点赞、收藏、评论或私信。

### 多机与部署验收

- 02/04 并发 `device.ui` 均返回成功，总耗时约 4.9 秒，证明不同机器仍可并行。
- 03 当时离线，因此没有声称完成 02/03/04 三机真机并发；跨机器并发调度器回归测试已通过。
- 全量测试：524/524。
- 语法检查、仓库策略扫描、事故账本校验均通过。
- 共享 `17891` 已通过 authenticated drain 重载，`codeCurrent=true`。
- 共享接口再次验证 `xhs.find-video` 约 5.7 秒、`device.ui` 约 4.5 秒，状态端点准确记录 04 首页和对应请求。
- 隔离端口 `17904` 已关闭，无临时网关遗留。
