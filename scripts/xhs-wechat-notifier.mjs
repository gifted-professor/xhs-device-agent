// xhs-wechat-notifier.mjs — WechatNotifier：经 Hermes 微信 channel 做人工确认
//
// 发送：spawn `hermes send --to weixin <提示>`（复用 Hermes gateway 凭据；需 gateway 在跑
//   且 ~/.hermes/config.yaml 的 weixin.enabled=true）。
// 接收：tail -n 0 -f ~/.hermes/logs/gateway.log，过滤发送后来自 home chat 的 inbound 行：
//   `... inbound message: platform=weixin user=<chat> chat=<chat> msg='<文本>' reply_to_id=...`
//   /approve|/ok|/yes → 发送候选；/deny|/no|/skip → 跳过；其它文本 → 当作改写后发送；
//   超时 → 放弃不发。
//
// 设计取舍（用户已确认走这条）：Hermes 没有"发提示后阻塞等回复"的 RPC，外部 node 脚本只能
//   watch gateway.log。MVP 假设 home chat 是专用确认通道（无并发对话）；inbound 同时会进
//   Hermes agent loop 触发 agent 回复，属可接受副作用，本 notifier 只读 log 不干预 agent。
//
// 不做：不在这里启用 weixin channel（改 config.yaml + 重启 gateway 是用户侧操作）。

import os from "node:os";
import path from "node:path";
import { spawn as defaultSpawn } from "node:child_process";

export const DEFAULT_HERMES_CLI = process.env.HERMES_CLI ?? "hermes";
export const DEFAULT_HERMES_LOG = process.env.HERMES_LOG
  ?? path.join(os.homedir(), ".hermes", "logs", "gateway.log");
export const DEFAULT_WEIXIN_HOME_CHAT = process.env.WEIXIN_HOME_CHAT
  ?? "o9cq801CnCRPuRYA4RMKqDTJ0LQI@im.wechat";

// inbound 行：msg 是单引号包裹，行尾跟 ` reply_to_id=`，非贪婪到该锚。
const INBOUND_RE = /inbound message: platform=weixin user=\S+ chat=(\S+) msg='(.*?)' reply_to_id=/u;
const APPROVE_RE = /^\/(?:approve|ok|yes|y|确认|发送)$/iu;
const DENY_RE = /^\/(?:deny|no|n|跳过|取消)$/iu;

export function buildWechatPrompt({ machine, sourceComments, candidate, requestId, timeoutMs }) {
  if (typeof requestId !== "string" || !requestId) throw new Error("buildWechatPrompt requires requestId");
  if (!Array.isArray(sourceComments)) throw new Error("buildWechatPrompt requires sourceComments array");
  const lines = sourceComments
    .map((c, i) => `${i + 1}. ${c.author ?? "网友"}：${c.content ?? ""} (赞${c.likes ?? 0})`)
    .join("\n");
  const sec = Math.max(1, Math.round(timeoutMs / 1000));
  return [
    `评论仿写确认 · 机器${machine ?? "??"} · [${requestId}]`,
    `热门观点：\n${lines}`,
    `仿写候选（≤20字）：${candidate}`,
    `回复 /approve 发送候选 · /deny 跳过 · 或直接回复改写文本（超时 ${sec}s 自动放弃）`,
  ].join("\n");
}

function runHermesSend(prompt, { spawn = defaultSpawn, cli = DEFAULT_HERMES_CLI } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ["send", "--to", "weixin", prompt], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`hermes send exited ${code}: ${stderr.trim() || stdout.trim()}`));
      else resolve(stdout);
    });
  });
}

// tail -n 0 -f logPath，抓发送后第一条来自 home chat 的 weixin inbound msg；超时返 null。
function waitForInbound({ homeChat, timeoutMs, logPath }, { spawn = defaultSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn("tail", ["-n", "0", "-f", logPath], { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let buf = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const m = line.match(INBOUND_RE);
        if (!m) continue;
        if (m[1] !== homeChat) continue; // 只认 home chat，忽略其它对话
        finish(m[2]);
        return;
      }
    });
    child.stderr.on("data", () => { /* tail 无 stderr 关注 */ });
    child.on("error", () => finish(null));
    child.on("close", () => { if (!settled) finish(null); });
  });
}

export function createWechatNotifier({
  homeChat = DEFAULT_WEIXIN_HOME_CHAT,
  logPath = DEFAULT_HERMES_LOG,
  requestIdPrefix = "xhs-imitate",
} = {}) {
  if (typeof homeChat !== "string" || !homeChat) throw new Error("createWechatNotifier requires homeChat");
  let counter = 0;
  return {
    async sendConfirm({ machine, sourceComments, candidate, timeoutMs }, runtime = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("timeoutMs must be >= 1000");
      const requestId = `${requestIdPrefix}-${machine ?? "00"}-${Date.now()}-${counter++}`;
      const prompt = buildWechatPrompt({ machine, sourceComments, candidate, requestId, timeoutMs });
      await runHermesSend(prompt, runtime);
      const msg = await waitForInbound({ homeChat, timeoutMs, logPath }, runtime);
      if (msg === null) return { decision: "skip", text: null, reason: "timeout" };
      const trimmed = msg.trim();
      if (APPROVE_RE.test(trimmed)) return { decision: "send", text: null, reason: "confirmed" };
      if (DENY_RE.test(trimmed)) return { decision: "skip", text: null, reason: "rejected" };
      if (!trimmed) return { decision: "skip", text: null, reason: "empty_reply" };
      return { decision: "send", text: trimmed, reason: "rewritten" };
    },
  };
}