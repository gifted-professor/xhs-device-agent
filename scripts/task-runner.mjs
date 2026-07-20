import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION_REGISTRY } from "./composite-action-registry.mjs";
import { canonicalizeJson } from "./composite-plan-core.mjs";
import { renderCompositePlan } from "./composite-plan-render.mjs";
import { compileUnifiedTaskPlan, normalizeTaskSpec } from "./task-compiler.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalizeJson(value), "utf8").digest("hex");
}

function parseCli(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    invariant(token.startsWith("--") && token.length > 2, "task runner accepts named options only");
    const name = token.slice(2);
    invariant(["spec", "output", "dry-run", "json"].includes(name), `task runner does not support --${name}`);
    invariant(!Object.hasOwn(options, name), `--${name} may be provided only once`);
    if (["dry-run", "json"].includes(name)) options[name] = true;
    else {
      index += 1;
      invariant(index < argv.length && !String(argv[index]).startsWith("--"), `--${name} requires a value`);
      options[name] = String(argv[index]);
    }
  }
  invariant(options.spec, "--spec is required");
  invariant(options["dry-run"] === true, "live task execution must enter through the supervised Windows wrapper");
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function dryRunMachines(task) {
  if (task.deviceSelection.mode === "explicit") return [...task.deviceSelection.machines];
  return Array.from({ length: task.deviceSelection.count }, (_, index) => String(index + 1).padStart(2, "0"));
}

function planningCapability(task, machines) {
  const count = task.source.type === "url_list" ? task.source.urls.length : (task.source.count ?? 1);
  return {
    capabilityProfileId: task.capabilityProfileId,
    profileKind: "non_executable_dry_run",
    allowedActions: Object.keys(ACTION_REGISTRY),
    maxDevices: machines.length,
    maxParallel: machines.length,
    maxStateChangesTotal: Math.min(2000000, Math.max(0, task.actions.length * Math.max(1, count) * machines.length)),
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict",
      startPolicy: "all_ready",
      readyDeadlineMs: 8000,
      minReady: machines.length,
      snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000,
      readOnlyFlushMaxEvents: 32,
      cpaWorkflowSoftTimeoutMs: 8000,
    },
  };
}

function dryRunPreparation(task, machines, profileHash) {
  const taskIdsByMachine = new Map((task.taskIdsByMachine ?? []).map((entry) => [entry.machine, entry.taskId]));
  const devices = machines.map((machine) => ({
    machine,
    taskId: taskIdsByMachine.get(machine) ?? `${task.taskId}-${machine}`,
    visibleName: `DRY-RUN-${machine}`,
    identityHash: sha256({ machine, scope: "dry_run_only" }),
    appVersion: "dry-run",
    adapterVersion: "dry-run",
    actionRegistryVersion: "composite-actions/v1",
  }));
  return {
    inventorySnapshotHash: sha256(devices.map(({ machine, taskId, visibleName, identityHash }) => ({ machine, taskId, visibleName, identityHash }))),
    capabilitySnapshotHash: sha256({ profileHash, scope: "dry_run_only", devices }),
    devices,
  };
}

function controlledTaskDirectory(outputRoot, taskId) {
  const root = path.resolve(outputRoot);
  const result = path.resolve(root, taskId, "review");
  invariant(result.startsWith(`${root}${path.sep}`), "task output escaped the output root");
  return result;
}

export async function runTaskDryRun({ specPath, outputRoot = path.join(PROJECT_ROOT, "data", "tasks") }) {
  const absoluteSpecPath = path.resolve(specPath);
  const raw = await readJson(absoluteSpecPath);
  const machines = dryRunMachines(raw);
  const task = normalizeTaskSpec(raw, { resolvedMachines: machines });
  const policy = await readJson(path.join(PROJECT_ROOT, "config", "composite-policy.supervised-v1.json"));
  const profile = planningCapability(task, machines);
  const profileHash = sha256(profile);
  const preparation = dryRunPreparation(task, machines, profileHash);
  const plan = compileUnifiedTaskPlan(raw, {
    compilerVersion: "2.0.0",
    policyHash: sha256(policy),
    capabilityProfile: profile,
    capabilityProfileHash: profileHash,
    preparationSnapshot: preparation,
    resolvedMachines: machines,
  });
  const review = renderCompositePlan(plan);
  const directory = controlledTaskDirectory(outputRoot, task.taskId);
  const planPath = path.join(directory, "plan.json");
  const reviewPath = path.join(directory, "review.md");
  await atomicWrite(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await atomicWrite(reviewPath, `${review}\n`);
  return Object.freeze({
    schemaVersion: "xhs-task-dry-run-result/v1",
    status: "dry_run_review",
    executable: false,
    deviceOperations: 0,
    taskId: task.taskId,
    selectedMachines: machines,
    planHash: plan.planHash,
    plan,
    review,
    paths: { plan: planPath, review: reviewPath },
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const result = await runTaskDryRun({ specPath: options.spec, outputRoot: options.output });
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: result.schemaVersion,
      status: result.status,
      executable: result.executable,
      deviceOperations: result.deviceOperations,
      taskId: result.taskId,
      selectedMachines: result.selectedMachines,
      planHash: result.planHash,
      paths: result.paths,
    })}\n`);
    return;
  }
  process.stdout.write("DRY RUN ONLY — no device inventory, approval, or device operation was performed.\n\n");
  process.stdout.write(`${result.review}\n`);
  process.stdout.write("This planning artifact is not executable and is not a human approval receipt.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
