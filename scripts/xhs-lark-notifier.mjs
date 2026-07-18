// xhs-lark-notifier.mjs — LarkNotifier：飞书交互卡片人工确认
//
// 用 lark-cli 发 Card 2.0 交互卡片（发送/跳过 2 按钮），再通过
// `lark-cli event consume card.action.trigger --as bot`（WebSocket 长连接，无需 webhook）
// 监听按钮回调。按钮身份藏在 behaviors[].value={action,request_id}，回调 action_value
// 原样回传，按 request_id 匹配本次请求。
//
// 前提（开发者后台一次性配置）：
//   - 飞书开发者后台 → 事件与回调 → 回调配置 已开启（否则 consume 收不到任何事件）
//   - bot 已是 chatId 群成员
//
// MVP：发送候选 / 跳过 两按钮 + 超时自动放弃。"改写"需 Card form 输入框，留作后续增强
// （见 lark-im card form reference）；当前 reason="confirmed" 时 text=null，主流程回退到候选原文。

import { spawn as defaultSpawn } from "node:child_process";

export const DEFAULT_LARK_CLI = process.env.LARK_CLI ?? "lark-cli";
const SHA256_RE = /^[a-f0-9]{64}$/u; // 仅用于其它模块复用占位，此处保留以防 import 循环

// 构造 Card 2.0 JSON。导出以便单测。
export function buildConfirmCard({ machine, sourceComments, candidate, requestId, timeoutMs }) {
  if (typeof requestId !== "string" || !requestId) throw new Error("buildConfirmCard requires requestId");
  if (!Array.isArray(sourceComments)) throw new Error("buildConfirmCard requires sourceComments array");
  if (typeof candidate !== "string") throw new Error("buildConfirmCard requires candidate string");
  const commentLines = sourceComments
    .map((c, index) => `${index + 1}. ${c.author ?? "网友"}：${c.content ?? ""}  (赞${c.likes ?? 0}${c.isPinned ? " · 置顶" : ""})`)
    .join("\n");
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));
  return {
    schema: "2.0",
    header: {
      title: { tag: "plain_text", content: `评论仿写确认 · 机器${machine ?? "??"}` },
      template: "green",
    },
    body: [
      {
        tag: "markdown",
        content: `**热门评论观点：**\n${commentLines}\n\n**仿写候选（≤20字）：**\n${candidate}\n\n_超时 ${timeoutSec}s 自动放弃不发_`,
      },
      {
        tag: "column_set",
        flex_mode: "none",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "发送" },
                type: "primary_filled",
                width: "fill",
                behaviors: [{ type: "callback", value: { action: "confirm", request_id: requestId } }],
              },
            ],
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            elements: [
              {
                tag: "button",
                text: { tag: "plain_text", content: "跳过" },
                type: "danger",
                width: "fill",
                behaviors: [{ type: "callback", value: { action: "reject", request_id: requestId } }],
              },
            ],
          },
        ],
      },
    ],
  };
}

function runLarkCli(args, { spawn = defaultSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`lark-cli ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}

// 监听 card.action.trigger，过滤 request_id 匹配的 button 点击，带超时。
// 解析每行 stdout JSON：{action, rid}（jq 已提取）。
function waitForCardAction({ requestId, timeoutMs }, { spawn = defaultSpawn } = {}) {
  return new Promise((resolve) => {
    const jqFilter = 'select(.action_tag == "button") | {action: (.action_value | fromjson?).action, rid: (.action_value | fromjson?).request_id}';
    const child = spawn("lark-cli", ["event", "consume", "card.action.trigger", "--as", "bot", "--jq", jqFilter], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdoutBuf = "";
    const finish = (verdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead */ }
      resolve(verdict);
    };
    const timer = setTimeout(() => finish({ decision: "skip", text: null, reason: "timeout" }), timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // 保留最后不完整行
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt?.rid !== requestId) continue;
        if (evt.action === "confirm") finish({ decision: "send", text: null, reason: "confirmed" });
        else finish({ decision: "skip", text: null, reason: "rejected" });
        return;
      }
    });
    child.stderr.on("data", () => { /* lark-cli 进度日志，忽略 */ });
    child.on("error", () => finish({ decision: "skip", text: null, reason: "listener_error" }));
    child.on("close", () => {
      if (!settled) finish({ decision: "skip", text: null, reason: "listener_closed" });
    });
  });
}

export function createLarkNotifier({ chatId, requestIdPrefix = "xhs-imitate" } = {}) {
  if (typeof chatId !== "string" || !chatId) throw new Error("createLarkNotifier requires chatId");
  let counter = 0;
  return {
    async sendConfirm({ machine, sourceComments, candidate, timeoutMs }, runtime = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) throw new Error("timeoutMs must be >= 1000");
      const requestId = `${requestIdPrefix}-${machine ?? "00"}-${Date.now()}-${counter++}`;
      const card = buildConfirmCard({ machine, sourceComments, candidate, requestId, timeoutMs });
      await runLarkCli(
        ["im", "+messages-send", "--chat-id", chatId, "--as", "bot",
         "--msg-type", "interactive", "--content", JSON.stringify(card)],
        runtime,
      );
      return waitForCardAction({ requestId, timeoutMs }, runtime);
    },
  };
}