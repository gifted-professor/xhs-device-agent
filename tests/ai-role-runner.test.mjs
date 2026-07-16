import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_ROLE_SCHEMAS, containsSensitiveContext, hashValue, runAiRole, validateRoleOutput } from "../scripts/ai-role-runner.mjs";

test("every AI role exposes a strict JSON Schema", () => {
  assert.deepEqual(Object.keys(AI_ROLE_SCHEMAS).sort(), ["comment_assistant", "page_recovery", "research_analysis", "topic_planner"]);
  for (const schema of Object.values(AI_ROLE_SCHEMAS)) {
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
  }
});

test("canonical cache hash is key-order independent", () => {
  assert.equal(hashValue({ b: 2, a: 1 }), hashValue({ a: 1, b: 2 }));
});

test("sensitive page context is detected", () => {
  assert.equal(containsSensitiveContext(["请输入验证码"]), true);
  assert.equal(containsSensitiveContext(["联系电话 13800138000"]), true);
  assert.equal(containsSensitiveContext(["仅在使用时允许"]), true);
  assert.equal(containsSensitiveContext(["搜索", "推荐"]), false);
});

test("low-confidence page recovery stops for a human", () => {
  const result = validateRoleOutput("page_recovery", {
    pageType: "UNKNOWN",
    confidence: 0.6,
    evidence: ["ambiguous canvas"],
    suggestedAction: "REFRESH_UI_TREE",
    targetDescription: "search field",
    sensitiveContentVisible: false,
    humanRequired: false,
  });
  assert.equal(result.humanRequired, true);
  assert.equal(result.suggestedAction, "STOP_FOR_HUMAN");
});

test("page recovery rejects coordinates", () => {
  assert.throws(() => validateRoleOutput("page_recovery", {
    pageType: "SEARCH_ENTRY", confidence: 0.95, evidence: ["search"],
    suggestedAction: "OPEN_SEARCH", targetDescription: "search", sensitiveContentVisible: false, humanRequired: false, x: 10,
  }), /coordinates/);
});

test("page recovery accepts a directly available image without local privacy attestation", async () => {
  const root = await mkdtemp(join(tmpdir(), "xhs-ai-privacy-"));
  const imagePath = join(root, "screen.png");
  const image = Buffer.from("not-a-real-image-but-hash-stable");
  await writeFile(imagePath, image);
  const base = {
    role: "page_recovery",
    cacheDir: join(root, "cache"),
    budgetPath: join(root, "budget.json"),
    model: "test-model",
    request: async () => ({
      pageType: "UNKNOWN", confidence: 0.4, evidence: ["uncertain"], suggestedAction: "STOP_FOR_HUMAN",
      targetDescription: "", sensitiveContentVisible: false, humanRequired: true,
    }),
  };
  const result = await runAiRole({
    ...base,
    input: { imagePath, safeToUpload: true, visibleTexts: [] },
  });
  assert.equal(result.output.humanRequired, true);
});

test("standalone cloud upload is enabled and validates its configured image", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/cloud-vision.mjs", import.meta.url)),
    "--image", "missing.png",
    "--safe-to-upload", "true",
  ], {
    encoding: "utf8", windowsHide: true,
    env: {
      ...process.env,
      VISION_API_URL: "https://vision.invalid/v1/chat/completions",
      VISION_API_KEY: "test-key",
      VISION_MODEL: "test-model",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /missing\.png|ENOENT/iu);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /disabled/iu);
});

test("page recovery can inspect sensitive visible text in permissive mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "xhs-ai-sensitive-"));
  const imagePath = join(root, "screen.png");
  await writeFile(imagePath, Buffer.from("image"));
  let calls = 0;
  const result = await runAiRole({
    role: "page_recovery",
    input: { imagePath, visibleTexts: ["收银台"] },
    cacheDir: join(root, "cache"),
    budgetPath: join(root, "budget.json"),
    model: "test-model",
    request: async () => {
      calls += 1;
      return {
        pageType: "UNKNOWN", confidence: 0.4, evidence: ["payment page"],
        suggestedAction: "STOP_FOR_HUMAN", targetDescription: "",
        sensitiveContentVisible: true, humanRequired: true,
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.output.sensitiveContentVisible, true);
});

test("analysis may rank only supplied candidates", () => {
  assert.throws(() => validateRoleOutput("research_analysis", {
    clusters: [], rankedCandidates: [{ candidateId: "missing", score: 1, reason: "x" }],
    contentGaps: [], summary: "summary",
  }, { candidates: [{ candidateId: "known" }] }), /unknown/);
});

test("comment drafting requires human request", () => {
  assert.throws(() => validateRoleOutput("comment_assistant", {
    draft: "Thanks", rationale: "Relevant", requiresFactCheck: false,
  }, { humanRequested: false }), /human request/);
});

test("AI roles reject recommendations for external interaction", () => {
  assert.throws(() => validateRoleOutput("topic_planner", {
    intentClusters: [], rankedQueries: [], excludedTerms: [], rationale: "建议点赞相关笔记",
  }), /forbidden automation recommendation/);
});

test("automatic role uses cache without spending a second call", async () => {
  const root = await mkdtemp(join(tmpdir(), "xhs-ai-role-"));
  let calls = 0;
  const request = async () => {
    calls += 1;
    return { intentClusters: [], rankedQueries: ["topic"], excludedTerms: [], rationale: "seed" };
  };
  const options = {
    role: "topic_planner", input: { topic: "topic" }, cacheDir: join(root, "cache"),
    budgetPath: join(root, "budget.json"), model: "test-model", apiUrl: "test", apiKey: "test", request,
  };
  const first = await runAiRole(options);
  const second = await runAiRole(options);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
  const budget = JSON.parse(await readFile(join(root, "budget.json"), "utf8"));
  assert.equal(budget.automaticCalls, 1);
});
