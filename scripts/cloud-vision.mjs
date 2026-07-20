import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const MIME_BY_EXTENSION = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
});

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function configuredValue(environment, primary, fallback) {
  return environment?.[primary] || environment?.[fallback] || "";
}

async function optionalText(filePath) {
  if (!filePath) return "";
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function unquote(value) {
  const trimmed = String(value ?? "").trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

function parseDotEnv(source) {
  const values = {};
  for (const raw of String(source).split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(raw.trim());
    if (match) values[match[1]] = unquote(match[2]);
  }
  return values;
}

function parseHermesVisionYaml(source) {
  const result = {};
  let inAuxiliary = false;
  let inVision = false;
  for (const raw of String(source).split(/\r?\n/u)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      inAuxiliary = trimmed === "auxiliary:";
      inVision = false;
      continue;
    }
    if (inAuxiliary && indent === 2) {
      inVision = trimmed === "vision:";
      continue;
    }
    if (inVision && indent >= 4) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(trimmed);
      if (match) result[match[1]] = unquote(match[2]);
    }
  }
  return result;
}

function defaultHermesRoot(environment) {
  if (environment?.LOCALAPPDATA) return join(environment.LOCALAPPDATA, "hermes");
  if (environment?.USERPROFILE) return join(environment.USERPROFILE, ".hermes");
  return "";
}

function resolveConfiguredSecret(value, environment, dotenv) {
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(String(value ?? ""));
  if (reference) return environment?.[reference[1]] || dotenv[reference[1]] || "";
  return value || "";
}

function protocolFor(provider, apiUrl, explicit = "", model = "") {
  if (explicit) return explicit;
  if (/\/chat\/completions\/?$/iu.test(apiUrl) || /vision/iu.test(model)) {
    return "openai-chat-completions";
  }
  if (/kimi-coding/iu.test(provider) || /^https:\/\/api\.kimi\.com\/coding(?:\/|$)/iu.test(apiUrl)) {
    return "anthropic-messages";
  }
  return "openai-chat-completions";
}

function hermesVisionApiUrl(provider, apiUrl, model) {
  if ((/kimi-coding/iu.test(provider) || /^https:\/\/api\.kimi\.com\/coding(?:\/|$)/iu.test(apiUrl))
      && /vision/iu.test(model)) {
    const base = apiUrl.trim().replace(/\/+$/u, "")
      .replace(/\/v1(?:\/chat\/completions)?$/iu, "");
    return `${base}/v1/chat/completions`;
  }
  return apiUrl;
}

function openAiChatCompletionsUrl(apiUrl) {
  const normalized = apiUrl.trim().replace(/\/+$/u, "");
  if (/\/chat\/completions$/iu.test(normalized)) return normalized;
  if (/\/v1$/iu.test(normalized)) return `${normalized}/chat/completions`;
  return normalized;
}

function positiveTimeout(value, fallback = 120_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export async function loadHermesVisionConfiguration({
  hermesConfigPath,
  hermesEnvPath,
  environment = process.env,
} = {}) {
  const root = defaultHermesRoot(environment);
  const configPath = hermesConfigPath ?? (root ? join(root, "config.yaml") : "");
  const envPath = hermesEnvPath ?? (root ? join(root, ".env") : "");
  const [configSource, envSource] = await Promise.all([
    optionalText(configPath),
    optionalText(envPath),
  ]);
  if (!configSource) return null;
  const vision = parseHermesVisionYaml(configSource);
  const dotenv = parseDotEnv(envSource);
  const provider = vision.provider || "";
  const rawApiUrl = vision.base_url || "";
  const model = vision.model || "";
  const apiUrl = hermesVisionApiUrl(provider, rawApiUrl, model);
  const providerKey = /kimi/iu.test(provider) || /api\.kimi\.com/iu.test(rawApiUrl)
    ? (environment.KIMI_API_KEY || environment.KIMI_CODING_API_KEY
      || dotenv.KIMI_API_KEY || dotenv.KIMI_CODING_API_KEY)
    : "";
  const apiKey = providerKey || resolveConfiguredSecret(vision.api_key, environment, dotenv);
  if (!apiUrl || !apiKey || !model) return null;
  return {
    provider,
    apiUrl,
    apiKey,
    model,
    protocol: protocolFor(provider, apiUrl, "", model),
    timeoutMs: positiveTimeout(Number(vision.timeout) * 1_000),
    source: "hermes-auxiliary-vision",
  };
}

function anthropicMessagesUrl(apiUrl) {
  const normalized = apiUrl.trim().replace(/\/+$/u, "").replace(/\/v1$/u, "");
  if (/\/v1\/messages$/u.test(normalized)) return normalized;
  return `${normalized}/v1/messages`;
}

function normalizedJsonContent(value) {
  let content = String(value ?? "").trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(content);
  if (fenced) content = fenced[1].trim();
  if (!content) throw new Error("云端视觉接口没有返回文本内容");
  try {
    JSON.parse(content);
  } catch {
    throw new Error("云端视觉接口返回的内容不是有效 JSON");
  }
  return content;
}

function providerError(body) {
  const value = body?.error?.message ?? body?.message ?? "";
  return typeof value === "string" && value.trim() ? `: ${value.trim().slice(0, 512)}` : "";
}

/**
 * Send a screenshot to an explicitly configured endpoint or reuse Hermes'
 * auxiliary.vision provider. Both OpenAI chat-completions and Kimi Coding's
 * Anthropic Messages transport are supported.
 */
export async function requestCloudVision({
  imagePath,
  promptPath,
  promptText,
  instruction = "Inspect this current device screen and return JSON only.",
  apiUrl = "",
  apiKey = "",
  model = "",
  provider = "",
  protocol = "",
  hermesConfigPath,
  hermesEnvPath,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs,
} = {}) {
  let resolvedApiUrl = apiUrl || configuredValue(environment, "VISION_API_URL", "AI_API_URL");
  let resolvedApiKey = apiKey || configuredValue(environment, "VISION_API_KEY", "AI_API_KEY");
  let resolvedModel = model || configuredValue(environment, "VISION_MODEL", "AI_MODEL");
  let resolvedProvider = provider;
  let resolvedProtocol = protocol;
  let resolvedTimeoutMs = positiveTimeout(
    timeoutMs ?? environment.VISION_TIMEOUT_MS ?? environment.AI_TIMEOUT_MS,
  );
  if (!resolvedApiUrl || !resolvedApiKey || !resolvedModel) {
    const hermes = await loadHermesVisionConfiguration({ hermesConfigPath, hermesEnvPath, environment });
    resolvedApiUrl ||= hermes?.apiUrl ?? "";
    resolvedApiKey ||= hermes?.apiKey ?? "";
    resolvedModel ||= hermes?.model ?? "";
    resolvedProvider ||= hermes?.provider ?? "";
    resolvedProtocol ||= hermes?.protocol ?? "";
    if (timeoutMs === undefined && !environment.VISION_TIMEOUT_MS && !environment.AI_TIMEOUT_MS) {
      resolvedTimeoutMs = hermes?.timeoutMs ?? resolvedTimeoutMs;
    }
  }
  if (!imagePath || !resolvedApiUrl || !resolvedApiKey || !resolvedModel) {
    throw new Error("需要 --image，并设置 VISION_* / AI_*，或配置 Hermes auxiliary.vision");
  }
  if (typeof fetchImpl !== "function") throw new Error("云端视觉传输不可用");
  resolvedProtocol = protocolFor(resolvedProvider, resolvedApiUrl, resolvedProtocol, resolvedModel);
  if (!["openai-chat-completions", "anthropic-messages"].includes(resolvedProtocol)) {
    throw new Error("不支持的云端视觉协议");
  }

  const absoluteImage = resolve(imagePath);
  const mime = MIME_BY_EXTENSION[extname(absoluteImage).toLowerCase()];
  if (!mime) throw new Error("仅支持 PNG、JPEG 或 WebP 截图");
  const [image, systemPrompt] = await Promise.all([
    readFile(absoluteImage),
    promptText !== undefined
      ? Promise.resolve(String(promptText))
      : promptPath
        ? readFile(resolve(promptPath), "utf8")
        : Promise.resolve("Return a strict JSON description of the image."),
  ]);

  const anthropic = resolvedProtocol === "anthropic-messages";
  const kimiVision = /kimi/iu.test(resolvedProvider) || /api\.kimi\.com/iu.test(resolvedApiUrl);
  const endpoint = anthropic ? anthropicMessagesUrl(resolvedApiUrl) : openAiChatCompletionsUrl(resolvedApiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, anthropic ? {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": resolvedApiKey,
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-code/0.1.0",
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: instruction },
          { type: "image", source: { type: "base64", media_type: mime, data: image.toString("base64") } },
        ],
      }],
    }),
  } : {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolvedApiKey}`,
    },
    body: JSON.stringify({
      model: resolvedModel,
      temperature: kimiVision ? 1 : 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
          ],
        },
      ],
    }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Vision API timed out after ${resolvedTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let body;
  try { body = await response.json(); } catch { throw new Error(`Vision API ${response.status} returned invalid JSON`); }
  if (!response.ok) throw new Error(`Vision API ${response.status}${providerError(body)}`);
  const rawContent = anthropic
    ? body?.content?.find?.((item) => item?.type === "text")?.text
    : body?.choices?.[0]?.message?.content;
  const content = normalizedJsonContent(rawContent);
  return { content, body, provider: resolvedProvider || null, model: resolvedModel, protocol: resolvedProtocol };
}

async function main() {
  const result = await requestCloudVision({
    imagePath: arg("--image"),
    promptPath: arg("--prompt", "prompts/xhs-page-classifier.txt"),
    promptText: process.argv.includes("--prompt-text") ? arg("--prompt-text") : undefined,
    instruction: arg("--instruction", "Inspect this current device screen and return JSON only."),
  });
  const outputPath = arg("--output");
  if (outputPath) await writeFile(resolve(outputPath), `${result.content}\n`, "utf8");
  process.stdout.write(`${result.content}\n`);
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
