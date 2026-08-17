// xhs-comment-imitate.mjs — 评论仿写编排（Mac 侧运行）
//
// 流程：调远程网关 xhs.comments.read 读评论 → 按点赞取 TopN → CPA 大模型仿写 ≤20 字
// → 通过 notifier 发交互卡片请人确认 → 确认则串 xhs.comment.open/input/send 发送。
//
// 架构说明（与 plan 偏离的修正）：
//   plan 原写"复用项目现有 xiaowei transport 调网关"。经核查，xiaowei-transport 是
//   WebSocket(127.0.0.1:22222) + HMAC gatewayKey + trusted-PowerShell-parent 鉴权，
//   Mac 侧无法使用。xhs-remote-gateway 另提供 HTTP 入口 POST /v1/command，经 tailscale
//   serve 暴露到 tailnet，对 STRUCTURED_COMMANDS 直接返回解析后对象，无需 token（已用
//   device.list 实测 200）。因此编排脚本自包含用 fetch 调 /v1/command，不 import 仓库
//   任何模块，也不需要把仓库 clone 到 Mac。
//
// 安全：测试全 mock，不真发。真发需 notifier 裁决 decision="send" 且调用方提供
//   sendContext.expectedEmptyEditorStateHash（真机验收时先 observe 空编辑器拿到）。
//
// imitate 后端有两种，由 runtime 决定：
//   - CPA CLI helper（推荐生产用）：spawn Codex 的 remote-cpa skill helper
//     `python3 ~/.codex/skills/remote-cpa/scripts/cpa_request.py chat ...`，helper 内部解析
//     base_url + key（CPA_API_KEY env 或 SSH fallback 读 config.local.yaml），node 不碰 key。
//     触发条件：runtime.cpaRequestPath 或 runtime.useCpaCli 为真。
//   - fetch 直连（测试/备选）：runtime.cpaUrl + runtime.cpaApiKey，需自备 key。

import os from "node:os";
import path from "node:path";
import { spawn as defaultSpawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_GATEWAY_URL = "https://desktop-3i1evhe.tail400674.ts.net";
export const DEFAULT_CPA_URL = "http://localhost:8317";
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_TOP_N = 3;
export const DEFAULT_TIMEOUT_MS = 300_000; // 5 分钟；超时自动放弃不发
export const DEFAULT_CPA_REQUEST_PY = path.join(
  os.homedir(), ".codex", "skills", "remote-cpa", "scripts", "cpa_request.py",
);
export const DEFAULT_CPA_PYTHON = "python3";
export const DEFAULT_CPA_MAX_TOKENS = 60;

const MACHINE_RE = /^\d{2}$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;

// ---------------------------------------------------------------------------
// gateway client — POST /v1/command
// ---------------------------------------------------------------------------

// STRUCTURED_COMMANDS（comments.read / comment.open/input/send）网关直接返回 parsed 对象，
// 没有 ok 包裹；非结构化命令返回 {ok, requestId, ...result}。这里只看 HTTP 状态。
export async function callGateway(command, params, runtime = {}) {
  if (typeof command !== "string" || !command) throw new Error("callGateway requires a command");
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("callGateway requires a fetch implementation");
  const base = (runtime.gatewayUrl ?? DEFAULT_GATEWAY_URL).replace(/\/+$/u, "");
  const url = `${base}/v1/command`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, ...params }),
  });
  const raw = await res.text();
  let body = null;
  if (raw) {
    try { body = JSON.parse(raw); }
    catch { throw new Error(`gateway ${command} returned non-JSON (http ${res.status})`); }
  }
  if (!res.ok) {
    const detail = body?.error ?? raw ?? `http ${res.status}`;
    throw new Error(`gateway ${command} failed: ${detail}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// read + rank
// ---------------------------------------------------------------------------

export async function readComments(machine, runtime = {}) {
  if (!MACHINE_RE.test(machine)) throw new Error("machine must be a 2-digit device alias");
  const result = await callGateway("xhs.comments.read", { machine }, runtime);
  if (!result || result.status !== "verified") {
    throw new Error(`xhs.comments.read not verified: ${result?.status ?? "no_result"}`);
  }
  if (!Array.isArray(result.comments)) throw new Error("xhs.comments.read returned non-array comments");
  return result.comments;
}

export function topByLikes(comments, n = DEFAULT_TOP_N) {
  if (!Array.isArray(comments)) throw new Error("topByLikes requires an array");
  if (!Number.isSafeInteger(n) || n < 1 || n > 50) throw new Error("n must be an integer from 1 through 50");
  return [...comments]
    .sort((a, b) => (b?.likes ?? -1) - (a?.likes ?? -1))
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// imitate — CPA (OpenAI-compatible /v1/chat/completions)
// ---------------------------------------------------------------------------

export function buildImitatePrompt(sourceComments) {
  if (!Array.isArray(sourceComments) || !sourceComments.length) {
    throw new Error("buildImitatePrompt requires at least one source comment");
  }
  const viewpoints = sourceComments
    .map((c, index) => `${index + 1}. ${c.author ?? "网友"}：${c.content ?? ""}`)
    .join("\n");
  return [
    "下面是小红书某帖子的几条热门评论。请综合这些评论的观点与语气，仿写一条符合小红书风格、自然不生硬、不超过 20 字的评论，不要直接复制任何一条原文。",
    "只输出评论正文本身，不要加引号、不要解释、不要前后缀。",
    "",
    "热门评论：",
    viewpoints,
  ].join("\n");
}

export async function imitateViaFetch(sourceComments, runtime = {}) {
  const prompt = buildImitatePrompt(sourceComments);
  const fetchImpl = runtime.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("imitateViaFetch requires a fetch implementation");
  const cpaUrl = (runtime.cpaUrl ?? DEFAULT_CPA_URL).replace(/\/+$/u, "") + "/v1/chat/completions";
  const model = runtime.model ?? DEFAULT_MODEL;
  const headers = { "content-type": "application/json" };
  const apiKey = runtime.cpaApiKey ?? process.env.CPA_API_KEY;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetchImpl(cpaUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 60,
    }),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* fall through */ }
  if (!res.ok) {
    throw new Error(`CPA imitate failed (http ${res.status}): ${data?.error?.message ?? raw}`);
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("CPA imitate returned empty content");
  return text.replace(/\s+/gu, " ").trim().slice(0, 256);
}

// CPA CLI helper：spawn Codex remote-cpa skill 的 cpa_request.py chat，stdout 即回复文本。
// helper 内部解析 base_url + key（CPA_API_KEY env 或 SSH fallback 读 config.local.yaml），
// node 进程不接触 key。已用 doctor + 一次真实 chat 实测可用（返回"很会穿，氛围感直接拉满。"）。
export async function imitateViaCli(sourceComments, runtime = {}) {
  const prompt = buildImitatePrompt(sourceComments);
  const spawnImpl = runtime.spawn ?? defaultSpawn;
  if (typeof spawnImpl !== "function") throw new Error("imitateViaCli requires a spawn implementation");
  const py = runtime.cpaPython ?? DEFAULT_CPA_PYTHON;
  const script = runtime.cpaRequestPath ?? DEFAULT_CPA_REQUEST_PY;
  const model = runtime.model ?? DEFAULT_MODEL;
  const maxTokens = runtime.cpaMaxTokens ?? DEFAULT_CPA_MAX_TOKENS;
  const args = [script, "chat", "--model", model, "--message", prompt, "--max-tokens", String(maxTokens)];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(py, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cpa_request.py exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const text = stdout.replace(/\s+/gu, " ").trim();
      if (!text) reject(new Error("cpa_request.py returned empty content"));
      else resolve(text.slice(0, 256));
    });
  });
}

// 分派：runtime.cpaRequestPath 或 runtime.useCpaCli → CLI helper；否则 fetch 直连。
export async function imitate(sourceComments, runtime = {}) {
  if (runtime.cpaRequestPath || runtime.useCpaCli) {
    return imitateViaCli(sourceComments, runtime);
  }
  return imitateViaFetch(sourceComments, runtime);
}

// ---------------------------------------------------------------------------
// postComment — open → input → send
// ---------------------------------------------------------------------------

// sendContext: { expectedEmptyEditorStateHash } — 真机验收时先 observe 空编辑器拿到此哈希。
// mock 测试不真发，可传任意 64-hex 占位值。
export async function postComment(machine, text, sendContext = {}, runtime = {}) {
  if (!MACHINE_RE.test(machine)) throw new Error("machine must be a 2-digit device alias");
  if (typeof text !== "string" || !text.trim()) throw new Error("postComment requires non-empty text");
  const expectedEmptyEditorStateHash = sendContext.expectedEmptyEditorStateHash;
  if (typeof expectedEmptyEditorStateHash !== "string" || !SHA256_RE.test(expectedEmptyEditorStateHash)) {
    throw new Error("postComment requires sendContext.expectedEmptyEditorStateHash (sha256 hex)");
  }
  const opened = await callGateway("xhs.comment.open", { machine }, runtime);
  if (!opened || opened.status !== "verified") {
    throw new Error(`xhs.comment.open not verified: ${opened?.status ?? "no_result"}`);
  }
  await callGateway("xhs.comment.input", {
    machine,
    text,
    expectedEditorStateHash: opened.editorStateHash,
  }, runtime);
  await callGateway("xhs.comment.send", {
    machine,
    expectedDraft: text,
    expectedBeforeCount: opened.commentCount,
    expectedTarget: opened.target,
    expectedEmptyEditorStateHash,
  }, runtime);
  return { machine, text, beforeCount: opened.commentCount, target: opened.target };
}

// ---------------------------------------------------------------------------
// notifier 接口（duck-typed）
// ---------------------------------------------------------------------------
// notifier.sendConfirm(card, runtime) → Promise<verdict>
//   card: { machine, sourceComments: [{author,content,likes,isPinned,hasTranslate}],
//           candidate: string, timeoutMs: number }
//   verdict: { decision: "send" | "skip",
//              text: string | null,   // decision="send" 时为最终发送文本（候选原文或用户改写）
//              reason: "confirmed" | "rewritten" | "rejected" | "timeout" | string }
// 实现见 createConsoleNotifier / createLarkNotifier（xhs-lark-notifier.mjs）。

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runCommentImitate(options = {}, runtime = {}) {
  const machine = options.machine;
  if (!MACHINE_RE.test(machine)) throw new Error("options.machine must be a 2-digit device alias");
  const topN = options.topN ?? DEFAULT_TOP_N;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const notifier = options.notifier;
  if (!notifier || typeof notifier.sendConfirm !== "function") {
    throw new Error("options.notifier.sendConfirm is required");
  }

  const comments = await readComments(machine, runtime);
  if (!comments.length) {
    return { outcome: "no_comments", machine, sent: false };
  }
  const top = topByLikes(comments, topN);
  const candidate = await imitate(top, runtime);

  const verdict = await notifier.sendConfirm({
    machine, sourceComments: top, candidate, timeoutMs,
  }, runtime);

  if (verdict?.decision !== "send") {
    return { outcome: "skipped", machine, sent: false, reason: verdict?.reason ?? "rejected", candidate };
  }
  const finalText = typeof verdict.text === "string" && verdict.text.trim() ? verdict.text : candidate;
  await postComment(machine, finalText, options.sendContext ?? {}, runtime);
  return { outcome: "sent", machine, sent: true, text: finalText, reason: verdict.reason ?? "confirmed", candidate };
}

// ---------------------------------------------------------------------------
// ConsoleNotifier — 本地 dry-run，stdin 确认（不用于生产）
// ---------------------------------------------------------------------------

export function createConsoleNotifier({ input = defaultStdin, output = defaultStdout } = {}) {
  async function readLineWithTimeout(prompt, timeoutMs) {
    const rl = readline.createInterface({ input, output, terminal: false });
    let timer = null;
    try {
      const answer = await Promise.race([
        rl.question(prompt),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("confirm_timeout")), timeoutMs);
        }),
      ]);
      return String(answer).trim();
    } finally {
      if (timer) clearTimeout(timer);
      rl.close();
    }
  }

  return {
    async sendConfirm({ machine, sourceComments, candidate, timeoutMs }) {
      const lines = [
        `\n[comment-imitate] machine=${machine}`,
        "热门评论观点：",
        ...sourceComments.map((c) => `  - ${c.author}：${c.content} (赞${c.likes ?? 0}${c.isPinned ? " 置顶" : ""})`),
        `\n仿写候选（≤20字）：${candidate}`,
        `\n确认发送？输入 y=发送候选 / n=跳过 / 其它=改写后发送（超时 ${timeoutMs}ms 自动跳过）：`,
      ];
      const answer = await readLineWithTimeout(lines.join("\n") + "\n> ", timeoutMs);
      if (!answer) return { decision: "skip", text: null, reason: "timeout" };
      if (answer === "y" || answer === "Y") return { decision: "send", text: candidate, reason: "confirmed" };
      if (answer === "n" || answer === "N") return { decision: "skip", text: null, reason: "rejected" };
      return { decision: "send", text: answer, reason: "rewritten" };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry（本地 dry-run：node scripts/xhs-comment-imitate.mjs --machine 01）
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--machine") { options.machine = argv[++i]; continue; }
    if (token === "--top-n") { options.topN = Number(argv[++i]); continue; }
    if (token === "--model") { options.model = argv[++i]; continue; }
    if (token === "--timeout-ms") { options.timeoutMs = Number(argv[++i]); continue; }
    if (token === "--gateway-url") { options.gatewayUrl = argv[++i]; continue; }
    throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (!options.machine) {
    process.stderr.write("usage: node scripts/xhs-comment-imitate.mjs --machine <01..04> [--top-n 3] [--model gpt-5.4] [--timeout-ms 300000] [--gateway-url URL]\n");
    process.exitCode = 2;
    return;
  }
  const notifier = createConsoleNotifier();
  const runtime = {};
  if (options.gatewayUrl) runtime.gatewayUrl = options.gatewayUrl;
  if (options.model) runtime.model = options.model;
  const result = await runCommentImitate(
    { machine: options.machine, topN: options.topN, timeoutMs: options.timeoutMs, notifier },
    runtime,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`comment-imitate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}