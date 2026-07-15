import assert from "node:assert/strict";
import test from "node:test";

import { createExecutionCoordinator } from "../scripts/composite-execution-coordinator.mjs";
import { hashPlan } from "../scripts/composite-plan-core.mjs";

function plan() {
  const core = {
    schemaVersion: "xhs-composite-plan/v1", planId: "plan-0123456789abcdef",
    policyProfileId: "supervised-composite-v1", policyHash: "a".repeat(64),
    capabilityProfileId: "accepted-v1", capabilityProfileHash: "b".repeat(64),
    compilerVersion: "2.0.0", rng: { algorithm: "hmac-sha256-counter-v1", seed: "c".repeat(32) },
    inventorySnapshotHash: "c".repeat(64), capabilitySnapshotHash: "d".repeat(64),
    capabilityRequirements: { actionRegistry: "composite-actions/v1", commentPolicy: "count-adaptive-v1", cpaCommentCountSchema: "cpa-comment-count/v1" },
    visitPolicy: {
      targetValidVisitsPerDevice: 1, maxVisitAttemptsPerDevice: 2, maxSkippedTargetsPerDevice: 1,
      maxFeedScrollsPerAttempt: 1, maxFeedScrollsTotalPerDevice: 1, visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 0 }, videoAdvances: { min: 0, max: 0 },
      commentPolicyRef: "count-adaptive-v1", ensureLikedPerDevice: 0, ensureFavoritedPerDevice: 0,
      eligibleVisitOrdinals: { min: 1, max: 1 },
    },
    devices: ["01", "02"].map((machine) => ({
      machine, taskId: `task-${machine}`,
      steps: [{ stepId: `m${machine}.s001`, action: "detail.inspect", params: {} }],
    })),
    limits: { maxParallel: 1, maxStateChangesTotal: 0, maxReadStepsTotal: 2, maxVisionCallsTotal: 0, maxWallClockMs: 60000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict", startPolicy: "all_ready",
      readyDeadlineMs: 8000, minReady: 1, snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000, readOnlyFlushMaxEvents: 8, cpaWorkflowSoftTimeoutMs: 8000,
    },
    failurePolicyRef: "supervised-failure-policy-v1",
  };
  return { ...core, planHash: hashPlan(core) };
}

test("worker ticket and slot are exact, non-transferable, and concurrency bounded", () => {
  const coordinator = createExecutionCoordinator({
    plan: plan(), approvalHash: "e".repeat(64), attemptId: "attempt-0123456789abcdef",
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  const worker = coordinator.admit("01");
  assert.equal(worker.ticket.machine, "01");
  assert.equal(worker.ticket.planHash, plan().planHash);
  assert.equal(worker.assertFastGate({ action: "detail.inspect" }), true);
  assert.throws(() => worker.assertFastGate({ action: "engagement.ensure_liked" }), /outside the worker ticket/u);
  assert.throws(() => coordinator.admit("02"), /no execution slot/u);
  worker.release();
  assert.equal(coordinator.snapshotSlots()[0].state, "released");
  const second = coordinator.admit("02");
  assert.equal(second.machine, "02");
  assert.notEqual(second.slotId, worker.slotId);
});

test("expiry and a monotonic global fuse prevent every later send", () => {
  let now = new Date("2026-07-15T00:00:00.000Z");
  const fuses = [];
  const coordinator = createExecutionCoordinator({
    plan: plan(), approvalHash: "e".repeat(64), attemptId: "attempt-1111111111111111",
    now: () => now, leaseMs: 1000, onFuse: (fuse) => fuses.push(fuse),
  });
  const worker = coordinator.admit("01");
  now = new Date("2026-07-15T00:00:02.000Z");
  assert.throws(() => worker.assertFastGate({ action: "detail.inspect" }), /expired/u);
  const first = coordinator.tripFuse("HUMAN_INTERRUPT", { source: "test" });
  const second = coordinator.tripFuse("OTHER_REASON");
  assert.strictEqual(first, second);
  assert.equal(fuses.length, 1);
  assert.throws(() => worker.assertFastGate({ action: "detail.inspect" }), /global fuse/u);
  assert.equal(coordinator.snapshotSlots()[0].state, "revoked");
});
