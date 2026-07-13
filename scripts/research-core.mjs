import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESEARCH_STATUSES = Object.freeze([
  "completed",
  "partial",
  "human_required",
  "failed",
  "duplicate",
]);

const SOURCES = new Set(["search", "suggestions", "trending", "recommended"]);
const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "taskId", "mode", "topic", "seedKeywords", "sources",
  "deviceGroup", "commentMode", "interactionPolicy", "budgets", "aiPolicy",
]);
const BUDGET_LIMITS = Object.freeze({
  wallClockSeconds: [30, 3600],
  maxQueries: [1, 20],
  maxNotes: [1, 50],
  maxNotesPerQuery: [1, 15],
  maxResultScrollsPerQuery: [0, 10],
  maxNoteScrolls: [0, 8],
  maxCommentPanels: [0, 15],
  maxCommentsPerNote: [0, 20],
  maxNoNewScrolls: [1, 4],
});
const AI_KEYS = new Set(["topicPlanner", "pageFallback", "resultAnalysis", "maxAutomaticCalls"]);
const SAFE_INTERACTION_KEYS = new Set(["interactionPolicy", "commentMode", "maxCommentPanels", "maxCommentsPerNote"]);
const FORBIDDEN_KEY = /(likes?|favorites?|favourites?|collect|follows?|sendcomment|commentaction|messages?|directmessage|publish|delete|payments?|payaction|点赞|收藏|关注|评论发送|私信|发布|删除|支付|付款)/i;
const FORBIDDEN_EXACT = /^(?:like|likes|favorite|favourite|collect|follow|message|dm|publish|post|delete|pay|payment|send[_ -]?comment|comment[_ -]?send|点赞|收藏|关注|私信|发布|删除|支付|付款|发送评论|评论发送)$/i;
const FORBIDDEN_ACTION_VALUE = /^(?:like|likes|favorite|favourite|collect|follow|comment|reply|message|dm|publish|post|delete|pay|payment|点赞|收藏|关注|评论|回复|私信|发布|删除|支付|付款)$/i;
const FORBIDDEN_DIRECTIVE = /(?:自动|批量|请|去|帮我|执行|进行|需要|请求).{0,12}(?:点赞|收藏|关注|私信|发布|删除|支付|付款)|(?:自动|批量|请|去|帮我|执行|进行|需要|请求).{0,8}(?:发送|发表|回复|写).{0,4}评论|(?:请|帮我|自动|批量).{0,4}评论.{0,4}(?:这|该|笔记|帖子|内容)|(?:点赞|收藏|关注|私信|发布|删除|支付|付款).{0,8}(?:笔记|作者|账号|用户|帖子)|\b(?:auto(?:matically)?|batch|please|execute|perform|request)\b.{0,30}\b(?:like|favorite|favourite|follow|comment|message|dm|publish|delete|pay)\b|\b(?:like|favorite|favourite|follow|comment|message|dm|publish|delete|pay)\b.{0,12}\b(?:this|these|post|posts|note|notes|author|account|user)\b/i;

export class ResearchTaskError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ResearchTaskError";
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, code, message, details) {
  if (!condition) throw new ResearchTaskError(code, message, details);
}

function assertExactKeys(value, allowed, label) {
  assert(isObject(value), "INVALID_SCHEMA", `${label} must be an object`);
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !allowed.has(key));
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  assert(unknown.length === 0 && missing.length === 0, "INVALID_SCHEMA",
    `${label} has invalid keys`, { unknown, missing });
}

function validateUnpaddedString(value, minimum, maximum, label) {
  assert(typeof value === "string", "INVALID_SCHEMA", `${label} must be a string`);
  const length = [...value].length;
  assert(value === value.trim() && length >= minimum && length <= maximum,
    "INVALID_SCHEMA", `${label} must contain ${minimum}-${maximum} characters with no leading or trailing whitespace`);
  return value;
}

function findForbiddenRequest(value, key = "", pathName = "task") {
  if (key && !SAFE_INTERACTION_KEYS.has(key) && FORBIDDEN_KEY.test(key.replace(/[_-]/g, ""))) {
    return { path: pathName, value: key };
  }
  if (typeof value === "string") {
    const text = value.trim();
    const actionContext = /(?:actions?|commands?|operations?|engagement|互动|操作|动作)/i.test(key);
    if (FORBIDDEN_EXACT.test(text) || (actionContext && FORBIDDEN_ACTION_VALUE.test(text)) || FORBIDDEN_DIRECTIVE.test(text)) {
      return { path: pathName, value: text };
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenRequest(value[index], key, `${pathName}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const found = findForbiddenRequest(childValue, childKey, `${pathName}.${childKey}`);
      if (found) return found;
    }
  }
  return null;
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableHash(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function validateResearchTask(input) {
  assert(isObject(input), "INVALID_SCHEMA", "task must be an object");
  const forbidden = findForbiddenRequest(input);
  assert(!forbidden, "FORBIDDEN_INTERACTION", "task requests a forbidden external interaction", forbidden);
  assertExactKeys(input, TOP_LEVEL_KEYS, "task");
  assert(input.schemaVersion === 1, "INVALID_SCHEMA", "schemaVersion must equal 1");
  assert(typeof input.taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(input.taskId),
    "INVALID_SCHEMA", "taskId must be a safe 3-80 character identifier");
  assert(input.mode === "research_read_only", "INVALID_SCHEMA", "mode must be research_read_only");
  assert(input.interactionPolicy === "human_final", "INVALID_SCHEMA", "interactionPolicy must be human_final");
  assert(["none", "metadata", "deidentified_snippets"].includes(input.commentMode),
    "INVALID_SCHEMA", "commentMode must be none, metadata, or deidentified_snippets");
  const topic = validateUnpaddedString(input.topic, 1, 120, "topic");
  assert(Array.isArray(input.seedKeywords) && input.seedKeywords.length <= 12,
    "INVALID_SCHEMA", "seedKeywords must contain no more than 12 values");
  const seedKeywords = input.seedKeywords.map((keyword) =>
    validateUnpaddedString(keyword, 1, 80, "each seed keyword"));
  assert(new Set(seedKeywords).size === seedKeywords.length,
    "INVALID_SCHEMA", "seedKeywords must contain unique values");
  assert(Array.isArray(input.sources) && input.sources.length >= 1 && input.sources.length <= SOURCES.size,
    "INVALID_SCHEMA", "sources must be a non-empty array");
  assert(new Set(input.sources).size === input.sources.length && input.sources.every((source) => SOURCES.has(source)),
    "INVALID_SCHEMA", "sources may only contain search, suggestions, trending, and recommended");
  const deviceGroup = validateUnpaddedString(input.deviceGroup, 1, 40, "deviceGroup");
  assertExactKeys(input.budgets, new Set(Object.keys(BUDGET_LIMITS)), "budgets");
  for (const [name, [minimum, maximum]] of Object.entries(BUDGET_LIMITS)) {
    const value = input.budgets[name];
    assert(Number.isInteger(value) && value >= minimum && value <= maximum,
      "INVALID_SCHEMA", `${name} must be an integer from ${minimum} through ${maximum}`);
  }
  assertExactKeys(input.aiPolicy, AI_KEYS, "aiPolicy");
  for (const key of ["topicPlanner", "pageFallback", "resultAnalysis"]) {
    assert(typeof input.aiPolicy[key] === "boolean", "INVALID_SCHEMA", `${key} must be boolean`);
  }
  assert(Number.isInteger(input.aiPolicy.maxAutomaticCalls) && input.aiPolicy.maxAutomaticCalls >= 0 && input.aiPolicy.maxAutomaticCalls <= 4,
    "INVALID_SCHEMA", "maxAutomaticCalls must be an integer from 0 through 4");

  return {
    ...input,
    topic,
    seedKeywords,
    sources: [...input.sources],
    deviceGroup,
    budgets: { ...input.budgets },
    aiPolicy: { ...input.aiPolicy },
  };
}

function normalizeAlias(device, index) {
  const alias = typeof device === "string" ? device : device?.alias;
  assert(typeof alias === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(alias),
    "INVALID_PROVIDER", `device ${index} needs a safe alias`);
  return alias;
}

export function buildWorkUnits(taskInput, deviceAliases) {
  const task = validateResearchTask(taskInput);
  const aliases = [...new Set(deviceAliases)].sort().slice(0, 3);
  assert(aliases.length > 0, "NO_DEVICES", "at least one device alias is required");
  const keywords = [...new Set([task.topic, ...task.seedKeywords].map((item) => item.trim()))]
    .slice(0, task.budgets.maxQueries);
  const units = [];
  for (const source of task.sources) {
    const sourceKeywords = ["trending", "recommended"].includes(source) ? [task.topic] : keywords;
    for (const keyword of sourceKeywords) {
      const ordinal = units.length;
      const unitId = stableHash(`${task.taskId}\u0000${source}\u0000${keyword}`).slice(0, 20);
      const index = Number.parseInt(stableHash(`${source}\u0000${keyword}`).slice(0, 8), 16) % aliases.length;
      units.push({ unitId, ordinal, source, keyword, assignedDevice: aliases[index], reassignCount: 0 });
    }
  }
  return units;
}

function canonicalText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function ngrams(value, size = 3) {
  const text = canonicalText(value);
  if (!text) return new Set();
  if (text.length <= size) return new Set([text]);
  const result = new Set();
  for (let index = 0; index <= text.length - size; index += 1) result.add(text.slice(index, index + size));
  return result;
}

function similarity(left, right) {
  const a = ngrams(left);
  const b = ngrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function normalizeCandidate(candidate, provenance = {}) {
  assert(isObject(candidate), "INVALID_PROVIDER", "candidate must be an object");
  const noteId = String(candidate.noteId ?? candidate.candidateId ?? "").trim();
  const title = String(candidate.title ?? "").trim();
  const author = String(candidate.author ?? "").trim();
  const mediaType = String(candidate.mediaType ?? "unknown").trim().toLowerCase();
  assert(noteId || title, "INVALID_PROVIDER", "candidate needs noteId/candidateId or title");
  const fallback = stableHash(`${canonicalText(author)}\u0000${canonicalText(title)}\u0000${canonicalText(mediaType)}`);
  return {
    candidateId: String(candidate.candidateId ?? (noteId || fallback.slice(0, 20))),
    noteId: noteId || null,
    author,
    title,
    mediaType,
    source: String(candidate.source ?? provenance.source ?? ""),
    keyword: String(candidate.keyword ?? provenance.keyword ?? ""),
    deviceAlias: String(candidate.deviceAlias ?? provenance.deviceAlias ?? ""),
    url: typeof candidate.url === "string" ? candidate.url : undefined,
    publicMetrics: isObject(candidate.publicMetrics) ? candidate.publicMetrics : undefined,
    commentMetadata: isObject(candidate.commentMetadata) ? candidate.commentMetadata : undefined,
    excerpt: typeof candidate.excerpt === "string" ? candidate.excerpt.slice(0, 500) : undefined,
    _fallback: fallback,
  };
}

export function dedupeCandidates(input) {
  const candidates = input.map((item) => normalizeCandidate(item));
  const groups = [];
  for (const candidate of candidates) {
    let group = null;
    if (candidate.noteId) group = groups.find((entry) => entry.item.noteId === candidate.noteId);
    if (!group) {
      group = groups.find((entry) => !(entry.item.noteId && candidate.noteId) && (
        entry.item._fallback === candidate._fallback ||
        (canonicalText(entry.item.author) === canonicalText(candidate.author) &&
          canonicalText(entry.item.mediaType) === canonicalText(candidate.mediaType) &&
          similarity(entry.item.title, candidate.title) >= 0.92)
      ));
    }
    if (!group) {
      group = { item: candidate, sources: new Set(), keywords: new Set(), devices: new Set(), duplicateCount: 0 };
      groups.push(group);
    }
    group.duplicateCount += 1;
    if (candidate.source) group.sources.add(candidate.source);
    if (candidate.keyword) group.keywords.add(candidate.keyword);
    if (candidate.deviceAlias) group.devices.add(candidate.deviceAlias);
  }
  return groups.map(({ item, sources, keywords, devices, duplicateCount }) => {
    const { _fallback, ...clean } = item;
    return {
      ...clean,
      candidateId: clean.candidateId || _fallback.slice(0, 20),
      sources: [...sources].sort(),
      keywords: [...keywords].sort(),
      deviceAliases: [...devices].sort(),
      duplicateCount,
    };
  }).sort((a, b) => a.candidateId.localeCompare(b.candidateId));
}

function sanitizeReview(review, context, task) {
  assert(isObject(review), "INVALID_PROVIDER", "humanReview entry must be an object");
  const candidateKey = String(review.candidateKey ?? review.noteId ?? "").trim();
  const reason = String(review.reason ?? "Manual inspection requested").trim().slice(0, 500);
  const reviewId = stableHash(`${task.taskId}\u0000${candidateKey}\u0000${reason}\u0000${context.unitId}`).slice(0, 20);
  return {
    reviewId,
    taskId: task.taskId,
    topic: task.topic,
    candidateKey: candidateKey || null,
    noteId: typeof review.noteId === "string" ? review.noteId : null,
    title: typeof review.title === "string" ? review.title.slice(0, 200) : "",
    reason,
    status: "pending_review",
    source: context.source,
    keyword: context.keyword,
    deviceAlias: context.deviceAlias,
  };
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

function errorSignature(error) {
  return String(error?.failureSignature ?? error?.code ?? error?.name ?? "PROVIDER_FAILURE").slice(0, 200);
}

function normalizeResult(value) {
  const result = value ?? {};
  assert(isObject(result), "INVALID_PROVIDER", "executeWorkUnit must return an object");
  const status = result.status ?? "completed";
  assert(["completed", "partial", "human_required", "failed", "skipped"].includes(status),
    "INVALID_PROVIDER", `invalid provider result status: ${status}`);
  assert(result.candidates === undefined || Array.isArray(result.candidates), "INVALID_PROVIDER", "candidates must be an array");
  assert(result.humanReview === undefined || Array.isArray(result.humanReview), "INVALID_PROVIDER", "humanReview must be an array");
  return { ...result, status, candidates: result.candidates ?? [], humanReview: result.humanReview ?? [] };
}

/**
 * Provider contract:
 * listDevices({ deviceGroup, task }) -> [{ alias, online?, ...opaque }]
 * isDeviceOnline?({ device, deviceAlias, task, unit }) -> boolean
 * executeWorkUnit({ task, unit, device, deviceAlias, attempt }) ->
 *   { status, candidates, humanReview, failureSignature?, stopAll? }
 */
export async function runResearchTask(taskInput, options = {}) {
  const task = validateResearchTask(taskInput);
  const identityTask = options.taskIdentity ? validateResearchTask(options.taskIdentity) : task;
  const modelCalls = options.modelCalls ?? 0;
  assert(Number.isInteger(modelCalls) && modelCalls >= 0 && modelCalls <= 4,
    "INVALID_AI_BUDGET", "modelCalls must be an integer from 0 through 4");
  const provider = options.provider;
  assert(provider && typeof provider.listDevices === "function" && typeof provider.executeWorkUnit === "function",
    "INVALID_PROVIDER", "provider must implement listDevices and executeWorkUnit");
  const summaryFileName = options.summaryFileName ?? "summary.json";
  assert(["summary.json", "core-summary.json"].includes(summaryFileName),
    "INVALID_ARGUMENT", "summaryFileName must be summary.json or core-summary.json");
  const outputRoot = path.resolve(options.outputRoot ?? path.join("data", "research"));
  const taskDirectory = path.join(outputRoot, task.taskId);
  const eventsDirectory = path.join(taskDirectory, "events");
  const paths = {
    taskDirectory,
    candidatesJsonl: path.join(taskDirectory, "candidates.jsonl"),
    humanReviewJsonl: path.join(taskDirectory, "human-review.jsonl"),
    summaryJson: path.join(taskDirectory, summaryFileName),
    checkpointJson: path.join(taskDirectory, "checkpoint.json"),
    eventsDirectory,
  };
  const artifacts = {
    candidates: paths.candidatesJsonl,
    reviewQueue: paths.humanReviewJsonl,
    summary: paths.summaryJson,
    candidatesJsonl: paths.candidatesJsonl,
    humanReviewJsonl: paths.humanReviewJsonl,
    summaryJson: paths.summaryJson,
  };
  const taskHash = stableHash(identityTask);
  const effectiveTaskHash = stableHash(task);
  if (await exists(paths.summaryJson)) {
    const original = JSON.parse(await readFile(paths.summaryJson, "utf8"));
    assert(original.taskHash === taskHash, "TASK_ID_CONFLICT", `taskId ${task.taskId} already exists with different input`);
    return { ...original, originalStatus: original.status, status: "duplicate", duplicate: true, paths, artifacts };
  }

  await mkdir(eventsDirectory, { recursive: true });
  let checkpoint = await exists(paths.checkpointJson)
    ? JSON.parse(await readFile(paths.checkpointJson, "utf8"))
    : null;
  if (checkpoint) {
    assert(isObject(checkpoint) && checkpoint.schemaVersion === 1 && isObject(checkpoint.units),
      "INVALID_CHECKPOINT", "research checkpoint is invalid");
    assert(checkpoint.taskHash === taskHash && checkpoint.effectiveTaskHash === effectiveTaskHash,
      "TASK_ID_CONFLICT", `taskId ${task.taskId} has a checkpoint for different input`);
  } else {
    checkpoint = {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash,
      effectiveTaskHash,
      units: {},
      deviceFailures: {},
    };
  }
  checkpoint.deviceFailures ??= {};
  let checkpointWrite = Promise.resolve();
  const persistCheckpoint = () => {
    const snapshot = JSON.parse(JSON.stringify(checkpoint));
    checkpointWrite = checkpointWrite.then(() => writeAtomic(paths.checkpointJson, `${JSON.stringify(snapshot, null, 2)}\n`));
    return checkpointWrite;
  };
  const rawDevices = await provider.listDevices({ deviceGroup: task.deviceGroup, task });
  assert(Array.isArray(rawDevices), "INVALID_PROVIDER", "listDevices must return an array");
  const deviceMap = new Map();
  rawDevices.forEach((device, index) => {
    const alias = normalizeAlias(device, index);
    if (!deviceMap.has(alias) && device?.online !== false) deviceMap.set(alias, { alias, raw: device });
  });
  const devices = [...deviceMap.values()].sort((a, b) => a.alias.localeCompare(b.alias)).slice(0, 3);
  if (devices.length === 0) {
    const summary = {
      schemaVersion: 1,
      taskId: task.taskId,
      taskHash,
      effectiveTaskHash,
      status: "failed",
      reason: "NO_ONLINE_DEVICES",
      counts: { queries: 0, notes: 0, duplicates: 0, workUnits: 0, completedUnits: 0, failedUnits: 0, skippedUnits: 0, candidates: 0, humanReview: 0, modelCalls },
      paths,
      artifacts,
    };
    await writeAtomic(paths.candidatesJsonl, "");
    await writeAtomic(paths.humanReviewJsonl, "");
    await writeAtomic(paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  const units = buildWorkUnits(task, devices.map((device) => device.alias));
  const queues = new Map(devices.map((device) => [device.alias, []]));
  for (const unit of units) queues.get(unit.assignedDevice).push(unit);
  const allCandidates = [];
  const allReviews = [];
  const events = new Map(devices.map((device) => [device.alias, []]));
  const signatureDevices = new Map();
  const reassign = [];
  let globalFuse = null;
  let humanRequired = false;
  let completedUnits = 0;
  let failedUnits = 0;
  let skippedUnits = 0;
  let budgetCappedUnits = 0;
  let noteBudgetReached = false;
  let fatalError = null;
  const deadline = options.deadlineAt ?? (Date.now() + task.budgets.wallClockSeconds * 1000);
  assert(Number.isFinite(deadline) && deadline > 0, "INVALID_ARGUMENT", "deadlineAt must be a finite epoch timestamp");

  const recordFailure = (deviceAlias, signature) => {
    if (!signatureDevices.has(signature)) signatureDevices.set(signature, new Set());
    signatureDevices.get(signature).add(deviceAlias);
    if (signatureDevices.get(signature).size >= 2 && !globalFuse) {
      globalFuse = { signature, reason: "SAME_FAILURE_ON_TWO_DEVICES" };
    }
  };

  const applyResult = (result, unit, deviceAlias) => {
    const normalizedCandidates = result.candidates.map((candidate) =>
      normalizeCandidate(candidate, { source: unit.source, keyword: unit.keyword, deviceAlias }));
    allCandidates.push(...normalizedCandidates);
    if (allCandidates.length > 0 && dedupeCandidates(allCandidates).length >= task.budgets.maxNotes) {
      noteBudgetReached = true;
    }
    const normalizedReviews = result.humanReview.map((review) =>
      sanitizeReview(review, { ...unit, deviceAlias }, task));
    allReviews.push(...normalizedReviews);
    if (result.status === "completed") completedUnits += 1;
    else if (result.status === "skipped") skippedUnits += 1;
    else {
      failedUnits += 1;
      humanRequired = result.status === "human_required" || humanRequired;
      if (result.failureSignature && result.affectsDeviceHealth !== false) {
        recordFailure(deviceAlias, String(result.failureSignature));
      }
    }
    if (result.stopAll) {
      humanRequired = result.status === "human_required" || humanRequired;
      globalFuse ??= { signature: String(result.failureSignature ?? "PROVIDER_STOP"), reason: "PROVIDER_STOP" };
    }
  };

  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  for (const [unitId, entry] of Object.entries(checkpoint.units)) {
    const unit = unitById.get(unitId);
    if (!unit || !isObject(entry) || !isObject(entry.result)) continue;
    const deviceAlias = normalizeAlias(entry.deviceAlias, 0);
    const result = normalizeResult(entry.result);
    applyResult(result, unit, deviceAlias);
    events.get(deviceAlias)?.push({ type: "resumed", unitId, status: result.status });
  }
  for (const [alias, queue] of queues) {
    queues.set(alias, queue.filter((unit) => !Object.hasOwn(checkpoint.units, unit.unitId)));
  }

  const recordUnit = async (unit, deviceAlias, result, consecutiveFailures) => {
    checkpoint.units[unit.unitId] = {
      unit: {
        unitId: unit.unitId,
        ordinal: unit.ordinal,
        source: unit.source,
        keyword: unit.keyword,
        assignedDevice: deviceAlias,
        reassignCount: unit.reassignCount,
      },
      deviceAlias,
      result,
      recordedAt: new Date().toISOString(),
    };
    checkpoint.deviceFailures[deviceAlias] = consecutiveFailures;
    await persistCheckpoint();
  };

  const runQueue = async (device, queue) => {
    let consecutiveFailures = Number(checkpoint.deviceFailures[device.alias] ?? 0);
    for (let index = 0; index < queue.length; index += 1) {
      const unit = queue[index];
      if (fatalError) break;
      if (noteBudgetReached) {
        skippedUnits += 1;
        budgetCappedUnits += 1;
        events.get(device.alias).push({ type: "skipped", unitId: unit.unitId, reason: "NOTE_BUDGET" });
        continue;
      }
      if (globalFuse || Date.now() >= deadline || consecutiveFailures >= 2) {
        skippedUnits += 1;
        events.get(device.alias).push({ type: "skipped", unitId: unit.unitId, reason: globalFuse ? "GLOBAL_FUSE" : consecutiveFailures >= 2 ? "DEVICE_ISOLATED" : "TIME_BUDGET" });
        continue;
      }
      try {
        const online = typeof provider.isDeviceOnline === "function"
          ? await provider.isDeviceOnline({ device: device.raw, deviceAlias: device.alias, task, unit })
          : true;
        if (!online) {
          if (unit.reassignCount < 1) reassign.push({ ...unit, previousDevice: device.alias });
          else skippedUnits += 1;
          events.get(device.alias).push({ type: "offline_before_start", unitId: unit.unitId });
          continue;
        }
        events.get(device.alias).push({ type: "started", unitId: unit.unitId, ordinal: unit.ordinal, attempt: unit.reassignCount });
        const result = normalizeResult(await provider.executeWorkUnit({
          task, unit: { ...unit }, device: device.raw, deviceAlias: device.alias, attempt: unit.reassignCount,
        }));
        if (result.status === "completed" || result.status === "skipped" || result.affectsDeviceHealth === false) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
        }
        applyResult(result, unit, device.alias);
        await recordUnit(unit, device.alias, result, consecutiveFailures);
        events.get(device.alias).push({
          type: "finished",
          unitId: unit.unitId,
          status: result.status,
          failureSignature: result.failureSignature ?? null,
          diagnostics: isObject(result.diagnostics) ? result.diagnostics : null,
        });
      } catch (error) {
        if (error?.code === "DEVICE_OFFLINE" && error?.notStarted === true) {
          if (unit.reassignCount < 1) reassign.push({ ...unit, previousDevice: device.alias });
          else skippedUnits += 1;
          events.get(device.alias).push({ type: "offline_before_start", unitId: unit.unitId });
          continue;
        }
        if (error?.fatal === true) {
          fatalError = error;
          events.get(device.alias).push({ type: "interrupted", unitId: unit.unitId, failureSignature: errorSignature(error) });
          break;
        }
        const signature = errorSignature(error);
        consecutiveFailures += 1;
        const result = normalizeResult({ status: "failed", candidates: [], humanReview: [], failureSignature: signature });
        applyResult(result, unit, device.alias);
        await recordUnit(unit, device.alias, result, consecutiveFailures);
        events.get(device.alias).push({ type: "failed", unitId: unit.unitId, failureSignature: signature });
      }
    }
  };

  await Promise.all(devices.map((device) => runQueue(device, queues.get(device.alias))));
  await checkpointWrite;
  if (fatalError) throw fatalError;

  if (!globalFuse && reassign.length > 0) {
    const secondQueues = new Map(devices.map((device) => [device.alias, []]));
    for (const unit of reassign.sort((a, b) => a.ordinal - b.ordinal)) {
      const alternatives = devices.filter((device) => device.alias !== unit.previousDevice);
      if (alternatives.length === 0) { skippedUnits += 1; continue; }
      const target = alternatives[Number.parseInt(stableHash(unit.unitId).slice(0, 8), 16) % alternatives.length];
      secondQueues.get(target.alias).push({ ...unit, assignedDevice: target.alias, reassignCount: 1 });
      events.get(target.alias).push({ type: "reassigned", unitId: unit.unitId, from: unit.previousDevice });
    }
    await Promise.all(devices.map((device) => runQueue(device, secondQueues.get(device.alias))));
    await checkpointWrite;
    if (fatalError) throw fatalError;
  } else if (reassign.length > 0) {
    skippedUnits += reassign.length;
  }

  const candidates = dedupeCandidates(allCandidates).slice(0, task.budgets.maxNotes);
  const reviews = allReviews.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  for (const device of devices) {
    const fileName = `${device.alias}.jsonl`;
    const ordered = events.get(device.alias);
    await writeAtomic(path.join(eventsDirectory, fileName), ordered.map(jsonLine).join(""));
  }
  await writeAtomic(paths.candidatesJsonl, candidates.map(jsonLine).join(""));
  await writeAtomic(paths.humanReviewJsonl, reviews.map(jsonLine).join(""));

  let status;
  if (humanRequired) status = "human_required";
  else if (completedUnits === 0 && (failedUnits > 0 || skippedUnits > budgetCappedUnits)) status = "failed";
  else if (failedUnits > 0 || skippedUnits > budgetCappedUnits || globalFuse) status = "partial";
  else status = "completed";
  const summary = {
    schemaVersion: 1,
    taskId: task.taskId,
    taskHash,
    effectiveTaskHash,
    status,
    counts: {
      queries: new Set(units.map((unit) => unit.keyword)).size,
      notes: candidates.length,
      duplicates: Math.max(0, allCandidates.length - candidates.length),
      workUnits: units.length,
      completedUnits,
      failedUnits,
      skippedUnits,
      budgetCappedUnits,
      candidates: candidates.length,
      humanReview: reviews.length,
      modelCalls,
    },
    devices: devices.map((device) => device.alias),
    globalFuse,
    aiCallsUsed: modelCalls,
    paths,
    artifacts,
  };
  await writeAtomic(paths.summaryJson, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export function createDryRunProvider(options = {}) {
  const devices = (options.devices ?? ["device-01", "device-02", "device-03"])
    .map((device) => typeof device === "string" ? { alias: device, online: true } : { ...device });
  const calls = [];
  return {
    calls,
    async listDevices() { return devices; },
    async isDeviceOnline(context) {
      if (typeof options.isDeviceOnline === "function") return options.isDeviceOnline(context);
      return context.device.online !== false;
    },
    async executeWorkUnit(context) {
      calls.push({ deviceAlias: context.deviceAlias, unitId: context.unit.unitId, ordinal: context.unit.ordinal, attempt: context.attempt });
      if (typeof options.outcomeForUnit === "function") {
        const outcome = await options.outcomeForUnit(context);
        if (outcome !== undefined) return outcome;
      }
      const id = `dry-${stableHash(`${context.unit.source}\u0000${context.unit.keyword}`).slice(0, 16)}`;
      return {
        status: "completed",
        candidates: [{ candidateId: id, noteId: id, author: "dry-run", title: context.unit.keyword, mediaType: "unknown" }],
      };
    },
  };
}

function parseCli(argv) {
  const result = { devices: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--task") result.task = argv[++index];
    else if (value === "--output-root") result.outputRoot = argv[++index];
    else if (value === "--devices") result.devices = argv[++index].split(",").filter(Boolean);
    else if (value === "--dry-run") result.dryRun = true;
    else throw new ResearchTaskError("INVALID_ARGUMENT", `unknown argument: ${value}`);
  }
  assert(result.task, "INVALID_ARGUMENT", "--task is required");
  assert(result.dryRun, "INVALID_ARGUMENT", "this entry point currently requires --dry-run; inject a real provider when importing the module");
  return result;
}

async function main() {
  const args = parseCli(process.argv.slice(2));
  const task = JSON.parse(await readFile(path.resolve(args.task), "utf8"));
  const provider = createDryRunProvider({ devices: args.devices.length ? args.devices : undefined });
  const summary = await runResearchTask(task, { provider, outputRoot: args.outputRoot });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    await rm(`${process.argv[1]}.${process.pid}.tmp`, { force: true }).catch(() => {});
    process.stderr.write(`${JSON.stringify({ error: error.code ?? error.name, message: error.message, details: error.details ?? null })}\n`);
    process.exitCode = 1;
  });
}
