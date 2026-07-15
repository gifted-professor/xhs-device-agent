import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { validateCompiledSteps } from "./composite-action-registry.mjs";
import { canonicalizeJson, hashPlan } from "./composite-plan-core.mjs";

const PLAN_KEYS = new Set([
  "schemaVersion", "planId", "policyProfileId", "policyHash", "capabilityProfileId", "capabilityProfileHash",
  "compilerVersion", "rng", "inventorySnapshotHash", "capabilitySnapshotHash", "capabilityRequirements",
  "visitPolicy", "devices", "limits", "runtimeProfile", "failurePolicyRef", "planHash",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function asDate(now) {
  const value = typeof now === "function" ? now() : now ?? new Date();
  const result = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(result.valueOf()), "valid approval time is required");
  return result;
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalizeJson(value), "utf8").digest("hex");
}

async function writeExclusive(filePath, value, collisionName) {
  const handle = await open(filePath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") throw new Error(`${collisionName} collision: already exists`);
    throw error;
  });
  try {
    await handle.writeFile(typeof value === "string" ? value : `${canonicalizeJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function validatePlanForApproval(plan) {
  invariant(plan && typeof plan === "object" && !Array.isArray(plan), "compiled plan is required");
  for (const key of Object.keys(plan)) invariant(PLAN_KEYS.has(key), `unknown property in compiled plan: ${key}`);
  invariant(hashPlan(plan) === plan.planHash, "compiled plan hash mismatch");
  invariant(Array.isArray(plan.devices) && plan.devices.length > 0, "compiled devices are required");
  validateCompiledSteps(plan.devices.flatMap((device) => device.steps), plan.limits);
  return plan;
}

export async function approvePlan({ plan, approvalRoot, confirmPlanHash, now, ttlMs = 300000, executionNonce }) {
  validatePlanForApproval(plan);
  invariant(path.isAbsolute(approvalRoot), "controlled absolute approval root is required");
  invariant(confirmPlanHash === plan.planHash, "exact plan hash confirmation mismatch");
  invariant(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 3600000, "finite approval ttl is required");
  invariant(typeof executionNonce === "string" && executionNonce.length >= 16 && executionNonce.length <= 128, "finite execution nonce is required");
  const approvedAt = asDate(now);
  const approvalId = `approval-${sha256(`${plan.planHash}\0${executionNonce}`).slice(0, 16)}`;
  const approval = {
    schemaVersion: "xhs-plan-approval/v1",
    approvalId,
    planHash: plan.planHash,
    policyProfileId: plan.policyProfileId,
    policyHash: plan.policyHash,
    capabilityProfileId: plan.capabilityProfileId,
    capabilityProfileHash: plan.capabilityProfileHash,
    inventorySnapshotHash: plan.inventorySnapshotHash,
    capabilitySnapshotHash: plan.capabilitySnapshotHash,
    approvedBy: "human",
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(approvedAt.valueOf() + ttlMs).toISOString(),
    executionNonce,
    singleUse: true,
  };
  await mkdir(approvalRoot, { recursive: true, mode: 0o700 });
  const approvalPath = path.join(approvalRoot, `${approvalId}.json`);
  await writeExclusive(approvalPath, approval, "approval");
  return { approval, approvalPath, approvalHash: sha256(approval) };
}

export async function consumeApproval({ approvalPath, plan, now }) {
  validatePlanForApproval(plan);
  invariant(path.isAbsolute(approvalPath), "controlled absolute approval path is required");
  invariant(/^approval-[a-f0-9]{16}\.json$/.test(path.basename(approvalPath)), "approval filename is invalid");
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  invariant(approval.approvedBy === "human" && approval.singleUse === true, "approval is not exact human one-shot authorization");
  invariant(asDate(now).valueOf() <= new Date(approval.expiresAt).valueOf(), "approval expired");
  const bindings = [
    ["plan hash", approval.planHash, plan.planHash],
    ["policy profile", approval.policyProfileId, plan.policyProfileId],
    ["policy hash", approval.policyHash, plan.policyHash],
    ["capability profile", approval.capabilityProfileId, plan.capabilityProfileId],
    ["capability profile hash", approval.capabilityProfileHash, plan.capabilityProfileHash],
    ["inventory snapshot hash", approval.inventorySnapshotHash, plan.inventorySnapshotHash],
    ["capability snapshot hash", approval.capabilitySnapshotHash, plan.capabilitySnapshotHash],
  ];
  for (const [name, approved, current] of bindings) invariant(approved === current, `approval binding mismatch: ${name}`);
  const marker = path.join(path.dirname(approvalPath), `${approval.approvalId}.${sha256(approval.executionNonce).slice(0, 16)}.consumed`);
  await writeExclusive(marker, `${approval.planHash}\n`, "approval replay").catch((error) => {
    if (/already exists|collision/.test(error.message)) throw new Error("approval replay detected");
    throw error;
  });
  return "consumed";
}
