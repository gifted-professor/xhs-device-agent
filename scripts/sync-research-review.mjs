import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const execFile = promisify(execFileCallback);
const PENDING_STATUSES = new Set(["pending", "pending_review"]);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

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

export function buildFields(record, primaryFieldName = "Candidate ID") {
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
  fields[primaryFieldName] = record.reviewId;
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
  const seenTokens = new Set();
  let pageToken = "";
  for (let page = 0; page < 1000; page += 1) {
    const args = ["base", "+record-list", "--base-token", baseToken, "--table-id", tableId, "--as", "user", "--limit", "500", "--format", "json"];
    if (pageToken) args.push("--page-token", pageToken);
    const response = await invoke(args);
    rows.push(...remoteRowsFromRecordList(response, primaryFieldName));
    const data = response?.data ?? {};
    const hasExplicitMore = Object.hasOwn(data, "has_more") || Object.hasOwn(data, "hasMore");
    const hasMore = data.has_more === true || data.hasMore === true;
    const nextToken = scalarText(data.page_token ?? data.pageToken ?? data.next_page_token ?? data.nextPageToken);
    const pageSize = Array.isArray(data.record_id_list) ? data.record_id_list.length : 0;
    if (!hasMore && !nextToken) {
      if (pageSize >= 500 && !hasExplicitMore) {
        throw new Error("Feishu record listing did not prove that the 500-row page is complete; refusing to overwrite review statuses");
      }
      return rows;
    }
    if (!nextToken || seenTokens.has(nextToken)) {
      throw new Error("Feishu review pagination is incomplete or repeated; refusing to upload pending statuses");
    }
    seenTokens.add(nextToken);
    pageToken = nextToken;
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

async function writePayload(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
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

export async function syncReviewQueue({
  reviewPath,
  baseToken,
  tableId,
  invoke = invokeLarkJson,
  payloadPath = resolve("data/lark_payloads/research-review.json"),
  payloadArgument = "@data/lark_payloads/research-review.json",
}) {
  if (!reviewPath || !baseToken || !tableId) throw new Error("--review, research Base token, and table ID are required");
  const resolvedReviewPath = resolve(reviewPath);
  let localRecords = parseJsonLines(await readFile(resolvedReviewPath, "utf8"));
  localRecords.map(normalizeReviewRecord);

  const fieldList = await invoke(["base", "+field-list", "--base-token", baseToken, "--table-id", tableId, "--as", "user", "--format", "json"]);
  const fields = fieldList?.data?.fields || [];
  const primaryName = fields.find((field) => field.is_primary)?.name || fields[0]?.name || "Candidate ID";
  const remoteRows = await listAllRemoteReviewRows({ invoke, baseToken, tableId, primaryFieldName: primaryName });
  const reconciled = reconcileReviewStatuses(localRecords, remoteRows);
  localRecords = reconciled.records;
  if (reconciled.pulled > 0) await writeJsonLinesAtomic(resolvedReviewPath, localRecords);

  const requiredFields = ["Review ID", "Candidate key", "Task ID", "Topic", "Source", "Keyword", "Note title", "Public author", "Media type", "AI reason", "Review status", "Device alias", "Collected at"];
  const existingNames = new Set(fields.map((field) => field.name));
  for (const name of requiredFields) {
    if (existingNames.has(name)) continue;
    await writePayload(payloadPath, { name, type: "text" });
    await invoke(["base", "+field-create", "--base-token", baseToken, "--table-id", tableId, "--json", payloadArgument, "--as", "user", "--format", "json"]);
  }

  for (const row of reconciled.normalized) {
    await writePayload(payloadPath, buildFields(row, primaryName));
    const args = ["base", "+record-upsert", "--base-token", baseToken, "--table-id", tableId, "--json", payloadArgument, "--as", "user", "--format", "json"];
    const matched = reconciled.matches.get(row.reviewId);
    if (matched) args.push("--record-id", matched.recordId);
    await invoke(args);
  }
  return { synced: reconciled.normalized.length, statusesPulled: reconciled.pulled };
}

async function main() {
  const result = await syncReviewQueue({
    reviewPath: arg("--review"),
    baseToken: arg("--base-token", process.env.LARK_RESEARCH_BASE_TOKEN || ""),
    tableId: arg("--table-id", process.env.LARK_RESEARCH_TABLE_ID || ""),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("sync-research-review.mjs")) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
