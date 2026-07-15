import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashPlan } from "../scripts/composite-plan-core.mjs";
import { runCompositeWorkflow } from "../scripts/composite-workflow.mjs";
import { createFakeClock, createFakeCompositeAdapter } from "./fixtures/fake-composite-adapter.mjs";

function workflowPlan({ steps, runtime = {} }) {
  const core = {
    schemaVersion: "xhs-composite-plan/v1", planId: "plan-0123456789abcdef",
    policyProfileId: "supervised-composite-v1", policyHash: "a".repeat(64),
    capabilityProfileId: "accepted-v1", capabilityProfileHash: "b".repeat(64),
    compilerVersion: "1.0.0", rng: { algorithm: "hmac-sha256-counter-v1", seed: "c".repeat(32) },
    inventorySnapshotHash: "c".repeat(64), capabilitySnapshotHash: "d".repeat(64),
    capabilityRequirements: { actionRegistry: "composite-actions/v1", commentPolicy: "count-adaptive-v1", cpaCommentCountSchema: "cpa-comment-count/v1" },
    visitPolicy: {
      targetValidVisitsPerDevice: 1, maxVisitAttemptsPerDevice: 2, maxSkippedTargetsPerDevice: 1,
      maxFeedScrollsPerAttempt: 1, maxFeedScrollsTotalPerDevice: 2, visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 1 }, videoAdvances: { min: 0, max: 1 },
      commentPolicyRef: "count-adaptive-v1", ensureLikedPerDevice: 1, ensureFavoritedPerDevice: 0,
      eligibleVisitOrdinals: { min: 1, max: 1 },
    },
    devices: [{ machine: "01", taskId: "task-01", steps }],
    limits: { maxParallel: 1, maxStateChangesTotal: 1, maxReadStepsTotal: 20, maxVisionCallsTotal: 5, maxWallClockMs: 60000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict", startPolicy: "all_ready",
      readyDeadlineMs: 8000, minReady: 1, snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000, readOnlyFlushMaxEvents: 8, cpaWorkflowSoftTimeoutMs: 8000,
      ...runtime,
    },
    failurePolicyRef: "supervised-failure-policy-v1",
  };
  return { ...core, planHash: hashPlan(core) };
}

function accountSteps() {
  return [
    { stepId: "m01.s001", action: "detail.inspect", params: {} },
    {
      stepId: "m01.s002", action: "engagement.ensure_liked", params: { targetBindingRef: "m01.s001.target" },
      operationId: "operation-0123456789abcdef", budgetSlotId: "budget-0123456789abcdef",
    },
  ];
}

async function root(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("crashes before and after every account-state phase never send the same operation twice", async () => {
  const phases = ["observed", "target_bound", "intent_recorded", "sent", "verified", "committed"];
  for (const phase of phases) {
    for (const edge of ["before", "after"]) {
      const outputRoot = await root(`xhs-workflow-${edge}-${phase}-`);
      const adapter = createFakeCompositeAdapter();
      const plan = workflowPlan({ steps: accountSteps() });
      await assert.rejects(() => runCompositeWorkflow({
        plan, approvalHash: "e".repeat(64), attemptId: "attempt-0123456789abcdef", machine: "01",
        adapter, outputRoot, crashAt: `${edge}:${phase}:m01.s002`,
      }), /SIMULATED_CRASH/);
      const summary = await runCompositeWorkflow({
        plan, approvalHash: "e".repeat(64), attemptId: "attempt-0123456789abcdef", machine: "01", adapter, outputRoot,
      });
      assert.ok(adapter.sendCount("m01.s002") <= 1, `${edge}:${phase}`);
      assert.equal(summary.planHash, plan.planHash);
      assert.equal(summary.attemptId, "attempt-0123456789abcdef");
    }
  }
});

test("resume skips committed read-only steps and uses observation-only recovery after durable intent or send", async () => {
  const outputRoot = await root("xhs-workflow-resume-");
  const adapter = createFakeCompositeAdapter();
  const plan = workflowPlan({ steps: accountSteps() });
  await assert.rejects(() => runCompositeWorkflow({
    plan, approvalHash: "e".repeat(64), attemptId: "attempt-1111111111111111", machine: "01",
    adapter, outputRoot, crashAt: "after:sent:m01.s002",
  }), /SIMULATED_CRASH/);
  await runCompositeWorkflow({
    plan, approvalHash: "e".repeat(64), attemptId: "attempt-1111111111111111", machine: "01", adapter, outputRoot,
  });
  assert.equal(adapter.sendCount("m01.s001"), 1);
  assert.equal(adapter.sendCount("m01.s002"), 1);
  assert.equal(adapter.calls.some((call) => call.method === "observe" && call.stepId === "m01.s002" && call.recovery), true);
  assert.equal(adapter.verifications.some((entry) => entry.stepId === "m01.s002" && entry.recovery), true);
});

test("target binding is immutable after intent and ambiguous recovery opens a terminal fuse without retry", async () => {
  const outputRoot = await root("xhs-workflow-binding-");
  const adapter = createFakeCompositeAdapter({
    verificationByStep: { "m01.s002": { status: "ambiguous", targetHash: "different-target" } },
  });
  const plan = workflowPlan({ steps: accountSteps() });
  const summary = await runCompositeWorkflow({
    plan, approvalHash: "e".repeat(64), attemptId: "attempt-2222222222222222", machine: "01", adapter, outputRoot,
  });
  assert.equal(summary.status, "ambiguous");
  assert.equal(summary.globalFuse.reason, "AMBIGUOUS_ACCOUNT_STATE");
  assert.equal(adapter.sendCount("m01.s002"), 1);
  const verification = adapter.verifications.find((entry) => entry.stepId === "m01.s002");
  assert.equal(verification.binding.targetHash, "target-m01.s001");
});

test("read-only phases buffer events and flush by count, interval, semantic checkpoint, and terminal state", async () => {
  const clock = createFakeClock(0);
  const adapter = createFakeCompositeAdapter({ clock });
  const durableReasons = [];
  const plan = workflowPlan({
    steps: [
      { stepId: "m01.s001", action: "detail.inspect", params: {} },
      { stepId: "m01.s002", action: "image.scroll_content", params: { targetBindingRef: "m01.s001.target" } },
      { stepId: "m01.s003", action: "navigation.return_to_feed", params: {} },
    ],
    runtime: { readOnlyFlushMaxEvents: 4, readOnlyFlushIntervalMs: 10 },
  });
  const summary = await runCompositeWorkflow({
    plan, approvalHash: "e".repeat(64), attemptId: "attempt-3333333333333333", machine: "01",
    adapter, outputRoot: await root("xhs-workflow-buffer-"), now: clock.now,
    onDurableWrite(reason) { durableReasons.push(reason); },
  });
  assert.equal(summary.status, "completed");
  assert.ok(adapter.flushes.length >= 2);
  assert.ok(adapter.flushes.some((entry) => entry.reason === "count"));
  assert.ok(adapter.flushes.some((entry) => entry.reason === "semantic_checkpoint" || entry.reason === "terminal"));
  assert.equal(durableReasons.filter((reason) => reason.includes("observed") || reason.includes("target_bound")).length, 0);
  assert.ok(durableReasons.length < 3 * 5, "read-only phases must not synchronously persist every event");
});

test("account-state intent, send outcome, verification, ambiguity, and terminal summary bypass buffering", async () => {
  const reasons = [];
  const plan = workflowPlan({ steps: accountSteps() });
  await runCompositeWorkflow({
    plan, approvalHash: "e".repeat(64), attemptId: "attempt-4444444444444444", machine: "01",
    adapter: createFakeCompositeAdapter(), outputRoot: await root("xhs-workflow-durable-"),
    onDurableWrite(reason) { reasons.push(reason); },
  });
  for (const required of ["intent_recorded", "sent", "verified", "committed", "terminal"]) {
    assert.ok(reasons.some((reason) => reason.includes(required)), required);
  }
});

test("a condition-skipped account-state step closes its exact slot without sending", async () => {
  const closed = [];
  const adapter = createFakeCompositeAdapter();
  adapter.closeSkippedOperation = async (step, binding) => closed.push({ stepId: step.stepId, binding });
  const steps = accountSteps();
  steps[1].when = { observationRef: "m01.s001.pageState", operator: "equals", value: "VIDEO_NOTE" };
  const summary = await runCompositeWorkflow({
    plan: workflowPlan({ steps }), approvalHash: "e".repeat(64),
    attemptId: "attempt-5555555555555555", machine: "01", adapter,
    outputRoot: await root("xhs-workflow-skipped-slot-"),
  });
  assert.equal(summary.status, "completed");
  assert.equal(adapter.sendCount("m01.s002"), 0);
  assert.deepEqual(closed, [{ stepId: "m01.s002", binding: { targetHash: "target-m01.s001" } }]);
});

test("verified video advance publishes the new target binding to later account-state work", async () => {
  const steps = [
    { stepId: "m01.s001", action: "detail.inspect", params: {} },
    { stepId: "m01.s002", action: "video.advance", params: { targetBindingRef: "m01.s001.target" } },
    {
      stepId: "m01.s003", action: "engagement.ensure_liked", params: { targetBindingRef: "m01.s002.target" },
      operationId: "operation-2222222222222222", budgetSlotId: "budget-2222222222222222",
    },
  ];
  const adapter = createFakeCompositeAdapter({
    verificationByStep: {
      "m01.s002": { status: "verified", targetHash: "b".repeat(64), observationId: "ui-video-b" },
      "m01.s003": { status: "verified", targetHash: "b".repeat(64) },
    },
  });
  const summary = await runCompositeWorkflow({
    plan: workflowPlan({ steps }), approvalHash: "e".repeat(64),
    attemptId: "attempt-6666666666666666", machine: "01", adapter,
    outputRoot: await root("xhs-workflow-video-binding-"),
  });
  assert.equal(summary.status, "completed");
  const engagementSend = adapter.calls.find((call) => call.method === "sendOnce" && call.stepId === "m01.s003");
  assert.equal(engagementSend.targetHash, "b".repeat(64));
});
