import { createHash, randomUUID } from "node:crypto";

const DEFAULT_REQUEST_LIMIT = 20 * 1024 * 1024;
const DEFAULT_IMAGE_LIMIT = 12 * 1024 * 1024;
const disabledAttempts = new Map();

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && expected.slice().sort().every((key, index) => keys[index] === key);
}

function unknown(degradation, details = {}) {
  return {
    status: "unknown",
    result: { count: null, countKind: "unknown", confidence: 0 },
    degradation,
    ...details,
  };
}

function validateExecution(execution) {
  invariant(exactKeys(execution, ["planHash", "attemptId", "stepId"]), "execution binding is invalid");
  invariant(/^[a-f0-9]{64}$/u.test(execution.planHash), "planHash is invalid");
  invariant(/^attempt-[a-f0-9]{16}$/u.test(execution.attemptId), "attemptId is invalid");
  invariant(/^m[0-9]{2}\.s[0-9]{3}$/u.test(execution.stepId), "stepId is invalid");
}

function validateArtifact(artifact, maximum) {
  invariant(artifact && typeof artifact === "object", "artifact is required");
  const fields = ["artifactId", "mediaType", "sha256", "byteLength", "width", "height", "regionKind", "base64"];
  for (const field of fields) invariant(Object.hasOwn(artifact, field), `artifact.${field} is required`);
  invariant(/^artifact-[a-f0-9]{16}$/u.test(artifact.artifactId), "artifact ID is invalid");
  invariant(["image/png", "image/jpeg"].includes(artifact.mediaType), "artifact media type is invalid");
  invariant(/^[a-f0-9]{64}$/u.test(artifact.sha256), "artifact hash is invalid");
  invariant(Number.isSafeInteger(artifact.byteLength) && artifact.byteLength > 0 && artifact.byteLength <= maximum, "artifact byte limit exceeded");
  invariant(Number.isSafeInteger(artifact.width) && artifact.width > 0 && artifact.width <= 10000, "artifact width is invalid");
  invariant(Number.isSafeInteger(artifact.height) && artifact.height > 0 && artifact.height <= 10000, "artifact height is invalid");
  invariant(artifact.regionKind === "comment_counter", "artifact region is invalid");
  invariant(typeof artifact.base64 === "string" && /^[A-Za-z0-9+/]+={0,2}$/u.test(artifact.base64), "artifact base64 is invalid");
  const decoded = Buffer.from(artifact.base64, "base64");
  invariant(decoded.length === artifact.byteLength, "artifact byte length mismatch");
  invariant(createHash("sha256").update(decoded).digest("hex") === artifact.sha256, "artifact hash mismatch");
}

function requestArtifact(artifact) {
  return Object.fromEntries(["artifactId", "mediaType", "sha256", "byteLength", "width", "height", "regionKind", "base64"].map((key) => [key, artifact[key]]));
}

function validateConfig(config) {
  invariant(config && typeof config === "object", "local CPA configuration is unavailable");
  const endpoint = new URL(config.endpoint);
  invariant(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, "local CPA endpoint is invalid");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
  invariant(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback), "local CPA endpoint must use HTTPS or loopback HTTP");
  invariant(typeof config.token === "string" && config.token.length > 0 && !/[\r\n]/u.test(config.token), "local CPA token is invalid");
  const maxRequestBytes = config.maxRequestBytes ?? DEFAULT_REQUEST_LIMIT;
  const maxImageBytes = config.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;
  invariant(Number.isSafeInteger(maxRequestBytes) && maxRequestBytes > 0 && maxRequestBytes <= 32 * 1024 * 1024, "local CPA request limit is invalid");
  invariant(Number.isSafeInteger(maxImageBytes) && maxImageBytes > 0 && maxImageBytes <= 20 * 1024 * 1024, "local CPA image limit is invalid");
  const providerHardTimeoutMs = config.providerHardTimeoutMs ?? 45_000;
  invariant(Number.isSafeInteger(providerHardTimeoutMs) && providerHardTimeoutMs > 0 && providerHardTimeoutMs <= 120_000, "provider timeout is invalid");
  return { endpoint: endpoint.toString(), token: config.token, maxRequestBytes, maxImageBytes, providerHardTimeoutMs };
}

function defaultLocalConfig() {
  return {
    endpoint: process.env.XHS_CPA_ENDPOINT,
    token: process.env.XHS_CPA_TOKEN,
    providerHardTimeoutMs: process.env.XHS_CPA_PROVIDER_TIMEOUT_MS ? Number(process.env.XHS_CPA_PROVIDER_TIMEOUT_MS) : undefined,
  };
}

function validateResponse(value, { requestId, artifactSha256 }) {
  invariant(exactKeys(value, ["schemaVersion", "requestId", "artifactSha256", "status", "result", "provider"]), "CPA response fields are invalid");
  invariant(value.schemaVersion === "cpa-comment-count/v1", "CPA response schema is invalid");
  invariant(value.requestId === requestId, "CPA response request binding mismatch");
  invariant(value.artifactSha256 === artifactSha256, "CPA response artifact binding mismatch");
  invariant(["ok", "unknown"].includes(value.status), "CPA response status is invalid");
  invariant(exactKeys(value.result, ["count", "countKind", "confidence"]), "CPA result fields are invalid");
  invariant(["exact", "lower_bound", "unknown"].includes(value.result.countKind), "CPA count kind is invalid");
  invariant(Number.isFinite(value.result.confidence) && value.result.confidence >= 0 && value.result.confidence <= 1, "CPA confidence is invalid");
  if (value.status === "unknown") {
    invariant(value.result.count === null && value.result.countKind === "unknown" && value.result.confidence === 0, "CPA unknown result is invalid");
  } else {
    invariant(Number.isSafeInteger(value.result.count) && value.result.count >= 0 && value.result.count <= 1_000_000_000, "CPA count is invalid");
    invariant(value.result.countKind !== "unknown", "CPA ok count kind is invalid");
  }
  invariant(exactKeys(value.provider, ["adapterId", "modelId"]), "CPA provider fields are invalid");
  for (const field of ["adapterId", "modelId"]) invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(value.provider[field]), `CPA provider ${field} is invalid`);
  return structuredClone(value);
}

export async function analyzeCpa(input, dependencies = {}) {
  const artifact = input?.artifact;
  try {
    invariant(input?.role === "comment_count", "unsupported CPA role");
    validateExecution(input.execution);
    invariant(input.runtime && Number.isSafeInteger(input.runtime.cpaWorkflowSoftTimeoutMs) && input.runtime.cpaWorkflowSoftTimeoutMs > 0, "CPA workflow timeout is invalid");
    invariant(input.gate && typeof input.gate.assertFastGate === "function", "CPA fast gate is required");
    input.gate.assertFastGate({ stepId: input.execution.stepId });

    if (disabledAttempts.has(input.execution.attemptId)) return unknown("authentication_disabled", { authentication: disabledAttempts.get(input.execution.attemptId) });

    const loadLocalConfig = dependencies.loadLocalConfig ?? defaultLocalConfig;
    const config = validateConfig(await loadLocalConfig());
    invariant(input.runtime.cpaWorkflowSoftTimeoutMs < config.providerHardTimeoutMs, "CPA workflow timeout must be below provider timeout");
    validateArtifact(artifact, config.maxImageBytes);

    const requestId = (dependencies.requestId ?? randomUUID)();
    invariant(/^[a-f0-9-]{36}$/u.test(requestId), "CPA request ID is invalid");
    const request = {
      schemaVersion: "cpa-request/v1",
      requestId,
      role: "comment_count",
      execution: structuredClone(input.execution),
      artifact: requestArtifact(artifact),
    };
    const body = JSON.stringify(request);
    invariant(Buffer.byteLength(body, "utf8") <= config.maxRequestBytes, "CPA request body exceeds configured limit");

    const controller = new AbortController();
    const setTimer = dependencies.setTimer ?? setTimeout;
    const clearTimer = dependencies.clearTimer ?? clearTimeout;
    const timer = setTimer(() => controller.abort("workflow_soft_timeout"), input.runtime.cpaWorkflowSoftTimeoutMs);
    let response;
    try {
      response = await (dependencies.fetchImpl ?? fetch)(config.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json; charset=utf-8",
          "content-length": String(Buffer.byteLength(body, "utf8")),
          "idempotency-key": requestId,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError") return unknown("workflow_soft_timeout");
      return unknown("network_error");
    } finally {
      clearTimer(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        const reason = response.status === 401 ? "unauthorized" : "scope_forbidden";
        disabledAttempts.set(input.execution.attemptId, reason);
        return unknown("authentication_degraded", { authentication: reason });
      }
      return unknown(`http_${response.status}`);
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase();
    if (mediaType !== "application/json") return unknown("invalid_response");
    let payload;
    try {
      payload = JSON.parse(await response.text());
      return validateResponse(payload, { requestId, artifactSha256: artifact.sha256 });
    } catch {
      return unknown("invalid_response");
    }
  } finally {
    await artifact?.cleanup?.();
  }
}
