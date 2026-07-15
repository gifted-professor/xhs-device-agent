import { createHash, randomUUID } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const MACHINE_NUMBER = /^\d{2}$/u;
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "batchId", "mode", "maxParallel", "runs"]);
const RUN_KEYS = new Set(["machine", "taskId", "count"]);
const GLOBAL_SAFETY_CODES = new Set([
  "SENSITIVE_PAGE",
  "IDENTITY_DRIFT",
  "LOGIN_OR_CHALLENGE",
  "PERMISSION_PAGE",
  "PAYMENT_PAGE",
  "PRIVATE_PAGE",
  "RISK_CONTROL",
]);
const BATCH_INTEGRITY_CODES = new Set([
  "BATCH_PARENT_LOST",
  "BATCH_SPEC_CONFLICT",
  "BATCH_EVIDENCE_FAILED",
  "BATCH_UNEXPECTED_INTERACTION",
  "BATCH_START_TIMEOUT",
  "BATCH_SYSTEMIC_FAILURE",
]);

export const FEED_BATCH_V1_POLICY = Object.freeze({
  capabilityProfile: "feed_batch_read_only_v1",
  waitAllowlist: Object.freeze([
    "parent_lease",
    "lock_barrier",
    "preflight_barrier",
    "ui_stable",
    "foreground_focus",
  ]),
  recoveryAllowlist: Object.freeze([
    "bounded_back_to_feed",
    "semantic_home_tab",
    "bounded_xhs_relaunch",
    "skip_unsupported_detail",
  ]),
});

export class FeedBatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FeedBatchError";
    this.code = code;
    Object.assign(this, details);
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", label + " must be an object");
  }
}

function assertExactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", label + " contains unknown fields: " + unknown.join(", "));
  }
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new FeedBatchError(
      "INVALID_BATCH_SPEC",
      label + " must be an integer from " + minimum + " to " + maximum,
    );
  }
  return number;
}

export function normalizeFeedBatchSpec(input) {
  assertPlainObject(input, "batch spec");
  assertExactKeys(input, TOP_LEVEL_KEYS, "batch spec");
  if (input.schemaVersion !== 1) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "schemaVersion must be 1");
  }
  const batchId = String(input.batchId ?? "").trim();
  if (!SAFE_ID.test(batchId)) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "batchId must be 3-80 safe characters");
  }
  if (input.mode !== "feed_read_only") {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "mode must be feed_read_only");
  }
  if (!Array.isArray(input.runs) || input.runs.length < 1 || input.runs.length > 2) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "runs must contain one or two explicit machines");
  }
  const maxParallel = boundedInteger(input.maxParallel ?? input.runs.length, "maxParallel", 1, 2);
  if (maxParallel > input.runs.length) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "maxParallel cannot exceed the number of runs");
  }
  if (maxParallel !== input.runs.length) {
    throw new FeedBatchError(
      "INVALID_BATCH_SPEC",
      "V1 requires maxParallel to equal the number of explicit runs",
    );
  }
  const runs = input.runs.map((entry, index) => {
    assertPlainObject(entry, "runs[" + index + "]");
    assertExactKeys(entry, RUN_KEYS, "runs[" + index + "]");
    const machine = String(entry.machine ?? "").trim();
    if (!MACHINE_NUMBER.test(machine)) {
      throw new FeedBatchError("INVALID_BATCH_SPEC", "runs[" + index + "].machine must be a two-digit number");
    }
    const taskId = String(entry.taskId ?? "").trim();
    if (!SAFE_ID.test(taskId)) {
      throw new FeedBatchError("INVALID_BATCH_SPEC", "runs[" + index + "].taskId must be 3-80 safe characters");
    }
    return Object.freeze({ machine, taskId, count: boundedInteger(entry.count, "runs[" + index + "].count", 1, 10) });
  });
  if (new Set(runs.map((entry) => entry.machine)).size !== runs.length) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "Each batch run must target a unique machine");
  }
  if (new Set(runs.map((entry) => entry.taskId)).size !== runs.length) {
    throw new FeedBatchError("INVALID_BATCH_SPEC", "Each batch run must use a unique taskId");
  }
  return Object.freeze({
    schemaVersion: 1,
    batchId,
    mode: "feed_read_only",
    maxParallel,
    runs: Object.freeze(runs),
  });
}

export function feedBatchSpecHash(input) {
  return createHash("sha256")
    .update(JSON.stringify(normalizeFeedBatchSpec(input)), "utf8")
    .digest("hex");
}

export function createBatchAttemptId(now = new Date(), suffix = randomUUID().slice(0, 8)) {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return stamp + "-" + String(suffix).replace(/[^A-Za-z0-9]/gu, "").slice(0, 12);
}

export function createBatchManifest(specInput, { createdAt = new Date().toISOString() } = {}) {
  const spec = normalizeFeedBatchSpec(specInput);
  return {
    schemaVersion: 1,
    batchId: spec.batchId,
    specHash: feedBatchSpecHash(spec),
    mode: spec.mode,
    maxParallel: spec.maxParallel,
    policy: FEED_BATCH_V1_POLICY,
    createdAt,
    runs: spec.runs.map((entry) => ({ ...entry })),
  };
}

export function classifyFeedBatchFailure(codeInput) {
  const code = String(codeInput ?? "UNKNOWN").toUpperCase();
  if (GLOBAL_SAFETY_CODES.has(code)) return "global_safety";
  if (BATCH_INTEGRITY_CODES.has(code)) return "batch_integrity";
  return "device_local";
}

export function buildBatchSummary({ manifest, attemptId, results = [], fuse = null, duplicate = false }) {
  const safeResults = results.map((entry) => ({
    machine: String(entry.machine),
    taskId: String(entry.taskId),
    status: String(entry.status ?? "failed"),
    viewedCount: Number(entry.viewedCount ?? 0),
    skippedCount: Number(entry.skippedCount ?? 0),
    failureSignature: entry.failureSignature ? String(entry.failureSignature) : null,
    summaryPath: entry.summaryPath ? String(entry.summaryPath) : null,
  }));
  let status;
  if (duplicate) status = "duplicate";
  else if (fuse?.category === "global_safety") status = "human_required";
  else if (fuse) status = "failed";
  else if (safeResults.length === manifest.runs.length && safeResults.every((entry) => entry.status === "completed")) status = "completed";
  else if (safeResults.some((entry) => entry.status === "completed")) status = "partial";
  else status = "failed";
  return {
    schemaVersion: 1,
    batchId: manifest.batchId,
    specHash: manifest.specHash,
    attemptId,
    status,
    duplicate,
    maxParallel: manifest.maxParallel,
    fuse: fuse ? {
      category: String(fuse.category),
      code: String(fuse.code),
      taskId: fuse.taskId ? String(fuse.taskId) : null,
    } : null,
    results: safeResults,
  };
}
