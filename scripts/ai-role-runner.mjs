import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const AUTOMATIC_ROLES = new Set(["topic_planner", "page_recovery", "research_analysis"]);
const PAGE_TYPES = new Set([
  "HOME_FEED", "SEARCH_ENTRY", "SEARCH_SUGGESTIONS", "SEARCH_RESULTS", "TRENDING",
  "RECOMMENDED", "IMAGE_NOTE", "VIDEO_NOTE", "COMMENT_PANEL", "NETWORK_ERROR",
  "UPDATE_MODAL", "LOGIN_OR_CHALLENGE", "UNKNOWN",
]);
const SAFE_PAGE_ACTIONS = new Set([
  "OPEN_SEARCH", "OPEN_RESULT", "OPEN_COMMENTS", "SCROLL_CONTENT", "CLOSE_PANEL",
  "BACK", "REFRESH_UI_TREE", "STOP_FOR_HUMAN", "NONE",
]);
const PROMPTS = {
  topic_planner: "prompts/topic-planner.txt",
  page_recovery: "prompts/xhs-page-classifier.txt",
  research_analysis: "prompts/research-analyst.txt",
  comment_assistant: "prompts/comment-draft.txt",
};
export const AI_ROLE_SCHEMAS = Object.freeze({
  topic_planner: {
    type: "object", additionalProperties: false,
    required: ["intentClusters", "rankedQueries", "excludedTerms", "rationale"],
    properties: {
      intentClusters: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["name", "queries"], properties: { name: { type: "string" }, queries: { type: "array", maxItems: 6, items: { type: "string" } } } } },
      rankedQueries: { type: "array", maxItems: 6, items: { type: "string" } },
      excludedTerms: { type: "array", maxItems: 20, items: { type: "string" } },
      rationale: { type: "string" },
    },
  },
  page_recovery: {
    type: "object", additionalProperties: false,
    required: ["pageType", "confidence", "evidence", "suggestedAction", "targetDescription", "sensitiveContentVisible", "humanRequired"],
    properties: {
      pageType: { type: "string", enum: [...PAGE_TYPES] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      evidence: { type: "array", maxItems: 10, items: { type: "string" } },
      suggestedAction: { type: "string", enum: [...SAFE_PAGE_ACTIONS] },
      targetDescription: { type: "string" },
      sensitiveContentVisible: { type: "boolean" },
      humanRequired: { type: "boolean" },
    },
  },
  research_analysis: {
    type: "object", additionalProperties: false,
    required: ["clusters", "rankedCandidates", "contentGaps", "summary"],
    properties: {
      clusters: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["name", "candidateIds"], properties: { name: { type: "string" }, candidateIds: { type: "array", maxItems: 15, items: { type: "string" } } } } },
      rankedCandidates: { type: "array", maxItems: 15, items: { type: "object", additionalProperties: false, required: ["candidateId", "score", "reason"], properties: { candidateId: { type: "string" }, score: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" } } } },
      contentGaps: { type: "array", maxItems: 10, items: { type: "string" } },
      summary: { type: "string" },
    },
  },
  comment_assistant: {
    type: "object", additionalProperties: false,
    required: ["draft", "rationale", "requiresFactCheck"],
    properties: {
      draft: { type: "string", minLength: 1, maxLength: 300 },
      rationale: { type: "string" },
      requiresFactCheck: { type: "boolean" },
    },
  },
});
const SENSITIVE_PATTERN = /(验证码|校验码|人脸|支付|付款|银行卡|私信|消息列表|通讯录|联系人|登录挑战|权限申请|系统权限|应用权限|允许访问|始终允许|仅在使用时允许|不允许|授权访问|相机权限|麦克风权限|通知权限|位置权限|我的订单|订单详情|交易详情|收货地址|账号与安全|隐私设置|实名认证|captcha|verification code|payment|bank card|private message|contacts|permission prompt|order details|(?:^|\D)1[3-9]\d{9}(?:\D|$)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:^|\D)\d{17}[\dX](?:\D|$))/i;
const FORBIDDEN_OUTPUT_PATTERN = /(?:自动|批量|建议|请|执行|进行|应当|需要).{0,12}(?:点赞|收藏|关注|发送评论|回复评论|私信|发布|删除)|(?:recommend|suggest|should|please|execute|perform|automatically|batch).{0,24}(?:like|favorite|follow|send\s+(?:a\s+)?comment|message|publish|delete)|规避.{0,8}(?:风控|限制)|bypass.{0,12}(?:captcha|risk|limit)/i;

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashValue(value) {
  const payload = Buffer.isBuffer(value) ? value : (typeof value === "string" ? value : canonicalJson(value));
  return createHash("sha256").update(payload).digest("hex");
}

export function containsSensitiveContext(value) {
  return SENSITIVE_PATTERN.test(typeof value === "string" ? value : canonicalJson(value));
}

function assertStringArray(value, name, max = 100) {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array with at most ${max} items`);
  }
}

function assertExactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (extras.length || missing.length) {
    throw new Error(`${name} has invalid fields; unsupported: ${extras.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`);
  }
}

export function validateRoleOutput(role, value, input = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI output must be an object");
  if (FORBIDDEN_OUTPUT_PATTERN.test(canonicalJson(value))) throw new Error("AI output contains a forbidden automation recommendation");

  if (role === "topic_planner") {
    assertExactKeys(value, ["intentClusters", "rankedQueries", "excludedTerms", "rationale"], "topic planner output");
    if (!Array.isArray(value.intentClusters) || value.intentClusters.length > 4) throw new Error("Invalid intentClusters");
    for (const cluster of value.intentClusters) {
      assertExactKeys(cluster, ["name", "queries"], "intent cluster");
      if (typeof cluster?.name !== "string") throw new Error("Invalid intent cluster name");
      assertStringArray(cluster.queries, "intent cluster queries", 6);
    }
    assertStringArray(value.rankedQueries, "rankedQueries", 6);
    assertStringArray(value.excludedTerms, "excludedTerms", 20);
    if (typeof value.rationale !== "string") throw new Error("Invalid topic rationale");
  } else if (role === "page_recovery") {
    if ("x" in value || "y" in value || "coordinates" in value) throw new Error("Page recovery may not return coordinates");
    assertExactKeys(value, ["pageType", "confidence", "evidence", "suggestedAction", "targetDescription", "sensitiveContentVisible", "humanRequired"], "page recovery output");
    if (!PAGE_TYPES.has(value.pageType)) throw new Error("Invalid pageType");
    if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) throw new Error("Invalid confidence");
    if (!SAFE_PAGE_ACTIONS.has(value.suggestedAction)) throw new Error("Invalid suggestedAction");
    if (typeof value.targetDescription !== "string") throw new Error("Invalid targetDescription");
    assertStringArray(value.evidence, "evidence", 10);
    if (typeof value.sensitiveContentVisible !== "boolean" || typeof value.humanRequired !== "boolean") {
      throw new Error("Invalid page recovery safety fields");
    }
    if (value.sensitiveContentVisible === true || value.pageType === "LOGIN_OR_CHALLENGE") {
      return { ...value, suggestedAction: "STOP_FOR_HUMAN", humanRequired: true };
    }
    if (value.confidence < 0.9) return { ...value, suggestedAction: "STOP_FOR_HUMAN", humanRequired: true };
  } else if (role === "research_analysis") {
    assertExactKeys(value, ["clusters", "rankedCandidates", "contentGaps", "summary"], "research analysis output");
    if (!Array.isArray(value.clusters) || value.clusters.length > 5) throw new Error("Invalid clusters");
    if (!Array.isArray(value.rankedCandidates) || value.rankedCandidates.length > 15) throw new Error("Invalid rankedCandidates");
    const allowed = new Set((input.candidates || []).map((candidate) => candidate.candidateId));
    for (const cluster of value.clusters) {
      assertExactKeys(cluster, ["name", "candidateIds"], "analysis cluster");
      if (typeof cluster.name !== "string") throw new Error("Invalid analysis cluster name");
      assertStringArray(cluster.candidateIds, "analysis cluster candidateIds", 15);
      if (cluster.candidateIds.some((candidateId) => !allowed.has(candidateId))) throw new Error("Analysis cluster referenced an unknown candidate");
    }
    for (const item of value.rankedCandidates) {
      assertExactKeys(item, ["candidateId", "score", "reason"], "ranked candidate");
      if (!allowed.has(item.candidateId) || typeof item.score !== "number" || item.score < 0 || item.score > 1 || typeof item.reason !== "string") {
        throw new Error("Analysis referenced an unknown or invalid candidate");
      }
    }
    assertStringArray(value.contentGaps, "contentGaps", 10);
    if (typeof value.summary !== "string") throw new Error("Invalid research summary");
  } else if (role === "comment_assistant") {
    assertExactKeys(value, ["draft", "rationale", "requiresFactCheck"], "comment assistant output");
    if (input.humanRequested !== true) throw new Error("Comment drafting requires an explicit human request");
    if (typeof value.draft !== "string" || !value.draft.trim() || value.draft.length > 300) throw new Error("Invalid comment draft");
    if (typeof value.rationale !== "string" || typeof value.requiresFactCheck !== "boolean") throw new Error("Invalid comment metadata");
  } else {
    throw new Error(`Unknown AI role: ${role}`);
  }
  return value;
}

async function readJsonIfExists(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function reserveAutomaticCall(budgetPath, role, maximum) {
  const budget = (await readJsonIfExists(budgetPath)) || { automaticCalls: 0, byRole: {} };
  if (budget.automaticCalls >= maximum) throw new Error(`Automatic AI budget exhausted (${maximum})`);
  const roleMaximum = role === "page_recovery" ? 2 : 1;
  if ((budget.byRole[role] || 0) >= roleMaximum) throw new Error(`AI role budget exhausted: ${role}`);
  budget.automaticCalls += 1;
  budget.byRole[role] = (budget.byRole[role] || 0) + 1;
  await atomicJson(budgetPath, budget);
  return budget;
}

async function cacheFresh(path, ttlDays) {
  try {
    const metadata = await stat(path);
    return ttlDays <= 0 || Date.now() - metadata.mtimeMs <= ttlDays * 86400000;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function requestJson({ role, input, prompt, apiUrl, apiKey, model }) {
  const userContent = [{ type: "text", text: `Role: ${role}\nInput JSON:\n${JSON.stringify(input)}` }];
  if (role === "page_recovery") {
    if (!input.imagePath) throw new Error("Page recovery requires imagePath");
    const imagePath = resolve(input.imagePath);
    const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(imagePath).toLowerCase()];
    if (!mime) throw new Error("Unsupported page-recovery image type");
    const image = await readFile(imagePath);
    userContent.push({ type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } });
  }
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: `xhs_${role}`, strict: true, schema: AI_ROLE_SCHEMAS[role] },
      },
      messages: [{ role: "system", content: prompt }, { role: "user", content: userContent }],
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`AI API ${response.status}: ${JSON.stringify(body)}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI API returned no JSON content");
  return JSON.parse(content);
}

export async function runAiRole(options) {
  const {
    role, input, cacheDir, budgetPath, maxAutomaticCalls = 4, humanRequested = false,
    apiUrl, apiKey, model, promptPath = PROMPTS[role], promptVersion = "1", request = requestJson,
  } = options;
  if (!PROMPTS[role]) throw new Error(`Unsupported AI role: ${role}`);
  if (role === "comment_assistant" && !humanRequested) throw new Error("Comment assistant is human-triggered only");
  const normalizedInput = role === "comment_assistant" ? { ...input, humanRequested: true } : input;
  let cacheInput = normalizedInput;
  if (role === "page_recovery") {
    if (!normalizedInput.imagePath) throw new Error("Page recovery requires a locally available image");
    const imageHash = hashValue(await readFile(resolve(normalizedInput.imagePath)));
    cacheInput = { ...normalizedInput, imagePath: undefined, imageHash };
  }
  const cacheKey = hashValue({ role, input: cacheInput, promptVersion, model });
  const cachePath = join(resolve(cacheDir), role, `${cacheKey}.json`);
  const ttlDays = role === "topic_planner" ? 30 : 0;
  if (await cacheFresh(cachePath, ttlDays)) {
    const cached = await readJsonIfExists(cachePath);
    validateRoleOutput(role, cached.output, normalizedInput);
    return { ...cached, cacheHit: true };
  }
  if (AUTOMATIC_ROLES.has(role)) await reserveAutomaticCall(resolve(budgetPath), role, maxAutomaticCalls);
  if (!model) throw new Error("AI model is not configured");
  if (request === requestJson && (!apiUrl || !apiKey)) throw new Error("AI API URL and key are not configured");
  const prompt = await readFile(resolve(promptPath), "utf8");
  const raw = await request({ role, input: normalizedInput, prompt, apiUrl, apiKey, model });
  const output = validateRoleOutput(role, raw, normalizedInput);
  const record = { role, model, promptVersion, cacheKey, createdAt: new Date().toISOString(), output };
  await mkdir(resolve(cachePath, ".."), { recursive: true });
  await atomicJson(cachePath, record);
  return { ...record, cacheHit: false };
}

async function main() {
  const role = arg("--role");
  const inputPath = arg("--input");
  if (!role || !inputPath) throw new Error("Usage: node scripts/ai-role-runner.mjs --role <role> --input <json> [--human-requested true]");
  const input = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  const result = await runAiRole({
    role,
    input,
    humanRequested: arg("--human-requested") === "true",
    cacheDir: arg("--cache-dir", "data/ai-cache"),
    budgetPath: arg("--budget", "data/ai-budget.json"),
    maxAutomaticCalls: Number(arg("--max-automatic-calls", "4")),
    apiUrl: process.env.AI_API_URL || process.env.VISION_API_URL,
    apiKey: process.env.AI_API_KEY || process.env.VISION_API_KEY,
    model: process.env.AI_MODEL || process.env.VISION_MODEL,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
