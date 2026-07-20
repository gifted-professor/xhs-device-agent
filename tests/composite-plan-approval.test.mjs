import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashPlan } from "../scripts/composite-plan-core.mjs";
import {
  approvePlan,
  consumeApproval,
  validatePlanForApproval,
} from "../scripts/composite-plan-approval.mjs";

function plan() {
  const value = {
    schemaVersion: "xhs-composite-plan/v1", planId: "plan-0123456789abcdef",
    policyProfileId: "supervised-composite-v1", policyHash: "a".repeat(64),
    capabilityProfileId: "accepted-profile-v1", capabilityProfileHash: "b".repeat(64),
    compilerVersion: "1.0.0", rng: { algorithm: "hmac-sha256-counter-v1", seed: "c".repeat(32) },
    inventorySnapshotHash: "c".repeat(64), capabilitySnapshotHash: "d".repeat(64),
    capabilityRequirements: { actionRegistry: "composite-actions/v1", commentPolicy: "count-adaptive-v1", cpaCommentCountSchema: "cpa-comment-count/v1" },
    visitPolicy: {
      targetValidVisitsPerDevice: 1, maxVisitAttemptsPerDevice: 2, maxSkippedTargetsPerDevice: 1,
      maxFeedScrollsPerAttempt: 1, maxFeedScrollsTotalPerDevice: 2, visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 1 }, videoAdvances: { min: 0, max: 1 },
      commentPolicyRef: "count-adaptive-v1", ensureLikedPerDevice: 0, ensureFavoritedPerDevice: 0,
      eligibleVisitOrdinals: { min: 1, max: 1 },
    },
    devices: [{ machine: "01", taskId: "task-01", steps: [{ stepId: "m01.s001", action: "detail.inspect", params: {} }] }],
    limits: { maxParallel: 1, maxStateChangesTotal: 0, maxReadStepsTotal: 10, maxVisionCallsTotal: 2, maxWallClockMs: 60000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict", startPolicy: "all_ready",
      readyDeadlineMs: 8000, minReady: 1, snapshotReuseMs: 1500, readOnlyFlushIntervalMs: 1000,
      readOnlyFlushMaxEvents: 32, cpaWorkflowSoftTimeoutMs: 8000,
    },
    failurePolicyRef: "supervised-failure-policy-v1",
  };
  return { ...value, planHash: hashPlan(value) };
}

test("approval cannot be embedded in or added to the compiled plan", () => {
  const value = plan();
  assert.doesNotThrow(() => validatePlanForApproval(value));
  assert.throws(() => validatePlanForApproval({ ...value, approved: true }), /unknown property/);
});

test("approval is exact, expiring, hash-bound, and one-shot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-plan-approval-"));
  const value = plan();
  const approved = await approvePlan({
    plan: value, approvalRoot: root, confirmPlanHash: value.planHash,
    now: () => new Date("2026-07-15T00:00:00.000Z"), ttlMs: 60000,
    executionNonce: "approval-nonce-0123456789",
  });
  assert.equal(approved.approval.approvedBy, "human");
  assert.equal(approved.approval.planHash, value.planHash);
  assert.equal(await consumeApproval({
    approvalPath: approved.approvalPath, plan: value, now: () => new Date("2026-07-15T00:00:30.000Z"),
  }), "consumed");
  await assert.rejects(() => consumeApproval({
    approvalPath: approved.approvalPath, plan: value, now: () => new Date("2026-07-15T00:00:31.000Z"),
  }), /replay/);
});

test("wrong confirmation, expiry, atomic collision, and every material binding change fail", async () => {
  const value = plan();
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-plan-approval-fail-"));
  const common = {
    plan: value, approvalRoot: root, confirmPlanHash: value.planHash,
    now: () => new Date("2026-07-15T00:00:00.000Z"), ttlMs: 1000,
    executionNonce: "approval-nonce-fixed-012345",
  };
  await assert.rejects(() => approvePlan({ ...common, confirmPlanHash: "0".repeat(64) }), /confirmation/);
  const approved = await approvePlan(common);
  await assert.rejects(() => approvePlan(common), /already exists|collision/);
  await assert.rejects(() => consumeApproval({
    approvalPath: approved.approvalPath, plan: value, now: () => new Date("2026-07-15T00:00:02.000Z"),
  }), /expired/);

  const mutations = [
    { ...value, policyHash: "f".repeat(64) },
    { ...value, capabilityProfileHash: "f".repeat(64) },
    { ...value, inventorySnapshotHash: "f".repeat(64) },
    { ...value, capabilitySnapshotHash: "f".repeat(64) },
    { ...value, runtimeProfile: { ...value.runtimeProfile, snapshotReuseMs: 1 } },
  ].map((changed) => ({ ...changed, planHash: hashPlan(changed) }));
  for (const changed of mutations) {
    await assert.rejects(() => consumeApproval({
      approvalPath: approved.approvalPath, plan: changed, now: () => new Date("2026-07-15T00:00:00.500Z"),
    }), /binding|plan hash/);
  }
});
