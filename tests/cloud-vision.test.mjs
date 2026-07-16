import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadHermesVisionConfiguration, requestCloudVision } from "../scripts/cloud-vision.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hermes-vision-"));
  const configPath = path.join(root, "config.yaml");
  const envPath = path.join(root, ".env");
  const imagePath = path.join(root, "screen.png");
  await Promise.all([
    writeFile(configPath, [
      "model:",
      "  default: kimi-k2.7-code",
      "auxiliary:",
      "  vision:",
      "    provider: kimi-coding",
      "    model: kimi-k2.5-vision",
      "    base_url: https://api.kimi.com/coding",
      "    api_key: ${KIMI_API_KEY}",
    ].join("\n")),
    writeFile(envPath, "KIMI_API_KEY=test-hermes-secret\n"),
    writeFile(imagePath, PNG),
  ]);
  return { root, configPath, envPath, imagePath };
}

test("Hermes auxiliary vision configuration reuses its Kimi model and dotenv credential", async () => {
  const value = await fixture();
  try {
    assert.deepEqual(await loadHermesVisionConfiguration({
      hermesConfigPath: value.configPath,
      hermesEnvPath: value.envPath,
      environment: {},
    }), {
      provider: "kimi-coding",
      apiUrl: "https://api.kimi.com/coding/v1/chat/completions",
      apiKey: "test-hermes-secret",
      model: "kimi-k2.5-vision",
      protocol: "openai-chat-completions",
      timeoutMs: 120000,
      source: "hermes-auxiliary-vision",
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Kimi Coding vision uses its OpenAI chat-completions endpoint and returns strict JSON", async () => {
  const value = await fixture();
  let request;
  try {
    const result = await requestCloudVision({
      imagePath: value.imagePath,
      promptText: "Return JSON only.",
      instruction: "Locate the profile tab.",
      hermesConfigPath: value.configPath,
      hermesEnvPath: value.envPath,
      environment: {},
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: "```json\n{\"matches\":[]}\n```" } }] }),
        };
      },
    });
    assert.equal(request.url, "https://api.kimi.com/coding/v1/chat/completions");
    assert.equal(request.options.headers.authorization, "Bearer test-hermes-secret");
    assert.equal(request.body.model, "kimi-k2.5-vision");
    assert.equal(request.body.temperature, 1);
    assert.equal(request.body.messages[1].content[1].type, "image_url");
    assert.equal(result.content, '{"matches":[]}');
    assert.equal(result.protocol, "openai-chat-completions");
    assert.doesNotMatch(JSON.stringify(result), /test-hermes-secret/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("explicit OpenAI-compatible vision configuration remains supported", async () => {
  const value = await fixture();
  let request;
  try {
    const result = await requestCloudVision({
      imagePath: value.imagePath,
      promptText: "Return JSON only.",
      apiUrl: "https://vision.example/v1/chat/completions",
      apiKey: "explicit-secret",
      model: "vision-model",
      environment: {},
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{"matches":[]}' } }] }),
        };
      },
    });
    assert.equal(request.url, "https://vision.example/v1/chat/completions");
    assert.equal(request.options.headers.authorization, "Bearer explicit-secret");
    assert.equal(request.body.messages[1].content[1].type, "image_url");
    assert.equal(request.body.temperature, 0);
    assert.equal(result.protocol, "openai-chat-completions");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an OpenAI-compatible v1 base URL is expanded to chat completions", async () => {
  const value = await fixture();
  let endpoint;
  try {
    await requestCloudVision({
      imagePath: value.imagePath,
      promptText: "Return JSON only.",
      apiUrl: "https://api.kimi.com/coding/v1",
      apiKey: "explicit-secret",
      model: "kimi-k2.5-vision",
      provider: "kimi-coding",
      environment: {},
      fetchImpl: async (url) => {
        endpoint = url;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '{"matches":[]}' } }] }),
        };
      },
    });
    assert.equal(endpoint, "https://api.kimi.com/coding/v1/chat/completions");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("vision transport aborts when its bounded timeout expires", async () => {
  const value = await fixture();
  try {
    await assert.rejects(() => requestCloudVision({
      imagePath: value.imagePath,
      promptText: "Return JSON only.",
      apiUrl: "https://api.kimi.com/coding/v1",
      apiKey: "explicit-secret",
      model: "kimi-k2.5-vision",
      provider: "kimi-coding",
      environment: {},
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }), /timed out after 10ms/u);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
