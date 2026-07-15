import { open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ACTION_REGISTRY, validateCompiledSteps } from "./composite-action-registry.mjs";
import { hashPlan } from "./composite-plan-core.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function clone(value) {
  return structuredClone(value);
}

function safeIdentifier(value, name, pattern) {
  invariant(typeof value === "string" && pattern.test(value), `${name} has an invalid format`);
  return value;
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!(["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code))) throw error;
  }
}

function checkpointIdentity({ plan, approvalHash, attemptId, machine, taskId }) {
  return {
    attemptId,
    planId: plan.planId,
    planHash: plan.planHash,
    approvalHash,
    policyProfileId: plan.policyProfileId,
    policyHash: plan.policyHash,
    capabilityProfileId: plan.capabilityProfileId,
    capabilityProfileHash: plan.capabilityProfileHash,
    inventorySnapshotHash: plan.inventorySnapshotHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    machine,
    taskId,
  };
}

function equalIdentity(left, right) {
  return Object.keys(right).every((key) => left?.[key] === right[key]);
}

function evaluateCondition(condition, observations) {
  if (!condition) return true;
  const match = /^(m[0-9]{2}\.s[0-9]{3,5})\.([A-Za-z][A-Za-z0-9_]*)$/.exec(condition.observationRef ?? "");
  invariant(match, "condition observationRef has an invalid format");
  const actual = observations[match[1]]?.[match[2]];
  if (condition.operator === "equals") return actual === condition.value;
  if (condition.operator === "not_equals") return actual !== condition.value;
  if (condition.operator === "in") return Array.isArray(condition.value) && condition.value.includes(actual);
  throw new Error("condition operator is not closed");
}

function verificationStatus(verification, binding, { allowTargetChange = false } = {}) {
  if (!verification || typeof verification !== "object") return "ambiguous";
  if (!allowTargetChange && verification.targetHash && binding?.targetHash && verification.targetHash !== binding.targetHash) return "ambiguous";
  if (["verified", "noop_already_active", "completed"].includes(verification.status)) return "verified";
  if (verification.status === "failed") return "failed";
  return "ambiguous";
}

function summaryFor({ status, identity, checkpoint, globalFuse = null, lastVerifiedState = null }) {
  return {
    schemaVersion: "xhs-composite-attempt-summary/v1",
    status,
    ...identity,
    completedStepIds: [...checkpoint.completedStepIds],
    failedStepIds: status === "failed" && checkpoint.inFlight ? [checkpoint.inFlight.stepId] : [],
    ambiguousStepIds: status === "ambiguous" && checkpoint.inFlight ? [checkpoint.inFlight.stepId] : [],
    globalFuse,
    lastVerifiedState,
  };
}

export async function runCompositeWorkflow({
  plan,
  approvalHash,
  attemptId,
  machine,
  adapter,
  outputRoot,
  now = Date.now,
  crashAt = null,
  onDurableWrite = undefined,
}) {
  invariant(plan && typeof plan === "object", "plan is required");
  invariant(plan.planHash === hashPlan(plan), "plan hash mismatch");
  safeIdentifier(approvalHash, "approvalHash", /^[a-f0-9]{64}$/);
  safeIdentifier(attemptId, "attemptId", /^attempt-[a-f0-9]{16}$/);
  safeIdentifier(machine, "machine", /^[0-9]{2}$/);
  invariant(adapter && typeof adapter === "object", "adapter is required");
  invariant(typeof outputRoot === "string" && outputRoot.length > 0, "outputRoot is required");
  invariant(Array.isArray(plan.devices), "plan devices are required");
  validateCompiledSteps(plan.devices.flatMap((device) => device.steps), plan.limits);

  const worker = plan.devices.find((device) => device.machine === machine);
  invariant(worker, `machine ${machine} is not present in the plan`);
  invariant(plan.devices.filter((device) => device.machine === machine).length === 1, "machine binding is not unique");
  safeIdentifier(worker.taskId, "taskId", /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/);

  const identity = checkpointIdentity({ plan, approvalHash, attemptId, machine, taskId: worker.taskId });
  const attemptDirectory = path.resolve(outputRoot, attemptId, machine);
  const root = path.resolve(outputRoot);
  invariant(attemptDirectory.startsWith(`${root}${path.sep}`), "attempt output path escaped outputRoot");
  const checkpointPath = path.join(attemptDirectory, "checkpoint.json");
  const summaryPath = path.join(attemptDirectory, "summary.json");
  await mkdir(attemptDirectory, { recursive: true });

  let checkpoint = await readJsonIfPresent(checkpointPath);
  if (checkpoint) {
    invariant(checkpoint.schemaVersion === "xhs-composite-checkpoint/v1", "checkpoint schema mismatch");
    invariant(equalIdentity(checkpoint.identity, identity), "checkpoint identity mismatch");
  } else {
    checkpoint = {
      schemaVersion: "xhs-composite-checkpoint/v1",
      identity,
      completedStepIds: [],
      bindings: {},
      observations: {},
      inFlight: null,
      globalFuse: null,
    };
  }

  const completed = new Set(checkpoint.completedStepIds);
  const readOnlyEvents = [];
  let lastFlushAt = now();
  let lastVerifiedState = null;

  const durableWrite = async (reason) => {
    checkpoint.completedStepIds = [...completed];
    await atomicWriteJson(checkpointPath, checkpoint);
    await onDurableWrite?.(reason, clone(checkpoint));
  };

  const flushReadOnly = async (reason) => {
    if (readOnlyEvents.length === 0) return;
    const events = readOnlyEvents.splice(0, readOnlyEvents.length);
    await adapter.flushReadOnly?.(reason, events);
    lastFlushAt = now();
  };

  const queueReadOnly = async (event) => {
    readOnlyEvents.push({ ...event, at: now() });
    const maximum = plan.runtimeProfile.readOnlyFlushMaxEvents;
    const interval = plan.runtimeProfile.readOnlyFlushIntervalMs;
    if (readOnlyEvents.length >= maximum) await flushReadOnly("count");
    else if (now() - lastFlushAt >= interval) await flushReadOnly("interval");
  };

  const crash = (edge, phase, stepId) => {
    if (crashAt === `${edge}:${phase}:${stepId}`) throw new Error(`SIMULATED_CRASH ${crashAt}`);
  };

  const terminal = async (status, globalFuse = null) => {
    await flushReadOnly("terminal");
    checkpoint.globalFuse = globalFuse;
    const summary = summaryFor({ status, identity, checkpoint, globalFuse, lastVerifiedState });
    await atomicWriteJson(summaryPath, summary);
    await onDurableWrite?.("terminal", clone(summary));
    return summary;
  };

  const commitStep = async (step, observation, risk) => {
    crash("before", "committed", step.stepId);
    completed.add(step.stepId);
    checkpoint.observations[step.stepId] = clone(observation ?? {});
    checkpoint.inFlight = null;
    await durableWrite(`${risk}:${step.stepId}:committed`);
    if (risk === "read_only") await queueReadOnly({ stepId: step.stepId, phase: "committed" });
    crash("after", "committed", step.stepId);
  };

  const recoverAccountState = async () => {
    const inFlight = checkpoint.inFlight;
    if (!inFlight) return null;
    const step = worker.steps.find((entry) => entry.stepId === inFlight.stepId);
    invariant(step, "in-flight step is absent from the bound worker plan");
    invariant(ACTION_REGISTRY[step.action]?.risk === "account_state", "only account-state work may be durably in flight");
    invariant(inFlight.operationId === step.operationId, "in-flight operation binding mismatch");
    invariant(inFlight.budgetSlotId === step.budgetSlotId, "in-flight budget binding mismatch");
    invariant(["intent_recorded", "sent", "verified", "ambiguous", "failed"].includes(inFlight.phase), "unsupported in-flight phase");

    if (["ambiguous", "failed"].includes(inFlight.phase)) {
      const reason = inFlight.phase === "ambiguous" ? "AMBIGUOUS_ACCOUNT_STATE" : "FAILED_ACCOUNT_STATE";
      return terminal(inFlight.phase, { reason, stepId: step.stepId, operationId: step.operationId });
    }
    if (inFlight.phase !== "verified") {
      const observed = await adapter.observe(step, { recovery: true, observationOnly: true });
      const verification = await adapter.verify(step, clone(inFlight.binding), { recovery: true, observationOnly: true, observed });
      const status = verificationStatus(verification, inFlight.binding);
      checkpoint.inFlight = { ...inFlight, phase: status, verification: clone(verification), observed: clone(observed) };
      lastVerifiedState = status === "verified" ? clone(verification) : lastVerifiedState;
      await durableWrite(`account_state:${step.stepId}:${status}`);
      if (status !== "verified") {
        const reason = status === "ambiguous" ? "AMBIGUOUS_ACCOUNT_STATE" : "FAILED_ACCOUNT_STATE";
        return terminal(status, { reason, stepId: step.stepId, operationId: step.operationId });
      }
    }
    const observation = { ...(checkpoint.inFlight.observed ?? {}), ...(checkpoint.inFlight.verification ?? {}) };
    await commitStep(step, observation, "account_state");
    return null;
  };

  const recoverySummary = await recoverAccountState();
  if (recoverySummary) return recoverySummary;

  for (const step of worker.steps) {
    if (completed.has(step.stepId)) continue;
    const entry = ACTION_REGISTRY[step.action];
    invariant(entry, `unsupported action: ${step.action}`);
    const risk = entry.risk;

    if (!evaluateCondition(step.when, checkpoint.observations)) {
      if (risk === "account_state") {
        const skippedBinding = checkpoint.bindings[step.params?.targetBindingRef];
        await adapter.closeSkippedOperation?.(step, clone(skippedBinding));
      }
      await commitStep(step, { status: "skipped_condition" }, risk);
      continue;
    }

    crash("before", "observed", step.stepId);
    const observed = await adapter.observe(step, { recovery: false });
    if (risk === "read_only") await queueReadOnly({ stepId: step.stepId, phase: "observed", observed: clone(observed) });
    crash("after", "observed", step.stepId);

    crash("before", "target_bound", step.stepId);
    let binding;
    const bindingReference = step.params?.targetBindingRef;
    if (bindingReference) {
      binding = checkpoint.bindings[bindingReference];
      invariant(binding, `${step.stepId} target binding is unavailable`);
    } else {
      binding = await adapter.bindTarget(step, { observed });
      invariant(binding && typeof binding.targetHash === "string" && binding.targetHash.length > 0, "adapter returned an invalid target binding");
    }
    if (step.action === "detail.inspect") {
      checkpoint.bindings[`${step.stepId}.target`] = clone(binding);
    }
    if (risk === "read_only") await queueReadOnly({ stepId: step.stepId, phase: "target_bound", binding: clone(binding) });
    crash("after", "target_bound", step.stepId);

    if (risk === "account_state") {
      crash("before", "intent_recorded", step.stepId);
      checkpoint.inFlight = {
        stepId: step.stepId,
        action: step.action,
        phase: "intent_recorded",
        operationId: step.operationId,
        budgetSlotId: step.budgetSlotId,
        binding: clone(binding),
        observed: clone(observed),
      };
      await durableWrite(`account_state:${step.stepId}:intent_recorded`);
      crash("after", "intent_recorded", step.stepId);
    }

    crash("before", "sent", step.stepId);
    const sendOutcome = await adapter.sendOnce(step, clone(binding), { observed });
    if (risk === "account_state") {
      checkpoint.inFlight = { ...checkpoint.inFlight, phase: "sent", sendOutcome: clone(sendOutcome) };
      await durableWrite(`account_state:${step.stepId}:sent`);
    } else {
      await queueReadOnly({ stepId: step.stepId, phase: "sent", sendOutcome: clone(sendOutcome) });
    }
    crash("after", "sent", step.stepId);

    crash("before", "verified", step.stepId);
    const verification = await adapter.verify(step, clone(binding), { recovery: false, observed, sendOutcome });
    const status = verificationStatus(verification, binding, { allowTargetChange: step.action === "video.advance" });
    const observation = { ...(observed ?? {}), ...(sendOutcome ?? {}), ...(verification ?? {}) };
    if (risk === "account_state") {
      checkpoint.inFlight = { ...checkpoint.inFlight, phase: status, verification: clone(verification) };
      await durableWrite(`account_state:${step.stepId}:${status}`);
    } else {
      await queueReadOnly({ stepId: step.stepId, phase: status, verification: clone(verification) });
    }
    crash("after", "verified", step.stepId);

    if (status !== "verified") {
      if (risk === "account_state") {
        const reason = status === "ambiguous" ? "AMBIGUOUS_ACCOUNT_STATE" : "FAILED_ACCOUNT_STATE";
        return terminal(status, { reason, stepId: step.stepId, operationId: step.operationId });
      }
      checkpoint.inFlight = { stepId: step.stepId, action: step.action, phase: status };
      return terminal(status, { reason: status === "ambiguous" ? "AMBIGUOUS_READ_ONLY_RESULT" : "FAILED_READ_ONLY_RESULT", stepId: step.stepId });
    }

    if (step.action === "video.advance") {
      invariant(verification.targetHash && verification.targetHash !== binding.targetHash, "video.advance did not return a new target binding");
      checkpoint.bindings[`${step.stepId}.target`] = {
        targetHash: verification.targetHash,
        observationId: verification.observationId,
        pageState: "VIDEO_NOTE",
      };
    }

    lastVerifiedState = clone(verification);
    await commitStep(step, observation, risk);
    if (["comments.close", "navigation.return_to_feed", "navigation.return_to_source", "recover.to_feed"].includes(step.action)) {
      await flushReadOnly("semantic_checkpoint");
    }
  }

  return terminal("completed");
}
