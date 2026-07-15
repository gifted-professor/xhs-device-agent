import { randomBytes, createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CompositeDeviceAdapter } from "./composite-device-adapter.mjs";
import { createExecutionCoordinator } from "./composite-execution-coordinator.mjs";
import { CompositeOperationLedger, operationSlotsFromPlan } from "./composite-operation-ledger.mjs";
import { hashPlan, canonicalizeJson } from "./composite-plan-core.mjs";
import { runCompositeWorkflow } from "./composite-workflow.mjs";
import { AdbFeedAdapter } from "./feed-device-runner.mjs";
import { loadRules } from "./xhs-page-engine.mjs";

const LIVE_ACTIONS = new Set([
  "recover.to_feed", "feed.open_visible", "detail.inspect", "detail.evaluate_title_rule",
  "comments.observe_count", "navigation.return_to_feed",
  "engagement.ensure_liked", "engagement.ensure_favorited",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalizeJson(value), "utf8").digest("hex");
}

function atomicWriteSync(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
}

async function atomicWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function sanitizeMessage(error, devices) {
  let message = String(error?.message ?? error ?? "task worker failed");
  for (const device of devices) {
    message = message.replaceAll(String(device.serial), "[device]");
    message = message.replaceAll(String(device.deviceAlias), `machine-${device.machine}`);
  }
  return message.slice(0, 1000);
}

function requiresGlobalFuse(error) {
  return /SENSITIVE_PAGE|LOGIN_OR_CHALLENGE|CAPTCHA|RISK|IDENTITY|APPROVAL|PLAN HASH|LEASE|FUSE|FORBIDDEN|HUMAN_INTERRUPT/iu.test(String(error?.message ?? error));
}

export async function executeApprovedTaskPlan({
  plan,
  approvalHash,
  runtimeContext,
  outputRoot,
  now = Date.now,
  dependencies = {},
} = {}) {
  invariant(plan?.planHash === hashPlan(plan), "execution plan hash mismatch");
  invariant(/^[a-f0-9]{64}$/u.test(approvalHash ?? ""), "execution approvalHash is invalid");
  invariant(runtimeContext?.locksHeld === true, "device and task locks are not held by the parent wrapper");
  invariant(typeof runtimeContext.adbPath === "string" && path.isAbsolute(runtimeContext.adbPath), "runtime ADB path is invalid");
  invariant(typeof runtimeContext.rulesPath === "string" && path.isAbsolute(runtimeContext.rulesPath), "runtime rules path is invalid");
  const selected = new Set(plan.devices.map((entry) => entry.machine));
  const runtimeDevices = runtimeContext.devices.filter((entry) => selected.has(entry.machine));
  invariant(runtimeDevices.length === plan.devices.length, "runtime device binding count changed");
  invariant(runtimeDevices.every((entry) => entry.online === true), "a selected target device is offline");
  const unsupported = plan.devices.flatMap((device) => device.steps).filter((step) => !LIVE_ACTIONS.has(step.action));
  invariant(unsupported.length === 0, `live adapter does not implement ${unsupported[0]?.action ?? "the compiled action"}`);

  const attemptId = `attempt-${randomBytes(8).toString("hex")}`;
  const attemptRoot = path.resolve(outputRoot, "attempts", attemptId);
  const root = path.resolve(outputRoot);
  invariant(attemptRoot.startsWith(`${root}${path.sep}`), "attempt path escaped outputRoot");
  await mkdir(attemptRoot, { recursive: true });
  const fusePath = path.join(attemptRoot, "global-fuse.json");
  const summaryPath = path.join(attemptRoot, "summary.json");
  const manifestPath = path.join(attemptRoot, "attempt.json");
  let persistedFuse = null;
  const coordinator = createExecutionCoordinator({
    plan, approvalHash, attemptId, now,
    onFuse(fuse) {
      if (!persistedFuse) {
        persistedFuse = fuse;
        atomicWriteSync(fusePath, { schemaVersion: "xhs-composite-global-fuse/v1", attemptId, planHash: plan.planHash, ...fuse });
      }
    },
  });
  const signalHandler = () => coordinator.tripFuse("HUMAN_INTERRUPT", { source: "process_signal" });
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  const manifest = {
    schemaVersion: "xhs-composite-attempt/v1",
    attemptId,
    planHash: plan.planHash,
    approvalHash,
    policyHash: plan.policyHash,
    capabilityProfileId: plan.capabilityProfileId,
    capabilityProfileHash: plan.capabilityProfileHash,
    inventorySnapshotHash: plan.inventorySnapshotHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    runtimeInventoryHash: sha256(runtimeDevices.map(({ machine, visibleName, identityHash }) => ({ machine, visibleName, identityHash }))),
    runtimeCapabilityHash: sha256(runtimeDevices.map(({ machine, appVersion, adapterVersion, actionRegistryVersion }) => ({ machine, appVersion, adapterVersion, actionRegistryVersion }))),
    parentEpoch: coordinator.parentEpoch,
    selectedMachines: [...selected],
    admittedMachines: [],
    skippedNotReadyMachines: [],
    status: "prepared",
    createdAt: new Date(typeof now === "function" ? now() : now).toISOString(),
  };
  await atomicWrite(manifestPath, manifest);
  const OperationLedger = dependencies.CompositeOperationLedger ?? CompositeOperationLedger;
  const FeedAdapter = dependencies.AdbFeedAdapter ?? AdbFeedAdapter;
  const DeviceAdapter = dependencies.CompositeDeviceAdapter ?? CompositeDeviceAdapter;
  const runWorkflow = dependencies.runCompositeWorkflow ?? runCompositeWorkflow;
  const loadPageRules = dependencies.loadRules ?? loadRules;
  const operationLedger = await OperationLedger.open({
    filePath: path.join(attemptRoot, "operation-ledger.json"),
    slots: operationSlotsFromPlan(plan),
  });
  const rules = await loadPageRules(runtimeContext.rulesPath);

  async function workerRun(machine) {
    const workerContext = coordinator.admit(machine);
    manifest.admittedMachines.push(machine);
    const runtimeDevice = runtimeDevices.find((entry) => entry.machine === machine);
    const workerRoot = path.join(attemptRoot, machine);
    await mkdir(path.join(workerRoot, "evidence"), { recursive: true });
    let activeAction = null;
    const gate = ({ action } = {}) => {
      if (action) activeAction = action;
      return workerContext.assertFastGate({ action: action ?? activeAction });
    };
    const feedAdapter = new FeedAdapter({
      adbPath: runtimeContext.adbPath,
      serial: runtimeDevice.serial,
      deviceAlias: runtimeDevice.deviceAlias,
      rules,
      runDir: workerRoot,
      sendGate: () => gate(),
    });
    const adapter = new DeviceAdapter({
      feedAdapter,
      rules,
      runtimeProfile: plan.runtimeProfile,
      assertFastGate: gate,
      operationLedger,
      machine,
      titleRules: plan.titleRules ?? [],
      executionContext: { planHash: plan.planHash, attemptId },
      tripFuse: (reason) => coordinator.tripFuse(reason, { machine }),
    });
    try {
      const summary = await runWorkflow({
        plan, approvalHash, attemptId, machine, adapter, outputRoot: path.join(attemptRoot, "workers"), now,
      });
      if (summary.status === "ambiguous") coordinator.tripFuse("AMBIGUOUS_ACCOUNT_STATE", { machine });
      return { machine, visibleName: runtimeDevice.visibleName, status: summary.status, summary };
    } catch (error) {
      if (requiresGlobalFuse(error)) coordinator.tripFuse("SYSTEMIC_SAFETY_FAILURE", { machine });
      return { machine, visibleName: runtimeDevice.visibleName, status: "failed", message: sanitizeMessage(error, runtimeDevices) };
    } finally {
      workerContext.release();
    }
  }

  manifest.status = "running";
  await atomicWrite(manifestPath, manifest);
  const results = [];
  try {
    const machines = [...selected];
    for (let offset = 0; offset < machines.length; offset += plan.limits.maxParallel) {
      if (coordinator.getFuse()) {
        for (const machine of machines.slice(offset)) results.push({ machine, status: "stopped_global_fuse" });
        break;
      }
      results.push(...await Promise.all(machines.slice(offset, offset + plan.limits.maxParallel).map(workerRun)));
    }
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }
  const completed = results.filter((entry) => entry.status === "completed").length;
  const status = completed === results.length ? "completed" : (completed > 0 ? "partial" : "failed");
  manifest.status = status;
  await atomicWrite(manifestPath, manifest);
  const final = {
    schemaVersion: "xhs-task-execution-result/v1",
    attemptId,
    planHash: plan.planHash,
    status,
    completedWorkers: completed,
    selectedWorkers: plan.devices.length,
    globalFuse: coordinator.getFuse(),
    workers: results.map(({ machine, visibleName, status: workerStatus, message }) => ({ machine, visibleName, status: workerStatus, ...(message ? { message } : {}) })),
    paths: { attempt: manifestPath, summary: summaryPath },
  };
  await atomicWrite(summaryPath, final);
  return final;
}
