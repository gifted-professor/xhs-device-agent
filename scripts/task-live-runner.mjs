import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadActiveCapability } from "./composite-capability-activation.mjs";
import { approvePlan, consumeApproval } from "./composite-plan-approval.mjs";
import { canonicalizeJson } from "./composite-plan-core.mjs";
import { prepareCompositeSnapshot } from "./composite-plan-prepare.mjs";
import { renderCompositePlan } from "./composite-plan-render.mjs";
import { compileUnifiedTaskPlan, resolveTaskMachines } from "./task-compiler.mjs";
import { executeApprovedTaskPlan } from "./task-live-executor.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalizeJson(value), "utf8").digest("hex");
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

function validateRuntimeContext(value) {
  invariant(value?.schemaVersion === "xhs-task-runtime-context/v1", "runtime context schema is invalid");
  invariant(value.locksHeld === true, "runtime context lacks held parent locks");
  invariant(typeof value.adbPath === "string" && path.isAbsolute(value.adbPath), "runtime ADB path is invalid");
  invariant(typeof value.rulesPath === "string" && path.isAbsolute(value.rulesPath), "runtime rules path is invalid");
  invariant(typeof value.acceptanceRoot === "string" && path.isAbsolute(value.acceptanceRoot), "runtime acceptance root is invalid");
  invariant(Array.isArray(value.devices) && value.devices.length > 0, "runtime devices are required");
  const machines = new Set();
  for (const device of value.devices) {
    invariant(/^[0-9]{2}$/u.test(device?.machine ?? "") && !machines.has(device.machine), "runtime machine binding is invalid");
    machines.add(device.machine);
    invariant(typeof device.visibleName === "string" && device.visibleName.length > 0 && device.visibleName.length <= 80, "runtime visible name is invalid");
    invariant(/^[A-Za-z0-9._-]{1,64}$/u.test(device.deviceAlias ?? ""), "runtime device alias is invalid");
    invariant(typeof device.serial === "string" && device.serial.length > 0, "runtime internal device binding is missing");
    invariant(/^[a-f0-9]{64}$/u.test(device.identityHash ?? ""), "runtime identity hash is invalid");
    invariant(typeof device.online === "boolean" && typeof device.unlocked === "boolean" && typeof device.idle === "boolean", "runtime readiness flags are invalid");
    invariant(device.actionRegistryVersion === "composite-actions/v1", "runtime action registry is unsupported");
  }
  return value;
}

function parseCli(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? "");
    invariant(token.startsWith("--") && token.length > 2, "live task runner accepts named options only");
    const name = token.slice(2);
    invariant(["spec", "runtime-context", "output", "confirm-plan-hash", "json"].includes(name), `live task runner does not support --${name}`);
    invariant(!Object.hasOwn(options, name), `--${name} may be provided only once`);
    if (name === "json") options[name] = true;
    else {
      index += 1;
      invariant(index < argv.length && !String(argv[index]).startsWith("--"), `--${name} requires a value`);
      options[name] = String(argv[index]);
    }
  }
  invariant(options.spec, "--spec is required");
  invariant(options["runtime-context"], "--runtime-context is required");
  return options;
}

function taskDirectory(outputRoot, taskId) {
  const root = path.resolve(outputRoot);
  const result = path.resolve(root, taskId);
  invariant(result.startsWith(`${root}${path.sep}`), "live task output escaped outputRoot");
  return result;
}

export async function prepareLiveTask({
  spec,
  runtimeContext,
  activeCapability,
  outputRoot = path.join(PROJECT_ROOT, "data", "tasks"),
  confirmPlanHash,
  now,
  execute = executeApprovedTaskPlan,
} = {}) {
  validateRuntimeContext(runtimeContext);
  invariant(spec && typeof spec === "object", "task spec is required");
  const resolvedMachines = resolveTaskMachines(spec, runtimeContext.devices);
  const machines = spec.deviceSelection.mode === "explicit" ? [...spec.deviceSelection.machines] : resolvedMachines;
  invariant(spec.capabilityProfileId === activeCapability?.profile?.capabilityProfileId, "task capability profile is not the active human-accepted profile");
  const taskIdsByMachine = new Map((spec.taskIdsByMachine ?? []).map((entry) => [entry.machine, entry.taskId]));
  const request = {
    devices: machines.map((machine) => ({ machine, taskId: taskIdsByMachine.get(machine) ?? `${spec.taskId}-${machine}` })),
  };
  const provider = {
    async listDevices() {
      return runtimeContext.devices.map(({ machine, visibleName, identityHash, online }) => ({ machine, visibleName, identityHash, online }));
    },
    async readCapability(machine) {
      const device = runtimeContext.devices.find((entry) => entry.machine === machine);
      invariant(device, `machine ${machine} is absent from the runtime context`);
      return {
        appVersion: device.appVersion,
        adapterVersion: device.adapterVersion,
        actionRegistryVersion: device.actionRegistryVersion,
      };
    },
  };
  const preparation = await prepareCompositeSnapshot({ request, activeCapability, provider, now });
  const policy = await readJson(path.join(PROJECT_ROOT, "config", "composite-policy.supervised-v1.json"));
  const plan = compileUnifiedTaskPlan(spec, {
    compilerVersion: "2.0.0",
    policyHash: sha256(policy),
    capabilityProfile: activeCapability.profile,
    capabilityProfileHash: activeCapability.profileHash,
    preparationSnapshot: preparation,
    resolvedMachines,
  });
  const review = renderCompositePlan(plan);
  const directory = taskDirectory(outputRoot, spec.taskId);
  const planPath = path.join(directory, "review", "plan.json");
  const reviewPath = path.join(directory, "review", "review.md");
  await atomicWrite(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await atomicWrite(reviewPath, `${review}\n`);
  if (!confirmPlanHash) {
    return Object.freeze({
      schemaVersion: "xhs-task-live-review/v1",
      status: "review_required",
      deviceMutations: 0,
      taskId: spec.taskId,
      selectedMachines: machines,
      planHash: plan.planHash,
      plan,
      review,
      paths: { plan: planPath, review: reviewPath },
    });
  }
  invariant(confirmPlanHash === plan.planHash, "exact plan hash confirmation mismatch");
  const approval = await approvePlan({
    plan,
    approvalRoot: path.join(directory, "approvals"),
    confirmPlanHash,
    now,
    executionNonce: randomBytes(24).toString("base64url"),
  });
  await consumeApproval({ approvalPath: approval.approvalPath, plan, now });
  const execution = await execute({ plan, approvalHash: approval.approvalHash, runtimeContext, outputRoot: directory, now });
  return Object.freeze({
    schemaVersion: "xhs-task-live-result/v1",
    status: execution.status,
    taskId: spec.taskId,
    selectedMachines: machines,
    planHash: plan.planHash,
    approvalId: approval.approval.approvalId,
    execution,
    paths: { plan: planPath, review: reviewPath },
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  const [spec, runtimeContext] = await Promise.all([
    readJson(path.resolve(options.spec)),
    readJson(path.resolve(options["runtime-context"])),
  ]);
  const activeCapability = await loadActiveCapability({ acceptanceRoot: runtimeContext.acceptanceRoot });
  const result = await prepareLiveTask({
    spec,
    runtimeContext,
    activeCapability,
    outputRoot: options.output,
    confirmPlanHash: options["confirm-plan-hash"],
  });
  if (options.json) {
    const publicResult = {
      schemaVersion: result.schemaVersion,
      status: result.status,
      taskId: result.taskId,
      selectedMachines: result.selectedMachines,
      planHash: result.planHash,
      ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      paths: result.paths,
      ...(result.execution ? { execution: result.execution } : {}),
    };
    process.stdout.write(`${JSON.stringify(publicResult)}\n`);
    return;
  }
  if (result.status === "review_required") {
    process.stdout.write(`${result.review}\n`);
    process.stdout.write(`Review complete. To approve this exact finite plan once, rerun with --confirm-plan-hash ${result.planHash}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    status: result.status, taskId: result.taskId, selectedMachines: result.selectedMachines,
    planHash: result.planHash, approvalId: result.approvalId, execution: result.execution,
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
