import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeJson } from "./composite-plan-core.mjs";
import { normalizeTaskSpec } from "./task-compiler.mjs";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u;
const MACHINE = /^[0-9]{2}$/u;
const DEFAULT_CAPABILITY_PROFILE_ID = "composite-capability-initial-v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function plain(value, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  invariant(unknown.length === 0, `${label} contains unknown fields: ${unknown.join(", ")}`);
}

function integer(value, label, minimum, maximum) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} must be ${minimum}..${maximum}`);
  return value;
}

function safeId(value, label) {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} must contain 3-80 safe characters`);
  return value;
}

function profileId(value) {
  return safeId(value ?? DEFAULT_CAPABILITY_PROFILE_ID, "capabilityProfileId");
}

function deterministicSeed(kind, value) {
  return createHash("sha256").update(`${kind}\0${canonicalizeJson(value)}`, "utf8").digest("base64url");
}

function derivedWorkerTaskId(taskId, machine) {
  const plain = `${taskId}-${machine}`;
  if (plain.length <= 80) return plain;
  const suffix = createHash("sha256").update(plain, "utf8").digest("hex").slice(0, 10);
  return `${taskId.slice(0, 66)}-${machine}-${suffix}`;
}

function machineList(value, label = "machines") {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= 64, `${label} must contain 1..64 machines`);
  invariant(value.every((machine) => typeof machine === "string" && MACHINE.test(machine)), `${label} must contain two-digit machine numbers`);
  invariant(new Set(value).size === value.length, `${label} must be unique`);
  return [...value];
}

function taskBase({ taskId, capabilityProfileId, machines, maxParallel, source, actions, sourceCountsByMachine, taskIdsByMachine, seedInput }) {
  const task = {
    schemaVersion: "xhs-task-spec/v1",
    taskId: safeId(taskId, "taskId"),
    capabilityProfileId: profileId(capabilityProfileId),
    seed: deterministicSeed("legacy-task-compatibility/v1", seedInput),
    deviceSelection: { mode: "explicit", machines },
    maxParallel: integer(maxParallel, "maxParallel", 1, machines.length),
    ...(sourceCountsByMachine ? { sourceCountsByMachine } : {}),
    ...(taskIdsByMachine ? { taskIdsByMachine } : {}),
    source,
    actions,
  };
  return normalizeTaskSpec(task);
}

export function convertLegacyFeedRun(input, { capabilityProfileId = DEFAULT_CAPABILITY_PROFILE_ID } = {}) {
  plain(input, "legacy Feed request");
  exactKeys(input, ["schemaVersion", "taskId", "machines", "maxParallel", "count", "likeAt", "favoriteAt"], "legacy Feed request");
  invariant(input.schemaVersion === "xhs-legacy-feed-compat/v1", "legacy Feed schemaVersion is invalid");
  const machines = machineList(input.machines);
  const count = integer(input.count, "count", 1, 10000);
  const actions = [];
  if (input.likeAt !== undefined && input.likeAt !== null) {
    actions.push({ target: { mode: "ordinal", ordinal: integer(input.likeAt, "likeAt", 1, count) }, action: "engagement.ensure_liked" });
  }
  if (input.favoriteAt !== undefined && input.favoriteAt !== null) {
    actions.push({ target: { mode: "ordinal", ordinal: integer(input.favoriteAt, "favoriteAt", 1, count) }, action: "engagement.ensure_favorited" });
  }
  const normalizedInput = {
    schemaVersion: input.schemaVersion,
    taskId: safeId(input.taskId, "taskId"),
    machines,
    maxParallel: input.maxParallel ?? machines.length,
    count,
    actions,
    capabilityProfileId: profileId(capabilityProfileId),
  };
  return taskBase({
    taskId: normalizedInput.taskId,
    capabilityProfileId: normalizedInput.capabilityProfileId,
    machines,
    maxParallel: normalizedInput.maxParallel,
    taskIdsByMachine: machines.map((machine) => ({ machine, taskId: machines.length === 1 ? normalizedInput.taskId : derivedWorkerTaskId(normalizedInput.taskId, machine) })),
    source: { type: "feed", count, candidateCap: Math.min(20, count) },
    actions,
    seedInput: normalizedInput,
  });
}

export function normalizeLegacyFeedBatch(input) {
  plain(input, "legacy Feed batch");
  exactKeys(input, ["schemaVersion", "batchId", "mode", "maxParallel", "runs"], "legacy Feed batch");
  invariant(input.schemaVersion === 1, "legacy Feed batch schemaVersion must be 1");
  invariant(input.mode === "feed_read_only", "legacy Feed batch mode must be feed_read_only");
  const batchId = safeId(input.batchId, "batchId");
  invariant(Array.isArray(input.runs) && input.runs.length > 0 && input.runs.length <= 64, "legacy Feed batch runs must contain 1..64 machines");
  const runs = input.runs.map((entry, index) => {
    plain(entry, `runs[${index}]`);
    exactKeys(entry, ["machine", "taskId", "count"], `runs[${index}]`);
    invariant(typeof entry.machine === "string" && MACHINE.test(entry.machine), `runs[${index}].machine is invalid`);
    return {
      machine: entry.machine,
      taskId: safeId(entry.taskId, `runs[${index}].taskId`),
      count: integer(entry.count, `runs[${index}].count`, 1, 10000),
    };
  });
  invariant(new Set(runs.map((entry) => entry.machine)).size === runs.length, "legacy Feed batch machines must be unique");
  invariant(new Set(runs.map((entry) => entry.taskId)).size === runs.length, "legacy Feed batch taskIds must be unique");
  return {
    schemaVersion: 1,
    batchId,
    mode: "feed_read_only",
    maxParallel: integer(input.maxParallel ?? runs.length, "maxParallel", 1, runs.length),
    runs,
  };
}

export function convertLegacyFeedBatch(input, { capabilityProfileId = DEFAULT_CAPABILITY_PROFILE_ID } = {}) {
  const batch = normalizeLegacyFeedBatch(input);
  const machines = batch.runs.map((entry) => entry.machine);
  const maximumCount = Math.max(...batch.runs.map((entry) => entry.count));
  const normalizedInput = { ...batch, capabilityProfileId: profileId(capabilityProfileId) };
  return taskBase({
    taskId: batch.batchId,
    capabilityProfileId: normalizedInput.capabilityProfileId,
    machines,
    maxParallel: batch.maxParallel,
    sourceCountsByMachine: batch.runs.map(({ machine, count }) => ({ machine, count })),
    taskIdsByMachine: batch.runs.map(({ machine, taskId }) => ({ machine, taskId })),
    source: { type: "feed", count: maximumCount, candidateCap: Math.min(20, maximumCount) },
    actions: [],
    seedInput: normalizedInput,
  });
}

function parseCli(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const name = String(argv[index] ?? "").replace(/^--/u, "");
    invariant(["kind", "input", "output", "capability-profile"].includes(name), `legacy converter does not support --${name}`);
    invariant(!Object.hasOwn(options, name), `--${name} may be provided only once`);
    index += 1;
    invariant(index < argv.length && !String(argv[index]).startsWith("--"), `--${name} requires a value`);
    options[name] = String(argv[index]);
  }
  invariant(["feed", "batch"].includes(options.kind), "--kind must be feed or batch");
  invariant(options.input && options.output, "--input and --output are required");
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const input = JSON.parse(await readFile(path.resolve(options.input), "utf8"));
  const context = { capabilityProfileId: options["capability-profile"] ?? DEFAULT_CAPABILITY_PROFILE_ID };
  const task = options.kind === "feed" ? convertLegacyFeedRun(input, context) : convertLegacyFeedBatch(input, context);
  await writeFile(path.resolve(options.output), `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
