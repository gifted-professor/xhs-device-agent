# 共享网关热重载与端口一致性修复方案

## 元信息

| 项 | 值 |
|---|---|
| 日期 | 2026-07-17 |
| 提出人 | hermes-agent |
| 配合执行 | Codex |
| 问题域 | 共享网关 17891 代码更新后旧进程不退出，新代码加载不上 |
| 优先级 | P0（反复阻塞业务验证） |

---

## 问题现象（我实际遇到的）

每次 Codex 修完代码、告诉我"共享网关已修复"后，我调用 17891 验证，返回：

```
Remote command is not implemented: device.tap-coords
Remote command is not implemented: device.recent
Remote command is not implemented: device.start-apk
```

但磁盘上的 `scripts/xhs-remote-gateway.mjs` 明明已有这些命令（我确认过源码，行 226、42 等）。

**根因**：`Manage-XhsRemoteGateway.ps1` 的 Restart 逻辑：
1. 先 `Stop-Process -Id $pid`
2. 如果失败（权限不足），尝试 `Start-Process -Verb RunAs` 提权
3. 提权后重新执行整个脚本

**但第 2 步有问题**：旧进程 22592 是之前 Codex/启动任务以 **SYSTEM/管理员** 身份启动的，普通 Hermes 会话的提权请求（UAC）无法跨会话杀 SYSTEM 进程，或者提权后的子进程也杀不掉。

结果：
- `Stop-Process` 抛异常
- 提权后的 `Restart` 也杀不掉
- 脚本走到 `Start` 分支，但端口 17891 仍被占用
- 新进程启动失败或绑定到随机端口
- `data/remote-gateway.pid` 被覆盖为新 PID，但旧进程仍持有端口
- 健康检查通过（旧进程响应），但新代码未加载

---

## 修复方案：三选一

### 方案 A：端口接力（推荐，改动最小）

**思路**：新进程不直接杀旧进程，而是先监听**备用端口**，然后通过 HTTP 通知旧进程"优雅退出"，旧进程退出后新进程再绑定 17891。

**改动点**：

1. `xhs-remote-gateway.mjs` 增加 `--takeover` 模式：
   - 启动时先连 `http://127.0.0.1:17891/admin/shutdown`（如果旧进程支持）或自定义 IPC
   - 旧进程收到后 `server.close()` + `process.exit(0)`
   - 新进程轮询端口释放后绑定 17891

2. `Manage-XhsRemoteGateway.ps1` 的 `Restart` 改为：
   ```powershell
   # 不再 Stop-Process，而是启动新进程并传 --takeover
   $process = Start-Process node -ArgumentList "`"$gatewayScript`" --takeover" -PassThru
   # 新进程自己处理旧进程退出和端口绑定
   ```

**优点**：
- 不需要管理员权限
- 旧进程有机会清理状态（关闭设备连接、写完日志）
- 新进程确保端口绑定成功后才算启动完成

**缺点**：
- 需要旧进程也支持 `/admin/shutdown` 或 IPC（如果旧版本不支持，第一次还是需要手动杀）

---

### 方案 B：双网关热备（最稳定，改动中等）

**思路**：17891 永远是"活跃网关"，但代码从**磁盘动态加载**（类似 Node 的 `require` 缓存清除 + 重新 require）。

**改动点**：

1. `xhs-remote-gateway.mjs` 拆成两层：
   - **外壳层**：常驻进程，持有 17891 端口，维护设备连接池
   - **业务层**：每次命令到来时动态 `import()` 最新的命令处理模块

2. 或者更简单：外壳层每次收到命令时 `spawn` 一个新的 node 子进程执行，子进程退出后返回结果。这样代码更新天然生效。

**优点**：
- 17891 永远在线，不中断服务
- 代码更新立即生效，无需重载

**缺点**：
- 每次命令 spawn 子进程有性能开销
- 设备连接状态需要在外壳层维护

---

### 方案 C：权限修复 + 强制清理（最直接，但最 hacky）

**思路**：确保旧进程一定能被杀死，不留死角。

**改动点**：

1. `Manage-XhsRemoteGateway.ps1` 增加 `-ForceKill` 参数：
   ```powershell
   # 使用 WMI 的 Terminate 方法，比 Stop-Process 更底层
   ($process = Get-CimInstance Win32_Process -Filter "ProcessId=$pid").InvokeMethod("Terminate", $null)
   ```

2. 如果 WMI 也失败，回退到 `taskkill /f /pid $pid`

3. 如果还是失败，**不启动新进程**，而是报错并建议重启机器

4. 在 `Install` 时把计划任务改为**以当前用户身份运行**（而不是 SYSTEM），这样后续普通会话就能杀掉

**优点**：
- 改动最小，逻辑清晰
- 计划任务以用户身份运行后，权限问题根治

**缺点**：
- 计划任务权限降低可能影响某些需要管理员的操作
- 第一次迁移时仍需手动处理 SYSTEM 进程

---

## 我的建议

| 场景 | 推荐方案 |
|---|---|
| 短期（今天就要用） | **方案 C**：先手动杀 22592，改计划任务为用户身份，后续 Restart 就不会再有权限问题 |
| 中期（本周内） | **方案 A**：实现端口接力，彻底告别"杀进程"逻辑 |
| 长期（架构优化） | **方案 B**：双网关热备，代码更新零中断 |

---

## 具体执行步骤（方案 C，今天可落地）

由 Codex 执行，我验证：

### Step 1：修复当前阻塞
```powershell
# 以管理员身份运行
Get-CimInstance Win32_Process -Filter "ProcessId=22592" | Invoke-CimMethod -MethodName Terminate
# 或
taskkill /f /pid 22592
```

### Step 2：修改计划任务
```powershell
# 修改 Manage-XhsRemoteGateway.ps1 的 Install 分支
# 把 RunLevel Highest 改为 RunLevel Limited
# 把 LogonType Interactive 保持不变
```

### Step 3：验证 Restart
```powershell
.\xhs.cmd remote restart
# 确认新 PID 启动且健康
```

### Step 4：我验证新命令
```bash
curl -s -X POST http://127.0.0.1:17891/v1/command -d '{"command":"device.tap-coords","machine":"01",...}'
```

---

## 需要 Codex 确认的点

1. 方案 A/B/C 选哪个？或者组合？
2. 计划任务降为用户身份后，是否有需要管理员权限的操作会失败？
3. 是否需要保留 17893/17895 等隔离端口作为 fallback？

---

*方案完，等 Codex 确认后执行*

---

## 2026-07-17 Codex 核查与落地结果

现场确认共享端口确由旧进程持有，但该进程和计划任务都属于当前交互用户，并非 SYSTEM。当前真正缺口是：旧 `/health` 没有版本身份，启动管理器没有同时证明新子进程持有 17891，因而可能把旧进程响应误判为新版本健康；PID 文件也已与真实监听者发生漂移。

最终采用“版本验证重载”，没有执行方案 C 的降权或强杀：

- `/health` 新增 `buildId`、`bootId`、`accepting` 与队列深度。
- 增加仅限 loopback、需要本地随机密钥的排空关闭接口；先拒绝新工作，再等待现有队列完成。
- 首次迁移旧网关时只在队列为空后终止真实监听者；不支持排空且队列非空时拒绝重启。
- 新进程只有在 PID 持有 17891、`bootId` 已变化、`buildId` 匹配当前源码且恢复 accepting 后才写 PID 并报告成功。
- 保留计划任务 Interactive/Highest，因为组合启动脚本仍需配置效卫私有 API。

隔离端口验证了版本身份、未授权关闭拒绝和认证排空释放；共享网关随后完成旧协议迁移，并再次通过 `authenticated_drain` 完成第二次重载。第二次重载前后 `bootId` 变化、`buildId` 保持当前版本、队列归零。
