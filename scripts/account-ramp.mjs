import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateResearchTask } from "./research-core.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ACCOUNT_ROOT = path.join(PROJECT_ROOT, "data", "accounts");
const DEFAULT_RESEARCH_ROOT = path.join(PROJECT_ROOT, "data", "research");
const SAFE_ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/u;
const SAFE_DEVICE_ALIAS = /^[A-Za-z0-9._-]{1,64}$/u;
const SAFE_CANDIDATE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const SAFE_DEVICE_GROUP = /^(?!\s)(?![\s\S]*\s$).{1,40}$/u;
const ACTIVE_PHASES = new Set(["topic_learning", "content_preparation", "steady_operation"]);
const ALL_PHASES = new Set([
  "draft", "device_ready", "profile_ready", "topic_learning", "content_preparation",
  "steady_operation", "human_required", "paused", "retired",
]);
const PROFILE_KEYS = new Set([
  "schemaVersion", "accountAlias", "deviceAlias", "deviceGroup", "phase", "primaryTopic",
  "topicPool", "automationPolicy", "interactionPolicy", "paused", "phaseApproval",
]);
const APPROVAL_KEYS = new Set(["phase", "approved", "approvedAt"]);

const PHASE_TASKS = Object.freeze({
  topic_learning: Object.freeze({
    sources: ["suggestions", "search"],
    commentMode: "none",
    budgets: {
      wallClockSeconds: 600,
      maxQueries: 2,
      maxNotes: 5,
      maxNotesPerQuery: 3,
      maxResultScrollsPerQuery: 2,
      maxNoteScrolls: 0,
      maxCommentPanels: 0,
      maxCommentsPerNote: 0,
      maxNoNewScrolls: 1,
    },
    aiPolicy: { topicPlanner: true, pageFallback: true, resultAnalysis: false, maxAutomaticCalls: 2 },
  }),
  content_preparation: Object.freeze({
    sources: ["suggestions", "search", "trending", "recommended"],
    commentMode: "metadata",
    budgets: {
      wallClockSeconds: 900,
      maxQueries: 3,
      maxNotes: 8,
      maxNotesPerQuery: 4,
      maxResultScrollsPerQuery: 3,
      maxNoteScrolls: 1,
      maxCommentPanels: 2,
      maxCommentsPerNote: 0,
      maxNoNewScrolls: 1,
    },
    aiPolicy: { topicPlanner: true, pageFallback: true, resultAnalysis: true, maxAutomaticCalls: 3 },
  }),
  steady_operation: Object.freeze({
    sources: ["suggestions", "search", "trending", "recommended"],
    commentMode: "metadata",
    budgets: {
      wallClockSeconds: 900,
      maxQueries: 3,
      maxNotes: 8,
      maxNotesPerQuery: 4,
      maxResultScrollsPerQuery: 3,
      maxNoteScrolls: 1,
      maxCommentPanels: 1,
      maxCommentsPerNote: 0,
      maxNoNewScrolls: 1,
    },
    aiPolicy: { topicPlanner: false, pageFallback: true, resultAnalysis: true, maxAutomaticCalls: 2 },
  }),
});

function fail(message, code = "INVALID_ACCOUNT_PROFILE") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compact(value) {
  return String(value ?? "").trim();
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}.${key} is not allowed`);
  }
}

function boundedText(value, minimum, maximum, label) {
  const text = compact(value);
  const length = [...text].length;
  if (length < minimum || length > maximum || text !== String(value ?? "")) {
    fail(`${label} must be trimmed and contain ${minimum}..${maximum} characters`);
  }
  return text;
}

function parseDate(value) {
  const text = compact(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) fail("date must use YYYY-MM-DD", "INVALID_RAMP_DATE");
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail("date is not a valid calendar date", "INVALID_RAMP_DATE");
  }
  return text;
}

function localDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function exists(filePath) {
  try { await readFile(filePath); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

function clippedText(value, maximum) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

async function loadAccountQueueCandidates(profile, summary, options = {}) {
  const sourcePath = summary.paths?.candidatesJsonl ?? summary.artifacts?.candidatesJsonl ?? summary.artifacts?.candidates;
  if (!sourcePath) return [];
  const researchRoot = path.resolve(options.researchDataRoot ?? DEFAULT_RESEARCH_ROOT);
  const resolved = path.resolve(sourcePath);
  const relative = path.relative(researchRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("candidate artifact must stay inside the research output root", "INVALID_RAMP_SUMMARY");
  }
  if (!(await exists(resolved))) return [];
  const rows = (await readFile(resolved, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const seen = new Set();
  const maximum = PHASE_TASKS[profile.phase]?.budgets.maxNotes ?? 8;
  const candidates = [];
  for (const row of rows) {
    const candidateId = String(row?.candidateId ?? row?.noteId ?? "");
    if (!SAFE_CANDIDATE_ID.test(candidateId) || seen.has(candidateId) || row?.deviceAlias !== profile.deviceAlias) continue;
    seen.add(candidateId);
    candidates.push({
      candidateId,
      title: clippedText(row.title, 300),
      author: clippedText(row.author, 120),
      mediaType: clippedText(row.mediaType, 32),
      source: clippedText(row.source, 32),
      keyword: clippedText(row.keyword, 120),
      deviceAlias: profile.deviceAlias,
      reviewStatus: "pending_human_decision",
    });
    if (candidates.length >= maximum) break;
  }
  return candidates;
}

export function validateAccountRampProfile(input) {
  if (!object(input)) fail("account profile must be an object");
  exactKeys(input, PROFILE_KEYS, "profile");
  if (input.schemaVersion !== 1) fail("schemaVersion must equal 1");
  if (!SAFE_ACCOUNT_ALIAS.test(String(input.accountAlias ?? ""))) fail("accountAlias must be an opaque safe alias");
  if (!SAFE_DEVICE_ALIAS.test(String(input.deviceAlias ?? ""))) fail("deviceAlias must be a safe mapped alias");
  if (!SAFE_DEVICE_GROUP.test(String(input.deviceGroup ?? ""))) fail("deviceGroup must be a bounded trimmed name");
  if (!ALL_PHASES.has(input.phase)) fail("phase is unsupported");
  const primaryTopic = boundedText(input.primaryTopic, 1, 120, "primaryTopic");
  if (!Array.isArray(input.topicPool) || input.topicPool.length < 1 || input.topicPool.length > 10) {
    fail("topicPool must contain 1..10 topics");
  }
  const topicPool = input.topicPool.map((value, index) => boundedText(value, 1, 80, `topicPool[${index}]`));
  if (new Set(topicPool).size !== topicPool.length) fail("topicPool must contain unique topics");
  if (!topicPool.includes(primaryTopic)) fail("topicPool must include primaryTopic");
  if (input.automationPolicy !== "research_read_only") fail("automationPolicy must be research_read_only");
  if (input.interactionPolicy !== "human_final") fail("interactionPolicy must be human_final");
  if (typeof input.paused !== "boolean") fail("paused must be boolean");
  if (!object(input.phaseApproval)) fail("phaseApproval must be an object");
  exactKeys(input.phaseApproval, APPROVAL_KEYS, "phaseApproval");
  if (input.phaseApproval.phase !== input.phase || input.phaseApproval.approved !== true) {
    fail("phaseApproval must explicitly approve the current phase");
  }
  const approvedAt = compact(input.phaseApproval.approvedAt);
  if (!approvedAt || Number.isNaN(Date.parse(approvedAt))) fail("phaseApproval.approvedAt must be an ISO timestamp");
  return {
    ...input,
    accountAlias: String(input.accountAlias),
    deviceAlias: String(input.deviceAlias),
    deviceGroup: String(input.deviceGroup),
    primaryTopic,
    topicPool,
    phaseApproval: { phase: input.phase, approved: true, approvedAt },
  };
}

export function buildAccountRampTask(profileInput, options = {}) {
  const profile = validateAccountRampProfile(profileInput);
  if (profile.paused || profile.phase === "paused") fail("account ramp is paused", "ACCOUNT_RAMP_PAUSED");
  if (profile.phase === "human_required") fail("account requires human handling", "ACCOUNT_HUMAN_REQUIRED");
  if (profile.phase === "retired") fail("retired accounts cannot receive tasks", "ACCOUNT_RETIRED");
  if (!ACTIVE_PHASES.has(profile.phase)) {
    fail("current phase is not approved for automated research", "PHASE_NOT_EXECUTABLE");
  }
  const date = parseDate(options.date ?? localDate());
  const sequence = Number(options.sequence ?? 1);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 99) fail("sequence must be an integer from 1 to 99", "INVALID_RAMP_SEQUENCE");
  const phaseTask = PHASE_TASKS[profile.phase];
  const task = {
    schemaVersion: 1,
    taskId: `ramp-${profile.accountAlias}-${date.replaceAll("-", "")}-${String(sequence).padStart(2, "0")}`,
    mode: "research_read_only",
    topic: profile.primaryTopic,
    seedKeywords: profile.topicPool.slice(0, phaseTask.budgets.maxQueries),
    sources: [...phaseTask.sources],
    deviceGroup: profile.deviceGroup,
    commentMode: phaseTask.commentMode,
    interactionPolicy: "human_final",
    budgets: { ...phaseTask.budgets },
    aiPolicy: { ...phaseTask.aiPolicy },
  };
  return validateResearchTask(task);
}

export async function writeAccountRampTask(profileInput, options = {}) {
  const profile = validateAccountRampProfile(profileInput);
  const task = buildAccountRampTask(profile, options);
  const accountRoot = path.resolve(options.accountDataRoot ?? DEFAULT_ACCOUNT_ROOT, profile.accountAlias);
  const taskPath = path.join(accountRoot, "tasks", `${task.taskId}.json`);
  const contents = `${JSON.stringify(task, null, 2)}\n`;
  if (await exists(taskPath)) {
    const previous = JSON.parse(await readFile(taskPath, "utf8"));
    if (canonical(previous) !== canonical(task)) fail("taskId already exists with different content", "RAMP_TASK_CONFLICT");
  } else {
    await writeAtomic(taskPath, contents);
  }
  return { schemaVersion: 1, accountAlias: profile.accountAlias, deviceAlias: profile.deviceAlias, phase: profile.phase, taskId: task.taskId, taskPath };
}

export async function recordAccountRampResult(profileInput, summaryInput, options = {}) {
  const profile = validateAccountRampProfile(profileInput);
  if (!object(summaryInput) || typeof summaryInput.taskId !== "string" || typeof summaryInput.status !== "string") {
    fail("summary must be a completed research result", "INVALID_RAMP_SUMMARY");
  }
  if (!summaryInput.taskId.startsWith(`ramp-${profile.accountAlias}-`)) fail("summary does not belong to this account alias", "RAMP_SUMMARY_MISMATCH");
  if (!["completed", "partial", "human_required", "failed", "duplicate"].includes(summaryInput.status)) {
    fail("summary status is unsupported", "INVALID_RAMP_SUMMARY");
  }
  const recordedAt = options.recordedAt ?? new Date().toISOString();
  const report = {
    schemaVersion: 1,
    accountAlias: profile.accountAlias,
    phase: profile.phase,
    taskId: summaryInput.taskId,
    status: summaryInput.status,
    needsHuman: ["partial", "human_required", "failed"].includes(summaryInput.status),
    counts: {
      completedUnits: Number(summaryInput.counts?.completedUnits ?? 0),
      failedUnits: Number(summaryInput.counts?.failedUnits ?? 0),
      skippedUnits: Number(summaryInput.counts?.skippedUnits ?? 0),
      candidates: Number(summaryInput.counts?.candidates ?? summaryInput.counts?.notes ?? 0),
      humanReview: Number(summaryInput.counts?.humanReview ?? 0),
    },
    sourceSkips: Array.isArray(summaryInput.sourceSkips)
      ? summaryInput.sourceSkips.map(({ source, reason }) => ({ source: compact(source), reason: compact(reason) }))
      : [],
    recordedAt,
  };
  const accountRoot = path.resolve(options.accountDataRoot ?? DEFAULT_ACCOUNT_ROOT, profile.accountAlias);
  const reportPath = path.join(accountRoot, "runs", `${summaryInput.taskId}.json`);
  const statePath = path.join(accountRoot, "state.json");
  const queuePath = path.join(accountRoot, "queues", `${summaryInput.taskId}.json`);
  const todayQueuePath = path.join(accountRoot, "today-queue.json");
  const candidates = await loadAccountQueueCandidates(profile, summaryInput, options);
  const queue = {
    schemaVersion: 1,
    accountAlias: profile.accountAlias,
    phase: profile.phase,
    taskId: summaryInput.taskId,
    status: candidates.length > 0 ? "ready" : "empty",
    generatedAt: recordedAt,
    candidates,
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeAtomic(statePath, `${JSON.stringify({
    schemaVersion: 1,
    accountAlias: profile.accountAlias,
    phase: profile.phase,
    lastTaskId: summaryInput.taskId,
    lastStatus: summaryInput.status,
    needsHuman: report.needsHuman,
    lastRunAt: recordedAt,
  }, null, 2)}\n`);
  await writeAtomic(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  await writeAtomic(todayQueuePath, `${JSON.stringify(queue, null, 2)}\n`);
  return { ...report, reportPath, statePath, queuePath, todayQueuePath };
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { parsed._.push(value); continue; }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) fail(`missing value for --${key}`, "INVALID_ARGUMENT");
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !args.profile) fail("usage: account-ramp.mjs <build|record> --profile <path>", "INVALID_ARGUMENT");
  const profile = await readJson(args.profile);
  if (command === "build") {
    const manifest = await writeAccountRampTask(profile, { date: args.date, sequence: args.sequence });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "record") {
    if (!args.summary) fail("record requires --summary <path>", "INVALID_ARGUMENT");
    const summary = await readJson(args.summary);
    const report = await recordAccountRampResult(profile, summary);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  fail("command must be build or record", "INVALID_ARGUMENT");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.code ?? "ACCOUNT_RAMP_ERROR"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
