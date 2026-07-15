import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import test from "node:test";

import { analyzeCpa } from "../scripts/cpa-client.mjs";

const planHash = "a".repeat(64);
const imageBytes = Buffer.from("89504e470d0a1a0a", "hex");
const imageHash = createHash("sha256").update(imageBytes).digest("hex");

function artifact(overrides = {}) {
  let cleanups = 0;
  return {
    artifactId: `artifact-${imageHash.slice(0, 16)}`,
    mediaType: "image/png",
    sha256: imageHash,
    byteLength: imageBytes.length,
    width: 100,
    height: 40,
    regionKind: "comment_counter",
    base64: imageBytes.toString("base64"),
    async cleanup() { cleanups += 1; },
    cleanupCount() { return cleanups; },
    ...overrides,
  };
}

function input(currentArtifact = artifact()) {
  return {
    role: "comment_count",
    artifact: currentArtifact,
    execution: { planHash, attemptId: "attempt-0123456789abcdef", stepId: "m01.s001" },
    runtime: { cpaWorkflowSoftTimeoutMs: 1000 },
    gate: { assertFastGate() {} },
  };
}

function responseBody(requestId, overrides = {}) {
  return {
    schemaVersion: "cpa-comment-count/v1",
    requestId,
    artifactSha256: imageHash,
    status: "ok",
    result: { count: 99, countKind: "exact", confidence: 0.98 },
    provider: { adapterId: "openai-responses-v1", modelId: "vision-model-v1" },
    ...overrides,
  };
}

async function fakeServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/cpa/analyze`,
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

test("CPA sends one strict known-length authenticated request and validates hash echoes", async () => {
  let received;
  const server = await fakeServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responseBody(received.body.requestId)));
    });
  });
  const currentArtifact = artifact({ privatePath: "must-not-leak.png" });
  try {
    const result = await analyzeCpa(input(currentArtifact), {
      loadLocalConfig: async () => ({ endpoint: server.endpoint, token: "test-secret-token", maxRequestBytes: 20 * 1024 * 1024, maxImageBytes: 12 * 1024 * 1024 }),
      requestId: () => "01234567-89ab-cdef-0123-456789abcdef",
    });
    assert.equal(result.status, "ok");
    assert.equal(received.headers.authorization, "Bearer test-secret-token");
    assert.equal(Number(received.headers["content-length"]), Buffer.byteLength(JSON.stringify(received.body)));
    assert.equal(received.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(Object.keys(received.body).sort(), ["artifact", "execution", "requestId", "role", "schemaVersion"]);
    assert.deepEqual(Object.keys(received.body.artifact).sort(), ["artifactId", "base64", "byteLength", "height", "mediaType", "regionKind", "sha256", "width"]);
    assert.equal(JSON.stringify(received.body).includes("must-not-leak"), false);
    assert.equal(currentArtifact.cleanupCount(), 1);
  } finally {
    await server.close();
  }
});

test("CPA rejects unknown response fields, coordinates, actions, free text, wrong bindings, count kinds, and confidence", async () => {
  const invalid = [
    (body) => ({ ...body, extra: true }),
    (body) => ({ ...body, x: 4 }),
    (body) => ({ ...body, action: "tap" }),
    (body) => ({ ...body, text: "free prose" }),
    (body) => ({ ...body, schemaVersion: "other/v1" }),
    (body) => ({ ...body, requestId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
    (body) => ({ ...body, artifactSha256: "b".repeat(64) }),
    (body) => ({ ...body, result: { count: 5, countKind: "estimate", confidence: 0.9 } }),
    (body) => ({ ...body, result: { count: 5, countKind: "exact", confidence: 1.1 } }),
  ];
  for (const mutate of invalid) {
    const currentArtifact = artifact();
    const result = await analyzeCpa(input(currentArtifact), {
      loadLocalConfig: async () => ({ endpoint: "https://cpa.invalid/v1/cpa/analyze", token: "secret" }),
      requestId: () => "01234567-89ab-cdef-0123-456789abcdef",
      fetchImpl: async (_url, options) => new Response(JSON.stringify(mutate(responseBody("01234567-89ab-cdef-0123-456789abcdef"))), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(result.status, "unknown");
    assert.equal(result.degradation, "invalid_response");
    assert.equal(currentArtifact.cleanupCount(), 1);
  }
});

test("typed HTTP failures make one attempt and 401/403 disable CPA for the attempt", async () => {
  for (const status of [401, 403, 411, 413, 415, 422, 429, 502, 503, 504]) {
    let calls = 0;
    const attemptId = `attempt-${String(status).padStart(16, "0")}`;
    const currentInput = input(artifact());
    currentInput.execution.attemptId = attemptId;
    const dependencies = {
      loadLocalConfig: async () => ({ endpoint: "https://cpa.invalid/v1/cpa/analyze", token: "secret" }),
      requestId: () => "01234567-89ab-cdef-0123-456789abcdef",
      fetchImpl: async () => { calls += 1; return new Response("{}", { status }); },
    };
    const first = await analyzeCpa(currentInput, dependencies);
    assert.equal(first.status, "unknown");
    assert.equal(calls, 1);
    if (status === 401 || status === 403) {
      const secondInput = input(artifact());
      secondInput.execution.attemptId = attemptId;
      const second = await analyzeCpa(secondInput, { ...dependencies, fetchImpl: async () => { calls += 1; throw new Error("must not call"); } });
      assert.equal(second.degradation, "authentication_disabled");
      assert.equal(calls, 1);
    }
  }
});

test("no request begins after fuse and artifact cleanup still runs", async () => {
  let calls = 0;
  const currentArtifact = artifact();
  const currentInput = input(currentArtifact);
  currentInput.gate.assertFastGate = () => { throw new Error("GLOBAL_FUSE_OPEN"); };
  await assert.rejects(() => analyzeCpa(currentInput, {
    loadLocalConfig: async () => ({ endpoint: "https://cpa.invalid/v1/cpa/analyze", token: "secret" }),
    fetchImpl: async () => { calls += 1; },
  }), /GLOBAL_FUSE_OPEN/);
  assert.equal(calls, 0);
  assert.equal(currentArtifact.cleanupCount(), 1);
});

test("fake-clock soft timeout aborts one request before the provider ceiling and returns unknown", async () => {
  let calls = 0;
  let released = false;
  const currentArtifact = artifact();
  const result = await analyzeCpa(input(currentArtifact), {
    loadLocalConfig: async () => ({ endpoint: "https://cpa.invalid/v1/cpa/analyze", token: "secret", providerHardTimeoutMs: 45_000 }),
    requestId: () => "01234567-89ab-cdef-0123-456789abcdef",
    setTimer(callback, delay) { assert.equal(delay, 1000); callback(); return 1; },
    clearTimer() { released = true; },
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.degradation, "workflow_soft_timeout");
  assert.equal(calls, 1);
  assert.equal(released, true);
  assert.equal(currentArtifact.cleanupCount(), 1);
});

test("invalid artifact hashes and decoded-size overflow fail before HTTP", async () => {
  let calls = 0;
  for (const currentArtifact of [artifact({ sha256: "b".repeat(64) }), artifact({ byteLength: 12 * 1024 * 1024 + 1 })]) {
    await assert.rejects(() => analyzeCpa(input(currentArtifact), {
      loadLocalConfig: async () => ({ endpoint: "https://cpa.invalid/v1/cpa/analyze", token: "secret" }),
      fetchImpl: async () => { calls += 1; },
    }), /artifact/u);
  }
  assert.equal(calls, 0);
});
