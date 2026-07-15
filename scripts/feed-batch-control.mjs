import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const READY_STAGES = new Set(["lock", "preflight"]);

export class FeedBatchControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FeedBatchControlError";
    this.code = code;
    Object.assign(this, details);
  }
}

function assertSafeId(value, label) {
  const text = String(value ?? "");
  if (!SAFE_ID.test(text)) throw new FeedBatchControlError("INVALID_BATCH_CONTROL", label + " is invalid");
  return text;
}

function parseJsonFile(filePath, code = "BATCH_CONTROL_CORRUPT") {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new FeedBatchControlError(code, path.basename(filePath) + " could not be read", { cause: error });
  }
}

export function batchControlPaths(batchRoot, attemptId) {
  const safeAttempt = assertSafeId(attemptId, "attemptId");
  const root = path.resolve(batchRoot);
  const attemptsRoot = path.join(root, "attempts");
  const attemptDir = path.join(attemptsRoot, safeAttempt);
  return Object.freeze({
    batchRoot: root,
    manifest: path.join(root, "manifest.json"),
    summary: path.join(root, "summary.json"),
    attemptsRoot,
    attemptDir,
    lease: path.join(attemptDir, "lease.json"),
    fuse: path.join(attemptDir, "fuse.json"),
    preflightGo: path.join(attemptDir, "preflight-go.json"),
    start: path.join(attemptDir, "start.json"),
    events: path.join(attemptDir, "events.jsonl"),
    attemptSummary: path.join(attemptDir, "summary.json"),
    lockReadyDir: path.join(attemptDir, "ready-lock"),
    preflightReadyDir: path.join(attemptDir, "ready-preflight"),
  });
}

export function writeJsonAtomicSync(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + process.pid + ".tmp";
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    renameSync(temporary, filePath);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeExclusiveJsonSync(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(filePath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n", "utf8");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function initializeBatchControl(batchRoot, attemptId) {
  const paths = batchControlPaths(batchRoot, attemptId);
  mkdirSync(paths.lockReadyDir, { recursive: true });
  mkdirSync(paths.preflightReadyDir, { recursive: true });
  return paths;
}

export function writeManifestOnce(paths, manifest) {
  if (writeExclusiveJsonSync(paths.manifest, manifest)) return { created: true, manifest };
  const existing = parseJsonFile(paths.manifest, "BATCH_MANIFEST_CORRUPT");
  if (existing.batchId !== manifest.batchId || existing.specHash !== manifest.specHash) {
    throw new FeedBatchControlError("BATCH_SPEC_CONFLICT", "batchId already exists with a different specification");
  }
  return { created: false, manifest: existing };
}

export function writeBatchLease(paths, { attemptId, parentPid = process.pid, updatedAt = new Date().toISOString() }) {
  writeJsonAtomicSync(paths.lease, {
    schemaVersion: 1,
    attemptId: assertSafeId(attemptId, "attemptId"),
    parentPid: Number(parentPid),
    updatedAt,
  });
}

export function markBatchWorkerReady(paths, { stage, taskId, machine, at = new Date().toISOString() }) {
  if (!READY_STAGES.has(stage)) throw new FeedBatchControlError("INVALID_BATCH_CONTROL", "ready stage is invalid");
  const safeTaskId = assertSafeId(taskId, "taskId");
  const directory = stage === "lock" ? paths.lockReadyDir : paths.preflightReadyDir;
  const filePath = path.join(directory, safeTaskId + ".json");
  writeJsonAtomicSync(filePath, { schemaVersion: 1, stage, taskId: safeTaskId, machine: String(machine), at });
  return filePath;
}

export function releaseBatchBarrier(paths, stage, at = new Date().toISOString()) {
  const filePath = stage === "preflight" ? paths.preflightGo : stage === "start" ? paths.start : null;
  if (!filePath) throw new FeedBatchControlError("INVALID_BATCH_CONTROL", "barrier stage is invalid");
  if (!writeExclusiveJsonSync(filePath, { schemaVersion: 1, stage, at })) {
    throw new FeedBatchControlError("BATCH_BARRIER_ALREADY_RELEASED", stage + " barrier was already released");
  }
}

export function tripBatchFuse(paths, {
  attemptId,
  category,
  code,
  taskId = null,
  at = new Date().toISOString(),
}) {
  const value = {
    schemaVersion: 1,
    attemptId: assertSafeId(attemptId, "attemptId"),
    category: String(category),
    code: String(code),
    taskId: taskId ? assertSafeId(taskId, "taskId") : null,
    at,
  };
  if (writeExclusiveJsonSync(paths.fuse, value)) return { created: true, fuse: value };
  return { created: false, fuse: parseJsonFile(paths.fuse) };
}

export function readBatchFuse(paths) {
  return existsSync(paths.fuse) ? parseJsonFile(paths.fuse) : null;
}

export function assertBatchControlActiveSync(paths, {
  attemptId,
  requireStart = false,
  nowMs = Date.now(),
  staleAfterMs = 15000,
} = {}) {
  const fuse = readBatchFuse(paths);
  if (fuse) {
    throw new FeedBatchControlError("BATCH_FUSED", "Batch fuse is active", { fuse });
  }
  if (!existsSync(paths.lease)) {
    throw new FeedBatchControlError("BATCH_PARENT_LOST", "Batch parent lease is missing");
  }
  const lease = parseJsonFile(paths.lease);
  if (lease.attemptId !== assertSafeId(attemptId, "attemptId")) {
    throw new FeedBatchControlError("BATCH_PARENT_LOST", "Batch parent lease belongs to a different attempt");
  }
  const updatedAt = Date.parse(lease.updatedAt);
  if (!Number.isFinite(updatedAt) || nowMs - updatedAt > staleAfterMs) {
    throw new FeedBatchControlError("BATCH_PARENT_LOST", "Batch parent lease is stale");
  }
  if (requireStart && !existsSync(paths.start)) {
    throw new FeedBatchControlError("BATCH_NOT_STARTED", "Batch start barrier has not been released");
  }
  return { lease };
}
