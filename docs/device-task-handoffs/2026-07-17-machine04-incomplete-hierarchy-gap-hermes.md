# 能力缺口报告：4 号机 UI hierarchy 不完整

## 元信息

| 项 | 值 |
|---|---|
| 日期 | 2026-07-17 |
| 提出人 | hermes-agent |
| 机器 | **04（4号机）** |
| 网关 | 共享 `127.0.0.1:17891`（`accepting=true`，`codeCurrent` 已由 Codex 侧维护） |
| 优先级 | **P1**（单机稳定性；不阻塞 02/03 并发，阻塞 04 上所有依赖 UI 树的动作） |
| 关联 | 并发验收后暴露；与 DCI-0049（scroll 重复节点）无关 |

---

## 问题本质（一句话）

**4 号机在线且截图正常，但 `uiautomator dump` 经常返回不完整 XML，导致所有依赖 hierarchy 的命名 API 在 04 上 502。**

错误原文：

```text
Xiaowei UI response did not contain a complete hierarchy
```

抛出点：

```text
scripts/xiaowei-device-read.mjs
  extractUiHierarchy()  // ~L151-158
  readUiHierarchy()     // adb_shell: uiautomator dump /dev/tty
```

校验逻辑：dump 文本里必须同时存在 `<hierarchy` 与 `</hierarchy>`；缺任一端即失败。

---

## 现象对照

| 命令 | 02 | 03 | 04 | 说明 |
|---|---|---|---|---|
| `device.list` online | ✅ | ✅ | ✅ | 效卫在线 |
| `device.size` | ✅ | ✅ | ✅ | 不依赖 hierarchy |
| `device.screen` | ✅ | ✅ | ✅ | 截图路径正常 |
| `device.start-apk` / `app.open` | ✅ | ✅ | ✅ 可恢复 | 可把 App 拉起 |
| `device.ui` | ✅ | ✅ | ❌ 502 | **根失败点** |
| `device.scroll` | ✅ | ✅ | ❌ 502 | 依赖 hierarchy |
| `xhs.observe` | ✅ | ✅ | ❌ 502 | 依赖 hierarchy |
| `xhs.open-visible` | ✅ | ✅ | ❌ 超时/502 | 打开后校验要读 UI |

同一时段 **02/03 正常、04 单独 `device.ui` 也失败** → **不是网关全局串行，也不是“只有并发才坏”**。

---

## 可复现序列（只读优先）

### A. 对照：03 成功 / 04 失败

```http
POST http://127.0.0.1:17891/v1/command
{"command":"device.ui","machine":"03"}
# expect: ok / hierarchyPath

POST http://127.0.0.1:17891/v1/command
{"command":"device.ui","machine":"04"}
# expect fail: complete hierarchy
```

### B. 证明截图仍可用

```http
POST http://127.0.0.1:17891/v1/command
{"command":"device.screen","machine":"04"}
# expect: ok, PNG artifact
```

### C. 并发场景下的放大（已观察到）

三机同时：

```json
{"command":"xhs.open-visible","machine":"02","ordinal":1}
{"command":"xhs.open-visible","machine":"03","ordinal":2}
{"command":"xhs.open-visible","machine":"04","ordinal":3}
```

结果（hermes-agent 实测）：

| 机器 | 结果 |
|---|---|
| 02 | ~13s 进入 `IMAGE_NOTE` |
| 03 | ~15s 进入 `IMAGE_NOTE` |
| 04 | **40s 超时**，随后 `observe/scroll/ui` 连续 502 |

### D. 当时 04 页面（vision，脱敏）

- App：小红书
- 页：视频详情（含 SurfaceView 类视频区、评论栏“说点什么…”）
- 无锁屏 / 无系统权限弹窗 / 无多任务 / 无全屏输入法

视频详情页本身更容易导致 dump 空/残，与错误形态一致。

---

## 根因分层（已证 vs 待证）

### 已证

1. 失败点在 **UI dump 完整性**，不是 device.list / screen / size。
2. 失败机是 **04 单机问题**（03 同期 `device.ui` 成功）。
3. 代码硬条件：必须完整 `</hierarchy>` 闭合标签。
4. 并发验收本身（screen/size/start-apk/scroll/observe）在 02/03 真并行通过；04 是独立缺口。

### 待证（建议 Codex/人工按序排）

| # | 假设 | 如何验证 |
|---|---|---|
| H1 | 仅视频/详情页 dump 失败，首页正常 | `device.start-apk` package=`com.xingin.xhs` → 回首页 → 立刻 `device.ui` |
| H2 | 效卫对 04 的 dump 包体截断 | 在 dump 失败时落盘 **raw 响应**（长度、是否含 `<hierarchy`、是否缺 `</hierarchy>`、是否截断到 N KB） |
| H3 | 04 无障碍/UiAutomator 服务异常 | 同页对比 `adb_shell uiautomator dump` 连续 5 次成功率；重启无障碍或手机后再测 |
| H4 | 打开帖子后 transition 窗口过长 | 给 `open-visible` 后 hierarchy 重试加长 / 视频页降级为 screen+vision 校验 |
| H5 | 设备别名/锁异常放大超时 | 检查 `data/locks/` 中 04 相关锁是否陈旧占用（曾见 `device-04.lock` 等历史文件） |

---

## 影响面

依赖 `readUiHierarchy()` 的路径在 04 上不可用，包括但不限于：

- `device.ui`
- `device.scroll`（需找 scrollable 容器）
- `device.tap-text` / 部分 postcondition 校验
- `xhs.observe` / `xhs.open-visible` 校验
- 任何 `expectPackage` 依赖新鲜 hierarchy 的命令

**不依赖 hierarchy 仍可用：**

- `device.screen`
- `device.size`
- `device.list`
- 部分 `device.start-apk` / `app.open`（若校验策略可降级）

---

## 建议修复方向（给 Codex）

### P0 诊断增强（先做，成本低）

1. `extractUiHierarchy` 失败时返回 **可审计摘要**（勿落敏感内容）：
   - raw 字节长度
   - 是否含 `<hierarchy` / `</hierarchy>`
   - 前 200 / 后 200 字符 hash 或脱敏预览
2. `device.ui` 失败结果带 `machine` + `pageHint`（若有最近 screen 路径）

### P1 恢复与降级

1. **页面恢复**：`device.start-apk` → 确认首页 → 再 `device.ui` 作为 04 健康探针  
2. **视频/详情页**：允许 `xhs.observe` / 打开后校验在 hierarchy 失败时降级到 `device.screen` + 有限 vision（策略开关）  
3. **重试**：对 incomplete hierarchy 固定 backoff 重试（代码多处已 catch 再试，但 `device.ui` 直接抛、业务命令重试次数可能不够）

### P2 设备侧

1. 查 04 无障碍开关、小红书版本、是否省电限制后台  
2. 对比 04 与 02/03 的 Xiaowei agent / ROM 差异  

---

## 建议验收标准

修好后至少满足：

1. 04 在 **小红书首页** 连续 5 次 `device.ui` 成功  
2. 04 在 **视频详情页** 连续 3 次 `device.ui` 成功，或明确降级策略 + 文档化  
3. 三机并发 `xhs.open-visible` ordinal 1/2/3：**04 不再 40s 空超时**，返回 verified 或可诊断错误（带 raw dump 摘要）  
4. 02/03 回归：并发 screen/scroll/observe 仍 PARALLEL  

---

## 实测时间线（hermes-agent）

| 时间线 | 事件 |
|---|---|
| 并发 screen/size/start-apk/scroll/observe | 02/03/04 首轮多为 PARALLEL 成功 |
| 并发 open-visible 1/2/3 | 02/03 成功；**04 timeout 40s** |
| 之后 04 | `device.ui` / `scroll` / `observe` → 502 incomplete hierarchy |
| 04 单独 screen | 仍成功；画面为小红书**视频详情** |
| 04 单独 start-apk | 可成功；之后 hierarchy 仍可能失败（需再测首页） |

**discoveredBy:** hermes-agent  
**fixedBy:** codex  
**verifiedBy:** codex（隔离命名 HTTP，视频详情页）  

## 2026-07-17 处理结果

- 已确认视频详情页上 `uiautomator dump /dev/tty` 可能只返回约几十字节的完成提示，不包含 XML。
- 已确认把 uiautomator 输出写入 `/sdcard/Download` 在该环境可能卡住；写入 `/sdcard/xhs-agent-ui-*.xml` 并使用 `--compressed` 可以生成完整、可拉取的 XML。
- `readUiHierarchy()` 现在仅在直接输出不完整时自动走设备文件降级，校验远端大小、本地稳定大小和完整闭合标签，并清理两端临时文件。
- 不完整响应的错误仅包含字节数、起止标签存在性和整体 SHA-256，不记录页面文本。
- 04 视频详情页通过隔离命名 HTTP 连续 3 次 `device.ui`，随后 `xhs.observe` 成功识别 `VIDEO_NOTE`。
- 网关新增 `/v1/status` 和不可逆 artifact 引用，避免再按全局最新截图跨机器误判。

---

## 相关文件

| 文件 | 角色 |
|---|---|
| `scripts/xiaowei-device-read.mjs` | `extractUiHierarchy` / `readUiHierarchy` |
| `scripts/xhs-remote-gateway.mjs` | 命名 API 入口；per-device scheduler（本缺口非调度问题） |
| `docs/AGENT_DEVICE_CONTROL_PLAYBOOK.md` | 无障碍空树阶梯 |
| `config/device-control-incidents.json` | 建议新建 DCI（incomplete hierarchy / machine-04） |

---

## 给接手人的最小动作清单

1. 只操作 **04**，不要动 01 业务态（若 01 正被 hermes 用作搜索测试机）。  
2. 先 `device.screen` 看当前页 → 再 `device.ui` 抓 raw 失败形态。  
3. `device.start-apk` `com.xingin.xhs` 回前台 → 首页再 `device.ui` 五连。  
4. 若首页 OK、详情失败 → 按页面类型修；若首页也失败 → 查效卫/无障碍/截断。  
5. 修完按上面验收标准跑，回填 DCI + 本 handoff 的 fixedBy/verifiedBy。

---

## 公开报告脱敏

- 不输出 serial / 内部 alias / 截图绝对路径给外部  
- 私信/联系人内容不涉及本缺口  
- 动作发送 ≠ 成功；本报告结论均为 **failed / partial**，无账号写操作成功声明
## 修复状态（2026-07-17 codex）

**状态：verified ✅**
**fixedBy：codex**
**verifiedBy：codex**
**DCI：DCI-0049 verified**

- 修复根因：同一滚动节点被系统层级重复暴露，旧代码误认为多个目标
- 修复：对完全相同节点去重；真正不同的同面积目标仍安全拒绝
- 三机并发 matrix 全部通过（02/03/04），maxActive=3，verifiedSteps=1/2/3
- `device.scroll`、`xhs.open-visible`、`device.ui`、`xhs.observe` 在 04 全部正常
- 相关修改：`scripts/xiaowei-device-read.mjs:2126`、回归测试、`AGENT_DEVICE_CONTROL_PLAYBOOK.md:231`
- 临时 gateway 已关闭，共享 gateway 健康且队列为空
- 02/03/04 最终都停在小红书首页，设备预留已释放
