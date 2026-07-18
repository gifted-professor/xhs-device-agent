# 全流程性能优化交接文档

## 元信息

| 项 | 值 |
|---|---|
| 日期 | 2026-07-17 |
| 提出人 | hermes-agent |
| 配合执行 | Codex |
| 优先级 | P1（能力 OK，性能是当前最大瓶颈） |
| 测试机器 | 01（1号机） |
| 网关 | 共享 17891（codeCurrent=true） |

---

## 问题本质（一句话）

**所有已验证能力都能跑通，但每个操作都要 7-14s，组合起来一个完整流程要 3 分钟。**

---

## 全流程性能基准（01 真机实测）

总耗时 187s，29 步，4 个失败。

### Workflow 1：启动+首页（12s）

| 步骤 | 耗时 | 结果 | 备注 |
|---|---|---|---|
| `device.start-apk` | 4.2s | ✅ | 正常 |
| `xhs.observe` 首页 | 4.0s | ❌ | invalid_structured_read_output |
| `device.ui` 首页 | 4.1s | ✅ | 正常 |

### Workflow 2：搜索用户→进主页→私信（57s）

| 步骤 | 耗时 | 结果 | 备注 |
|---|---|---|---|
| `tap-coords` 搜索图标 (92,6) | 9.0s | ✅ | **慢** |
| `device.input` 搜索词 | 4.4s | ❌ | OCR 不可用 |
| `tap-coords` 搜索按钮 (90,6) | 9.4s | ✅ | **慢** |
| `xhs.observe` 搜索结果 | 4.7s | ❌ | could not classify page |
| `tap-coords` 用户卡片 (20,24) | 9.3s | ✅ | **慢** |
| `xhs.observe` 主页 | 7.0s | ✅ | 正常 |
| `tap-coords` 发私信 (65,47) | 9.7s | ✅ | **慢** |
| `device.input` 私信草稿 | 4.2s | ❌ | editor rebuild |

### Workflow 3：返回首页→打开帖子→互动（53s）

| 步骤 | 耗时 | 结果 | 备注 |
|---|---|---|---|
| `device.back` ×1 | 7.0s | ✅ | **慢** |
| `device.back` ×2 | 6.8s | ✅ | **慢** |
| `device.back` ×3 | 8.3s | ✅ | **慢** |
| `device.start-apk` 回首页 | 4.5s | ✅ | 正常 |
| `xhs.open-visible(1)` | 12.7s | ✅ | **慢** |
| `xhs.observe` 详情 | 6.7s | ✅ | 正常 |
| `device.ui` 详情 | 4.4s | ✅ | 正常 |
| `device.back` 返回 | 6.7s | ✅ | **慢** |

### Workflow 4：消息中心（22s）

| 步骤 | 耗时 | 结果 | 备注 |
|---|---|---|---|
| `tap-text` 消息 | 8.4s | ✅ | **慢** |
| `device.screen` 消息页 | 3.0s | ✅ | 正常 |
| `tap-text` 天才较瘦 | 7.5s | ✅ | **慢** |
| `device.screen` 私信会话 | 3.1s | ✅ | 正常 |

### Workflow 5：视频流程（43s）

| 步骤 | 耗时 | 结果 | 备注 |
|---|---|---|---|
| `device.back` ×3 | ~20s | ✅ | **慢** |
| `device.start-apk` | 4.3s | ✅ | 正常 |
| `xhs.find-video` | 4.3s | ✅ | 正常（Codex 已优化） |
| `xhs.open-visible(3)` | 13.8s | ✅ | **慢** |
| `xhs.observe` 视频详情 | 4.3s | ✅ | 正常 |
| `device.ui` 视频详情 | 4.5s | ✅ | 正常 |
| `device.back` 返回 | 6.6s | ✅ | **慢** |

---

## 性能瓶颈排名

| 排名 | 命令类型 | 单次耗时 | 流程中出现次数 | 总占用 | 占比 |
|---|---|---|---|---|---|
| 1 | `tap-coords` / `tap-text` | 7-10s | 6 次 | ~53s | **28%** |
| 2 | `device.back` | 7-8s | 6 次 | ~43s | **23%** |
| 3 | `xhs.open-visible` | 12-14s | 2 次 | ~27s | **14%** |
| 4 | `xhs.observe` | 4-7s | 4 次 | ~22s | **12%** |
| 5 | `device.start-apk` | 4-5s | 2 次 | ~9s | **5%** |
| 6 | `device.ui` / `device.screen` | 3-4s | 4 次 | ~15s | **8%** |
| 7 | `device.input` | 4s | 2 次 | ~8s | **4%** |
| 8 | `xhs.find-video` | 4.3s | 1 次 | ~4s | **2%** |
| 9 | 其他 | — | — | ~6s | **3%** |
| **合计** | | | **29 步** | **~187s** | |

---

## 优化建议（按优先级）

### P0：`tap-coords` / `tap-text` 从 9s 降到 3s

**当前**：每次点击 9-10s
**目标**：每次点击 <3s
**收益**：省 ~40s/流程（6 次点击）
**占比**：28%

**根因猜测**：
1. 效卫 pointer event 执行本身慢（单次 tap 要几秒）
2. postcondition 验证（检查 UI 变化）耗时长
3. 前台包检查 + 锁获取开销

**验证方法**：
```bash
# 单独测 pointer event 执行时间（不带 postcondition）
curl -X POST http://127.0.0.1:17891/v1/command \
  -H "Content-Type: application/json" \
  -d '{"command":"device.tap-coords","machine":"01","package":"com.xingin.xhs","x":"50","y":"50"}'
```

**优化方向**：
1. 如果是 postcondition 验证慢 → 缩短验证窗口或跳过验证
2. 如果是效卫 pointer event 慢 → 查效卫 API 响应时间
3. 如果是锁/前台检查慢 → 缓存前台包状态

---

### P0：`device.back` 从 7s 降到 2s（或新增 `xhs.go-home`）

**当前**：每次 back 7-8s
**目标**：每次 back <2s，或提供直接回首页命令
**收益**：省 ~30s/流程（4 次 back）
**占比**：23%

**根因猜测**：
1. back event 发送后等待 UI 变化验证
2. 多次 back 要逐层退出（搜索→结果→详情→首页）
3. 每次 back 都要重新读 UI 确认页面变化

**优化方向**：
1. **新增 `xhs.go-home`**：直接回 App 首页，省掉逐层 back
2. **back 验证简化**：只检查前台包，不检查 UI 变化
3. **批量 back**：一次发 3 个 back event，只验证最终状态

---

### P1：`xhs.open-visible` 从 12s 降到 5s

**当前**：12-14s
**目标**：<5s
**收益**：省 ~18s/流程（2 次调用）
**占比**：14%

**当前行为**：点击帖子 → 等待 UI 变化 → 验证详情页 → 返回
**优化方向**：
1. 点击后只验证前台包（不读完整 UI）
2. 异步模式：先返回 accepted，后台验证
3. 缩短 UI 读取等待时间

---

### P1：`xhs.observe` 搜索页分类失败

**当前**：搜索结果页返回 502（could not classify）
**影响**：搜索流程断链，无法确认搜索结果
**类型**：功能修复

**修复方向**：
1. `xhs.observe` 支持搜索结果页分类（`SEARCH_RESULTS` state）
2. 或返回降级结果（部分数据而非 502）

---

### P2：`device.input` 在特定页面失败

**当前**：
- 搜索框：OCR 不可用时失败
- DM 页：编辑器重建失败
- 回复评论：编辑器重建失败

**影响**：输入文字在多个场景断链
**类型**：功能修复

**修复方向**：
1. `device.input` 支持编辑器重建后重新绑定
2. OCR 不可用时降级到 UI hierarchy 验证
3. 回复评论场景的特殊编辑器适配

---

## 预期收益

| 优化项 | 当前 | 优化后 | 省时 |
|---|---|---|---|
| tap-coords/tap-text | 53s | ~18s | **-35s** |
| device.back / go-home | 43s | ~10s | **-33s** |
| xhs.open-visible | 27s | ~10s | **-17s** |
| **总计** | **187s** | **~100s** | **-87s (-47%)** |

如果同时修复功能缺口（observe 分类 + input 编辑器），完整流程可从 187s 降到 **~80s**。

---

## 涉及文件

| 文件 | 优化点 |
|---|---|
| `scripts/xiaowei-device-read.mjs` | `tap-coords` 验证逻辑、`back` 验证逻辑、`open-visible` 验证逻辑 |
| `scripts/xhs-remote-gateway.mjs` | 命令映射、超时配置 |
| `scripts/xhs-agent.mjs` | 命令注册 |
| `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` | 性能优化策略文档 |

---

## 验收标准

### P0 验收
- [ ] `tap-coords` 单次 <3s（01 真机）
- [ ] `device.back` 单次 <2s 或新增 `xhs.go-home` 命令
- [ ] 搜索→主页→私信流程 <60s

### P1 验收
- [ ] `xhs.open-visible` 单次 <5s
- [ ] `xhs.observe` 搜索结果页返回正常（非 502）

### P2 验收
- [ ] `device.input` 在 DM 页/回复编辑器场景成功
- [ ] 完整流程（启动→搜索→主页→私信→返回→打开帖子→互动→消息中心→视频）<100s

### 回归验收
- [ ] 524/524 测试通过
- [ ] 02/03/04 并发仍 PARALLEL
- [ ] DCI-0049 不回归
- [ ] `xhs.find-video` 仍 <5s

---

## 可复现测试脚本

```python
import json, urllib.request, time

URL = "http://127.0.0.1:17891/v1/command"

def post(body, timeout=40):
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
        headers={'Content-Type':'application/json; charset=utf-8'}, method='POST')
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        elapsed = time.time() - t0
        return {'ok': r.status == 200, 'elapsed': elapsed}

def step(name, body):
    r = post(body)
    print(f"{'✅' if r['ok'] else '❌'} {r['elapsed']:5.1f}s | {name}")
    return r

# 单独测 tap-coords（不含 postcondition）
step("tap-coords 无 postcondition", {
    "command":"device.tap-coords","machine":"01",
    "package":"com.xingin.xhs","x":"50","y":"50"
})

# 单独测 device.back
step("device.back", {"command":"device.back","machine":"01"})

# 单独测 xhs.open-visible
step("xhs.open-visible(1)", {"command":"xhs.open-visible","machine":"01","ordinal":1})
```

---

## 公开报告脱敏

- 不输出 serial / 内部 alias / 截图路径
- 私信内容不涉及本报告
- 动作发送 ≠ 成功；本报告结论基于 verified 真机结果
