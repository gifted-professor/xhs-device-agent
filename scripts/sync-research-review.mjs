import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const PENDING_STATUSES = new Set(["pending", "pending_review"]);
const REVIEW_SOURCES = new Set(["search", "suggestions", "trending", "recommended"]);
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RESEARCH_ROOT = path.join(PROJECT_ROOT, "data", "research");
const LOCAL_REVIEW_KEYS = new Set([
  "reviewId", "taskId", "topic", "candidateKey", "candidateId", "noteId",
  "title", "author", "mediaType", "aiScore", "aiReason", "reason", "status",
  "reviewStatus", "source", "keyword", "deviceAlias", "collectedAt",
]);
const LOCAL_REVIEW_TEXT_KEYS = Object.freeze([...LOCAL_REVIEW_KEYS].filter((key) => key !== "aiScore"));
export const APPROVED_REVIEW_FIELD_NAMES = Object.freeze([
  "Review ID", "Candidate key", "Task ID", "Topic", "Source", "Keyword",
  "Note title", "Public author", "Media type", "AI reason", "Review status",
  "Device alias", "Collected at",
]);
const SENSITIVE_VALUE_PATTERNS = Object.freeze([
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/u,
  /(?<![0-9A-F])(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}(?![0-9A-F])/iu,
  /(?<!\d)1[3-9]\d{9}(?!\d)/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
  /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /(?:^|[\s"'(])(?:[A-Za-z]:\\|\\\\|\/(?:sdcard|data|storage\/emulated)\/)/iu,
  /\bfile:\/\//iu,
  /(?:^|[\s"'(])(?:\.\.?[\\/]|data[\\/]research[\\/])/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:token|password|secret)\s*[:=]\s*\S+/iu,
]);

function scalarText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (Array.isArray(value) && value.length === 1) return scalarText(value[0]);
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.name === "string") return value.name.trim();
  }
  return "";
}

function reviewStatus(value, fallback = "pending_review") {
  const status = scalarText(value) || fallback;
  if (status.length > 80 || /[\u0000-\u001f\u007f]/u.test(status)) {
    throw new Error("Review status must be a short single-line value");
  }
  return PENDING_STATUSES.has(status.toLowerCase()) ? "pending_review" : status;
}

function isPending(value) {
  return PENDING_STATUSES.has(reviewStatus(value).toLowerCase());
}

function looksSensitive(value) {
  const text = String(value ?? "").trim();
  return text !== "" && SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(text));
}

function validatePublicText(name, value, maximum, { required = false } = {}) {
  const text = scalarText(value);
  if (required && !text) throw new Error(`${name} is required for external review sync`);
  if ([...text].length > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${name} must be a bounded single-line public value`);
  }
  if (looksSensitive(text)) throw new Error(`${name} looks like a direct identifier, credential, or local path`);
  return text;
}

function validateApprovedAliases(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("External review sync requires aliases approved by the local device mapping");
  }
  const approved = new Set();
  for (const value of values) {
    const alias = scalarText(value);
    if (!SAFE_ALIAS.test(alias) || alias.toLowerCase() === "unmapped"
        || /^(?:emulator-\d+|\d{6,}|[0-9a-f]{8,}|adb-[A-Za-z0-9._:-]{6,})$/iu.test(alias)
        || looksSensitive(alias)) {
      throw new Error("External review sync refused an alias that looks like a device, network, account, or credential identifier");
    }
    const key = alias.toLowerCase();
    if (approved.has(key)) throw new Error("External review sync requires unique approved aliases");
    approved.add(key);
  }
  return approved;
}

function validateLocalReviewShape(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Review queue line ${index + 1} must be an object`);
  }
  const unknown = Object.keys(record).filter((key) => !LOCAL_REVIEW_KEYS.has(key));
  if (unknown.length) throw new Error(`Review queue line ${index + 1} contains fields outside the closed local schema`);
  for (const key of LOCAL_REVIEW_TEXT_KEYS) {
    if (Object.hasOwn(record, key) && record[key] !== null && typeof record[key] !== "string") {
      throw new Error(`Review queue line ${index + 1} field ${key} must be text or null`);
    }
  }
  if (Object.hasOwn(record, "status") && Object.hasOwn(record, "reviewStatus")) {
    const status = reviewStatus(record.status);
    const explicit = reviewStatus(record.reviewStatus);
    if (status !== explicit) throw new Error(`Review queue line ${index + 1} has conflicting local statuses`);
  }
  if (Object.hasOwn(record, "aiScore")
      && (!Number.isFinite(record.aiScore) || record.aiScore < 0 || record.aiScore > 1)) {
    throw new Error(`Review queue line ${index + 1} has an invalid AI score`);
  }
  validatePublicText("Candidate note ID", record.noteId, 200);
  validatePublicText("Local review reason", record.reason, 500);
}

export function validateReviewSyncRecords(records, { taskId, approvedAliases }) {
  if (!SAFE_TASK_ID.test(String(taskId ?? ""))) throw new Error("Review queue path must contain a safe taskId");
  const approved = validateApprovedAliases(approvedAliases);
  let expectedTopic = null;
  return records.map((record, index) => {
    validateLocalReviewShape(record, index);
    const row = normalizeReviewRecord(record);
    row.reviewId = validatePublicText("Review ID", row.reviewId, 160, { required: true });
    row.candidateKey = validatePublicText("Candidate key", row.candidateKey, 160);
    row.candidateId = validatePublicText("Candidate ID", row.candidateId, 160);
    row.taskId = validatePublicText("Task ID", row.taskId, 80, { required: true });
    if (row.taskId !== taskId) throw new Error("Every review row taskId must match its trusted research directory");
    row.topic = validatePublicText("Topic", row.topic, 120, { required: true });
    if (expectedTopic === null) expectedTopic = row.topic;
    if (row.topic !== expectedTopic) throw new Error("Review queue must contain one consistent public topic");
    row.source = validatePublicText("Source", row.source, 20, { required: true });
    if (!REVIEW_SOURCES.has(row.source)) throw new Error("Review source is outside the public research source allowlist");
    row.keyword = validatePublicText("Keyword", row.keyword, 80);
    row.title = validatePublicText("Note title", row.title, 200);
    row.author = validatePublicText("Public author", row.author, 120);
    row.mediaType = validatePublicText("Media type", row.mediaType, 32, { required: true });
    if (!/^[A-Za-z0-9._-]+$/u.test(row.mediaType)) throw new Error("Media type must be a short public token");
    row.aiReason = validatePublicText("AI reason", row.aiReason, 500);
    row.reviewStatus = validatePublicText("Review status", row.reviewStatus, 80, { required: true });
    row.deviceAlias = validatePublicText("Device alias", row.deviceAlias, 64, { required: true });
    if (!SAFE_ALIAS.test(row.deviceAlias) || !approved.has(row.deviceAlias.toLowerCase())) {
      throw new Error("Review queue uses an alias that was not approved by the local device mapping");
    }
    row.collectedAt = validatePublicText("Collected at", row.collectedAt, 40);
    return row;
  });
}

async function resolveTrustedReviewSource(reviewPath, trustedResearchRoot = DEFAULT_RESEARCH_ROOT) {
  const [resolvedFile, resolvedRoot] = await Promise.all([
    realpath(path.resolve(reviewPath)),
    realpath(path.resolve(trustedResearchRoot)),
  ]);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Review sync accepts only trusted data/research task output");
  }
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[1] !== "human-review.jsonl" || !SAFE_TASK_ID.test(parts[0])) {
    throw new Error("Review path must be data/research/<taskId>/human-review.jsonl");
  }
  const info = await stat(resolvedFile);
  if (!info.isFile()) throw new Error("Review path must be a regular file");
  if (info.size > 4 * 1024 * 1024) throw new Error("Review queue exceeds the 4 MiB safety limit");
  return { path: resolvedFile, taskId: parts[0] };
}

async function readApprovedAliasesFile(filePath) {
  if (!filePath) throw new Error("Internal approved-alias file is required");
  const [resolvedFile, resolvedTemp] = await Promise.all([realpath(filePath), realpath(os.tmpdir())]);
  const relative = path.relative(resolvedTemp, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Internal approved-alias file must stay in the operating-system temporary directory");
  }
  const source = await readFile(resolvedFile, "utf8");
  if (Buffer.byteLength(source, "utf8") > 64 * 1024) throw new Error("Internal approved-alias file is too large");
  let values;
  try { values = JSON.parse(source); } catch { throw new Error("Internal approved-alias file is not valid JSON"); }
  validateApprovedAliases(values);
  return values.map(scalarText);
}

export function parseJsonLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at line ${index + 1}`); }
  });
}

export function normalizeReviewRecord(record) {
  const candidate = record.candidate || record;
  const candidateKey = scalarText(record.candidateKey ?? candidate.candidateKey ?? candidate.candidateId ?? candidate.noteId);
  const candidateId = scalarText(record.candidateId ?? candidate.candidateId ?? candidateKey);
  const reviewId = scalarText(record.reviewId ?? candidate.reviewId ?? candidateKey ?? candidateId);
  if (!reviewId) throw new Error("Review record is missing reviewId and candidateKey");
  return {
    reviewId,
    candidateKey: candidateKey || candidateId,
    candidateId: candidateId || candidateKey,
    taskId: scalarText(record.taskId || candidate.taskId),
    topic: scalarText(record.topic || candidate.topic),
    source: scalarText(candidate.source),
    keyword: scalarText(candidate.keyword),
    title: scalarText(candidate.title),
    author: scalarText(candidate.author),
    mediaType: scalarText(candidate.mediaType) || "unknown",
    aiReason: scalarText(record.aiReason || candidate.aiReason),
    reviewStatus: reviewStatus(record.reviewStatus ?? record.status),
    deviceAlias: scalarText(candidate.deviceAlias || record.deviceAlias),
    collectedAt: scalarText(candidate.collectedAt || record.collectedAt),
  };
}

function validatePrimaryFieldName(value) {
  const name = scalarText(value);
  if (!name || [...name].length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("Feishu primary field must be a bounded single-line name");
  }
  if (APPROVED_REVIEW_FIELD_NAMES.includes(name) && name !== "Review ID") {
    throw new Error("Feishu primary field conflicts with an approved review data field");
  }
  return name;
}

export function buildFields(record, primaryFieldName = "Candidate ID") {
  const primaryName = validatePrimaryFieldName(primaryFieldName);
  const fields = {
    "Review ID": record.reviewId,
    "Candidate key": record.candidateKey,
    "Task ID": record.taskId,
    "Topic": record.topic,
    "Source": record.source,
    "Keyword": record.keyword,
    "Note title": record.title,
    "Public author": record.author,
    "Media type": record.mediaType,
    "AI reason": record.aiReason,
    "Review status": record.reviewStatus,
    "Device alias": record.deviceAlias,
    "Collected at": record.collectedAt,
  };
  // The table primary column is the row identity even when an existing table
  // still calls that column "Candidate ID". reviewId prevents two independent
  // review requests for the same candidate from overwriting each other.
  fields[primaryName] = record.reviewId;
  return fields;
}

export function remoteRowsFromRecordList(records, primaryFieldName) {
  const fieldNames = records?.data?.fields || [];
  return (records?.data?.record_id_list || []).map((recordId, index) => {
    const values = records.data.data?.[index] || [];
    const mapped = Object.fromEntries(fieldNames.map((name, fieldIndex) => [name, values[fieldIndex]]));
    const explicitReviewId = scalarText(mapped["Review ID"]);
    const explicitCandidateKey = scalarText(mapped["Candidate key"]);
    const primaryValue = scalarText(mapped[primaryFieldName]);
    return {
      recordId,
      reviewId: explicitReviewId || (primaryFieldName === "Review ID" ? primaryValue : ""),
      candidateKey: explicitCandidateKey || (!explicitReviewId && !explicitCandidateKey ? primaryValue : ""),
      reviewStatus: scalarText(mapped["Review status"]),
    };
  });
}

export async function listAllRemoteReviewRows({ invoke, baseToken, tableId, primaryFieldName }) {
  const rows = [];
  const seenRecordIds = new Set();
  const pageSize = 200;
  let offset = 0;
  for (let page = 0; page < 1000; page += 1) {
    const projectedFields = [...new Set([primaryFieldName, "Review ID", "Candidate key", "Review status"])];
    const args = [
      "base", "+record-list", "--base-token", baseToken, "--table-id", tableId,
      ...projectedFields.flatMap((name) => ["--field-id", name]),
      "--as", "user", "--limit", String(pageSize), "--offset", String(offset), "--format", "json",
    ];
    const response = await invoke(args);
    const data = response?.data ?? {};
    const recordIds = Array.isArray(data.record_id_list) ? data.record_id_list : [];
    const valueRows = Array.isArray(data.data) ? data.data : [];
    if (recordIds.length !== valueRows.length) {
      throw new Error("Feishu review record and value counts differ; refusing to upload pending statuses");
    }
    for (const recordId of recordIds) {
      if (!recordId || seenRecordIds.has(recordId)) {
        throw new Error("Feishu review pagination returned an empty or repeated record; refusing to upload pending statuses");
      }
      seenRecordIds.add(recordId);
    }
    rows.push(...remoteRowsFromRecordList(response, primaryFieldName));
    if (recordIds.length < pageSize) return rows;
    offset += recordIds.length;
  }
  throw new Error("Feishu review pagination exceeded the safe page limit");
}

function uniqueIndex(rows, keyOf) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return new Map([...grouped].filter(([, matches]) => matches.length === 1).map(([key, matches]) => [key, matches[0]]));
}

function buildRemoteMatcher(localRows, remoteRows) {
  const byReviewId = uniqueIndex(remoteRows, (row) => row.reviewId);
  const reviewIdCounts = new Map();
  for (const row of remoteRows) {
    if (!row.reviewId) continue;
    reviewIdCounts.set(row.reviewId, (reviewIdCounts.get(row.reviewId) || 0) + 1);
  }
  for (const [reviewId, count] of reviewIdCounts) {
    if (count > 1) throw new Error(`Feishu contains duplicate Review ID: ${reviewId}`);
  }
  const legacyRows = remoteRows.filter((row) => !row.reviewId);
  const byCandidateKey = uniqueIndex(legacyRows, (row) => row.candidateKey);
  const localCandidateCounts = new Map();
  const legacyCandidateCounts = new Map();
  for (const row of localRows) {
    if (!row.candidateKey || byReviewId.has(row.reviewId)) continue;
    localCandidateCounts.set(row.candidateKey, (localCandidateCounts.get(row.candidateKey) || 0) + 1);
  }
  for (const row of legacyRows) {
    if (!row.candidateKey) continue;
    legacyCandidateCounts.set(row.candidateKey, (legacyCandidateCounts.get(row.candidateKey) || 0) + 1);
  }
  for (const [candidateKey, localCount] of localCandidateCounts) {
    const remoteCount = legacyCandidateCounts.get(candidateKey) || 0;
    if (remoteCount > 0 && (localCount > 1 || remoteCount > 1)) {
      throw new Error(`Ambiguous legacy Candidate key mapping: ${candidateKey}`);
    }
  }
  return (row) => {
    const exact = byReviewId.get(row.reviewId);
    if (exact) return exact;
    if (row.candidateKey && localCandidateCounts.get(row.candidateKey) === 1) return byCandidateKey.get(row.candidateKey) || null;
    return null;
  };
}

export function mergeReviewStatus(localStatus, remoteStatus, identity = "review") {
  const local = reviewStatus(localStatus);
  if (!scalarText(remoteStatus)) return local;
  const remote = reviewStatus(remoteStatus);
  if (local === remote) return local;
  if (isPending(local)) return remote;
  if (isPending(remote)) return local;
  throw new Error(`Conflicting finalized review statuses for ${identity}: local=${local}, feishu=${remote}`);
}

export function reconcileReviewStatuses(localRecords, remoteRows) {
  const normalized = localRecords.map(normalizeReviewRecord);
  const localReviewIds = new Set();
  for (const row of normalized) {
    if (localReviewIds.has(row.reviewId)) throw new Error(`Local review queue contains duplicate reviewId: ${row.reviewId}`);
    localReviewIds.add(row.reviewId);
  }
  const findRemote = buildRemoteMatcher(normalized, remoteRows);
  let pulled = 0;
  const matches = new Map();
  const records = localRecords.map((record, index) => {
    const local = normalized[index];
    const remote = findRemote(local);
    if (!remote) return record;
    matches.set(local.reviewId, remote);
    const merged = mergeReviewStatus(local.reviewStatus, remote.reviewStatus, local.reviewId);
    if (merged === local.reviewStatus) return record;
    pulled += 1;
    return { ...record, status: merged, reviewStatus: merged };
  });
  return { records, normalized: records.map(normalizeReviewRecord), matches, pulled };
}

async function invokeLarkJson(args) {
  const { stdout, stderr } = await execFile("lark-cli", args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const raw = `${stdout || ""}${stderr || ""}`;
  const start = raw.indexOf("{");
  if (start < 0) throw new Error(`lark-cli did not return JSON: ${raw.trim()}`);
  return JSON.parse(raw.slice(start));
}

async function writePayload(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value), "utf8");
}

async function writeJsonLinesAtomic(path, records) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function acquireReviewSyncLock(reviewPath) {
  const lockPath = `${reviewPath}.sync.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error?.code === "EEXIST") throw new Error("This review queue already has an active external sync");
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try { await handle.close(); } finally { await rm(lockPath, { force: true }); }
  };
}

export async function syncReviewQueue({
  reviewPath,
  baseToken,
  tableId,
  invoke = invokeLarkJson,
  approvedAliases,
  trustedResearchRoot = DEFAULT_RESEARCH_ROOT,
  payloadPath,
  payloadArgument,
}) {
  if (!reviewPath || !baseToken || !tableId) throw new Error("--review, research Base token, and table ID are required");
  if (payloadArgument && !payloadPath) throw new Error("A custom payload argument requires a matching payload path");
  const source = await resolveTrustedReviewSource(reviewPath, trustedResearchRoot);
  const releaseLock = await acquireReviewSyncLock(source.path);
  const ownsPayload = !payloadPath;
  const effectivePayloadPath = payloadPath
    ? path.resolve(payloadPath)
    : path.join(os.tmpdir(), `xhs-review-payload-${process.pid}-${randomUUID()}.json`);
  const effectivePayloadArgument = payloadArgument ?? `@${effectivePayloadPath}`;
  try {
    let localRecords = parseJsonLines(await readFile(source.path, "utf8"));
    if (localRecords.length > 1000) throw new Error("Review queue exceeds the 1000-row safety limit");
    let normalized = validateReviewSyncRecords(localRecords, { taskId: source.taskId, approvedAliases });
    if (normalized.length === 0) return { synced: 0, statusesPulled: 0 };

    const fieldList = await invoke(["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "--as", "user", "--format", "json"]);
    const fields = fieldList?.data?.fields || [];
    const primaryName = validatePrimaryFieldName(fields.find((field) => field.is_primary)?.name || fields[0]?.name || "Candidate ID");
    const remoteRows = await listAllRemoteReviewRows({ invoke, baseToken, tableId, primaryFieldName: primaryName });
    const reconciled = reconcileReviewStatuses(localRecords, remoteRows);
    localRecords = reconciled.records;
    normalized = validateReviewSyncRecords(localRecords, { taskId: source.taskId, approvedAliases });
    if (reconciled.pulled > 0) await writeJsonLinesAtomic(source.path, localRecords);

    const existingNames = new Set(fields.map((field) => field.name));
    for (const name of APPROVED_REVIEW_FIELD_NAMES) {
      if (existingNames.has(name)) continue;
      await writePayload(effectivePayloadPath, { name, type: "text" });
      await invoke(["base", "+field-create", "--base-token", baseToken, "--table-id", tableId, "--json", effectivePayloadArgument, "--as", "user", "--format", "json"]);
    }

    for (const row of normalized) {
      await writePayload(effectivePayloadPath, buildFields(row, primaryName));
      const args = ["base", "+record-upsert", "--base-token", baseToken, "--table-id", tableId, "--json", effectivePayloadArgument, "--as", "user", "--format", "json"];
      const matched = reconciled.matches.get(row.reviewId);
      if (matched) args.push("--record-id", matched.recordId);
      await invoke(args);
    }
    return { synced: normalized.length, statusesPulled: reconciled.pulled };
  } finally {
    try {
      if (ownsPayload) await rm(effectivePayloadPath, { force: true });
    } finally {
      await releaseLock();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(["--review", "--approved-aliases-file", "--confirm-external-sync"]);
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option)) throw new Error(`Unknown review sync option: ${option}`);
    if (parsed.has(option)) throw new Error(`${option} may be provided only once`);
    if (option === "--confirm-external-sync") {
      parsed.set(option, true);
      continue;
    }
    index += 1;
    if (index >= args.length || args[index].startsWith("--")) throw new Error(`${option} requires a value`);
    parsed.set(option, args[index]);
  }
  if (parsed.get("--confirm-external-sync") !== true) {
    throw new Error("Direct review sync requires --confirm-external-sync");
  }
  const result = await syncReviewQueue({
    reviewPath: parsed.get("--review"),
    approvedAliases: await readApprovedAliasesFile(parsed.get("--approved-aliases-file")),
    baseToken: process.env.LARK_RESEARCH_BASE_TOKEN || "",
    tableId: process.env.LARK_RESEARCH_TABLE_ID || "",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("sync-research-review.mjs")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
