import { createHash, createHmac } from "node:crypto";
import { ACTION_REGISTRY, validateCompiledSteps } from "./composite-action-registry.mjs";

const ACTIONS = new Set(Object.keys(ACTION_REGISTRY));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalizeJson(value) {
  const active = new Set();
  const visit = (current) => {
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "number") {
      invariant(Number.isFinite(current), "canonical JSON requires finite numbers");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    invariant(typeof current === "object", `unsupported canonical JSON value: ${typeof current}`);
    invariant(!active.has(current), "canonical JSON does not support cyclic values");
    active.add(current);
    let result;
    if (Array.isArray(current)) {
      result = `[${current.map((entry) => visit(entry)).join(",")}]`;
    } else {
      invariant(isPlainObject(current), "canonical JSON requires plain objects");
      const entries = Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${visit(current[key])}`);
      result = `{${entries.join(",")}}`;
    }
    active.delete(current);
    return result;
  };
  return visit(value);
}

function sha256(value) {
  return createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
}

export function hashPlan(planWithoutHash) {
  invariant(isPlainObject(planWithoutHash), "plan must be an object");
  const { planHash: _ignored, ...hashable } = planWithoutHash;
  return sha256(hashable);
}

export function seededIndex({ seed, compilerVersion, stepId, choiceKind, counter, size }) {
  invariant(typeof seed === "string" && seed.length > 0, "seed is required");
  invariant(typeof compilerVersion === "string" && compilerVersion.length > 0, "compilerVersion is required");
  invariant(typeof stepId === "string" && stepId.length > 0, "stepId is required");
  invariant(typeof choiceKind === "string" && choiceKind.length > 0, "choiceKind is required");
  invariant(Number.isSafeInteger(counter) && counter >= 0, "counter must be a non-negative integer");
  invariant(Number.isSafeInteger(size) && size > 0, "size must be a positive integer");
  const message = ["hmac-sha256-counter-v1", compilerVersion, stepId, choiceKind, String(counter)].join("\u0000");
  const digest = createHmac("sha256", seed).update(message, "utf8").digest();
  return Number(digest.readBigUInt64BE(0) % BigInt(size));
}

function requireInteger(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  invariant(Number.isSafeInteger(value), `${name} must be a finite integer`);
  invariant(value >= minimum && value <= maximum, `${name} is outside its finite bounds`);
}

function validateRange(range, name) {
  invariant(isPlainObject(range), `${name} must be an object`);
  requireInteger(range.min, `${name}.min`);
  requireInteger(range.max, `${name}.max`);
  invariant(range.min <= range.max, `${name}.min must not exceed max`);
}

function chooseCount({ range, seed, compilerVersion, stepId, choiceKind }) {
  const size = range.max - range.min + 1;
  return range.min + seededIndex({ seed, compilerVersion, stepId, choiceKind, counter: 0, size });
}

function selectUniqueOrdinals({ count, range, seed, compilerVersion, machine, choiceKind }) {
  const candidates = Array.from({ length: range.max - range.min + 1 }, (_, index) => range.min + index);
  invariant(count <= candidates.length, `${choiceKind} count exceeds eligible visit ordinals`);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const selected = seededIndex({
      seed, compilerVersion, stepId: `m${machine}.selection`, choiceKind, counter: candidates.length - index, size: index + 1,
    });
    [candidates[index], candidates[selected]] = [candidates[selected], candidates[index]];
  }
  return new Set(candidates.slice(0, count));
}

function deterministicId(prefix, ...parts) {
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function visitPolicyFromRecipe(recipe) {
  return {
    targetValidVisitsPerDevice: recipe.targetValidVisitsPerDevice,
    maxVisitAttemptsPerDevice: recipe.maxVisitAttemptsPerDevice,
    maxSkippedTargetsPerDevice: recipe.maxSkippedTargetsPerDevice,
    maxFeedScrollsPerAttempt: recipe.maxFeedScrollsPerAttempt,
    maxFeedScrollsTotalPerDevice: recipe.maxFeedScrollsTotalPerDevice,
    visibleCandidateCap: recipe.visibleCandidateCap,
    imageContentScrolls: { ...recipe.imageContentScrolls },
    videoAdvances: { ...recipe.videoAdvances },
    commentPolicyRef: recipe.comments.policyRef,
    ensureLikedPerDevice: recipe.engagementsPerDevice.ensureLiked,
    ensureFavoritedPerDevice: recipe.engagementsPerDevice.ensureFavorited,
    eligibleVisitOrdinals: { ...recipe.engagementsPerDevice.eligibleVisitOrdinals },
  };
}

function validateCompileInputs(request, context) {
  invariant(isPlainObject(request), "request must be an object");
  invariant(isPlainObject(context), "compiler context must be an object");
  invariant(!Object.hasOwn(request, "runtimeProfile"), "request-side runtimeProfile override is forbidden");
  invariant(request.schemaVersion === "xhs-composite-request/v1", "unsupported request schemaVersion");
  invariant(request.policyProfileId === "supervised-composite-v1", "unsupported policy profile");
  invariant(typeof request.seed === "string" && request.seed.length >= 24 && request.seed.length <= 128, "seed must be a finite encoded value");
  invariant(/^[A-Za-z0-9+/=_-]+$/.test(request.seed), "seed must be base64/base64url text");
  invariant(Array.isArray(request.devices) && request.devices.length > 0, "explicit devices are required");
  invariant(Array.isArray(request.actionPool) && request.actionPool.length > 0, "finite actionPool is required");
  for (const action of request.actionPool) invariant(ACTIONS.has(action), `unsupported action: ${action}`);
  invariant(new Set(request.actionPool).size === request.actionPool.length, "duplicate actionPool entry");

  const machines = request.devices.map((device) => device.machine);
  const taskIds = request.devices.map((device) => device.taskId);
  invariant(machines.every((machine) => /^[0-9]{2}$/.test(machine)), "machine must use a two-digit number");
  invariant(taskIds.every((taskId) => typeof taskId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(taskId)), "taskId must use the closed safe identifier format");
  invariant(new Set(machines).size === machines.length, "duplicate machine");
  invariant(new Set(taskIds).size === taskIds.length, "duplicate taskId");

  const capability = context.capabilityProfile;
  invariant(isPlainObject(capability), "accepted capability profile is required");
  invariant(request.capabilityProfileId === capability.capabilityProfileId, "capability profile mismatch");
  invariant(request.devices.length <= capability.maxDevices, "device count exceeds capability");
  invariant(request.limits.maxParallel <= request.devices.length, "maxParallel exceeds selected devices");
  invariant(request.limits.maxParallel <= capability.maxParallel, "maxParallel exceeds capability");
  invariant(request.limits.maxStateChangesTotal <= capability.maxStateChangesTotal, "state budget exceeds capability");
  invariant(request.actionPool.every((action) => capability.allowedActions.includes(action)), "action exceeds capability");

  for (const [key, minimum] of Object.entries({
    maxParallel: 1, maxStateChangesTotal: 0, maxReadStepsTotal: 1, maxVisionCallsTotal: 0, maxWallClockMs: 1000,
  })) requireInteger(request.limits[key], `limits.${key}`, { minimum });

  const recipe = request.recipe;
  invariant(isPlainObject(recipe), "recipe is required");
  for (const [key, minimum] of Object.entries({
    targetValidVisitsPerDevice: 1, maxVisitAttemptsPerDevice: 1, maxSkippedTargetsPerDevice: 0,
    maxFeedScrollsPerAttempt: 0, maxFeedScrollsTotalPerDevice: 0, visibleCandidateCap: 1,
  })) requireInteger(recipe[key], `recipe.${key}`, { minimum });
  invariant(recipe.maxVisitAttemptsPerDevice >= recipe.targetValidVisitsPerDevice, "visit attempts must cover target visits");
  validateRange(recipe.imageContentScrolls, "recipe.imageContentScrolls");
  validateRange(recipe.videoAdvances, "recipe.videoAdvances");
  validateRange(recipe.engagementsPerDevice.eligibleVisitOrdinals, "eligibleVisitOrdinals");
  requireInteger(recipe.engagementsPerDevice.ensureLiked, "ensureLiked");
  requireInteger(recipe.engagementsPerDevice.ensureFavorited, "ensureFavorited");
  invariant(recipe.engagementsPerDevice.eligibleVisitOrdinals.max <= recipe.targetValidVisitsPerDevice, "eligible visit exceeds target visits");
  const requestedChanges = request.devices.length * (recipe.engagementsPerDevice.ensureLiked + recipe.engagementsPerDevice.ensureFavorited);
  invariant(requestedChanges <= request.limits.maxStateChangesTotal, "recipe state changes exceed plan budget");
  invariant(requestedChanges <= capability.maxStateChangesTotal, "recipe state changes exceed capability budget");
  invariant(capability.runtimeProfile.minReady <= request.devices.length, "runtime minReady exceeds selected devices");
  invariant(capability.runtimeProfile.cpaWorkflowSoftTimeoutMs < capability.cpaLimits.providerHardTimeoutMs, "CPA soft timeout must be below provider hard timeout");

  invariant(/^[a-f0-9]{64}$/.test(context.policyHash), "policyHash is required");
  invariant(/^[a-f0-9]{64}$/.test(context.capabilityProfileHash), "capabilityProfileHash is required");
  invariant(/^[a-f0-9]{64}$/.test(context.preparationSnapshot?.inventorySnapshotHash), "inventorySnapshotHash is required");
  invariant(/^[a-f0-9]{64}$/.test(context.preparationSnapshot?.capabilitySnapshotHash), "capabilitySnapshotHash is required");
}

function compileDevice(request, context, device) {
  const { recipe, seed } = request;
  const compilerVersion = context.compilerVersion;
  const steps = [];
  let sequence = 0;
  const add = (action, params = {}, when, accountState = false, visitOrdinal = 0) => {
    sequence += 1;
    invariant(sequence <= 999, "compiled worker step count exceeds v1 stepId capacity");
    const stepId = `m${device.machine}.s${String(sequence).padStart(3, "0")}`;
    const step = { stepId, action, ...(when ? { when } : {}), params };
    if (accountState) {
      step.operationId = deterministicId("operation", request.seed, device.machine, visitOrdinal, action);
      step.budgetSlotId = deterministicId("budget", request.seed, device.machine, visitOrdinal, action);
    }
    steps.push(step);
    return step;
  };

  const eligible = recipe.engagementsPerDevice.eligibleVisitOrdinals;
  const likeVisits = selectUniqueOrdinals({
    count: recipe.engagementsPerDevice.ensureLiked, range: eligible, seed, compilerVersion, machine: device.machine, choiceKind: "ensureLikedVisit",
  });
  const favoriteVisits = selectUniqueOrdinals({
    count: recipe.engagementsPerDevice.ensureFavorited, range: eligible, seed, compilerVersion, machine: device.machine, choiceKind: "ensureFavoritedVisit",
  });

  for (let visit = 1; visit <= recipe.targetValidVisitsPerDevice; visit += 1) {
    const openStepId = `m${device.machine}.s${String(sequence + 1).padStart(3, "0")}`;
    const visibleRank = 1 + seededIndex({
      seed, compilerVersion, stepId: openStepId, choiceKind: "visibleRank", counter: visit - 1, size: recipe.visibleCandidateCap,
    });
    add("feed.open_visible", { visibleRank, candidateCap: recipe.visibleCandidateCap, fallback: "feed_scroll_once_then_skip" });
    const detail = add("detail.inspect", {});
    const targetBindingRef = `${detail.stepId}.target`;

    const imageCount = chooseCount({ range: recipe.imageContentScrolls, seed, compilerVersion, stepId: detail.stepId, choiceKind: "imageContentScrolls" });
    for (let index = 0; index < imageCount; index += 1) add("image.scroll_content", { targetBindingRef });

    const observed = add("comments.observe_count", {});
    const opened = add("comments.open", {}, { observationRef: `${observed.stepId}.countBand`, operator: "not_equals", value: "ZERO" });
    add("comments.collect", { policyRef: recipe.comments.policyRef }, { observationRef: `${opened.stepId}.status`, operator: "equals", value: "VERIFIED" });
    add("comments.close", {}, { observationRef: `${opened.stepId}.status`, operator: "equals", value: "VERIFIED" });

    if (likeVisits.has(visit)) add("engagement.ensure_liked", { targetBindingRef }, undefined, true, visit);
    if (favoriteVisits.has(visit)) add("engagement.ensure_favorited", { targetBindingRef }, undefined, true, visit);

    const videoCount = chooseCount({ range: recipe.videoAdvances, seed, compilerVersion, stepId: detail.stepId, choiceKind: "videoAdvances" });
    let videoTargetBindingRef = targetBindingRef;
    for (let index = 0; index < videoCount; index += 1) {
      const advanced = add("video.advance", { targetBindingRef: videoTargetBindingRef });
      videoTargetBindingRef = `${advanced.stepId}.target`;
    }
    add("navigation.return_to_feed", {});
  }

  return { machine: device.machine, taskId: device.taskId, steps };
}

export function compileCompositePlan(request, context) {
  validateCompileInputs(request, context);
  const devices = [...request.devices]
    .sort((left, right) => left.machine.localeCompare(right.machine) || left.taskId.localeCompare(right.taskId))
    .map((device) => compileDevice(request, context, device));
  validateCompiledSteps(devices.flatMap((device) => device.steps), request.limits);

  const planCore = {
    schemaVersion: "xhs-composite-plan/v1",
    policyProfileId: request.policyProfileId,
    policyHash: context.policyHash,
    capabilityProfileId: context.capabilityProfile.capabilityProfileId,
    capabilityProfileHash: context.capabilityProfileHash,
    compilerVersion: context.compilerVersion,
    rng: { algorithm: "hmac-sha256-counter-v1", seed: request.seed },
    inventorySnapshotHash: context.preparationSnapshot.inventorySnapshotHash,
    capabilitySnapshotHash: context.preparationSnapshot.capabilitySnapshotHash,
    capabilityRequirements: {
      actionRegistry: "composite-actions/v1", commentPolicy: "count-adaptive-v1", cpaCommentCountSchema: "cpa-comment-count/v1",
    },
    visitPolicy: visitPolicyFromRecipe(request.recipe),
    devices,
    limits: { ...request.limits },
    runtimeProfile: { ...context.capabilityProfile.runtimeProfile },
    failurePolicyRef: "supervised-failure-policy-v1",
  };
  const coreHash = sha256(planCore);
  const planWithoutHash = { ...planCore, planId: `plan-${coreHash.slice(0, 16)}` };
  return { ...planWithoutHash, planHash: hashPlan(planWithoutHash) };
}
