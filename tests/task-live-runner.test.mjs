import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ACTION_REGISTRY } from "../scripts/composite-action-registry.mjs";
import { hashCapabilityDocument } from "../scripts/composite-capability-activation.mjs";
import { prepareLiveTask } from "../scripts/task-live-runner.mjs";
import { executeApprovedTaskPlan } from "../scripts/task-live-executor.mjs";

const fixedNow = () => new Date("2026-07-15T00:00:00.000Z");

function profile() {
  return {
    schemaVersion: "xhs-composite-capability/v1",
    capabilityProfileId: "accepted-task-v1",
    profileKind: "production_candidate",
    actionRegistryVersion: "composite-actions/v1",
    allowedActions: Object.keys(ACTION_REGISTRY),
    maxDevices: 8,
    maxParallel: 8,
    maxStateChangesTotal: 100,
    maxStateChangesPerMinute: 10,
    cpaConcurrency: 2,
    commentLiveCap: { maxScrolls: 3, maxItems: 20 },
    cpaLimits: { providerHardTimeoutMs: 45000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict",
      startPolicy: "all_ready",
      readyDeadlineMs: 8000,
      minReady: 1,
      snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000,
      readOnlyFlushMaxEvents: 32,
      cpaWorkflowSoftTimeoutMs: 8000,
    },
  };
}

function activeCapability() {
  const value = profile();
  return {
    profile: value,
    profileHash: hashCapabilityDocument(value),
    acceptanceHash: "e".repeat(64),
    receipt: { acceptedBy: "human" },
  };
}

function spec(overrides = {}) {
  return {
    schemaVersion: "xhs-task-spec/v1",
    taskId: "live-review-11",
    capabilityProfileId: "accepted-task-v1",
    seed: Buffer.from("live-task-review-seed-v1").toString("base64"),
    deviceSelection: { mode: "explicit", machines: ["02"] },
    maxParallel: 1,
    source: { type: "feed", count: 11, candidateCap: 4 },
    actions: [
      { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
      { target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited" },
    ],
    ...overrides,
  };
}

function runtime(root) {
  return {
    schemaVersion: "xhs-task-runtime-context/v1",
    locksHeld: true,
    adbPath: path.join(root, "private-adb.exe"),
    rulesPath: path.join(root, "rules.json"),
    acceptanceRoot: path.join(root, "acceptance"),
    devices: [
      {
        machine: "02", visibleName: "机位二", deviceAlias: "private-alias-02", serial: "PRIVATE_SERIAL_02",
        identityHash: "2".repeat(64), online: true, unlocked: true, idle: true, preferenceRank: 1,
        appVersion: "9.1", adapterVersion: "2.0.0", actionRegistryVersion: "composite-actions/v1",
      },
      {
        machine: "01", visibleName: "机位一", deviceAlias: "private-alias-01", serial: "PRIVATE_SERIAL_01",
        identityHash: "1".repeat(64), online: false, unlocked: false, idle: false, preferenceRank: 0,
        appVersion: "", adapterVersion: "2.0.0", actionRegistryVersion: "composite-actions/v1",
      },
      {
        machine: "04", visibleName: "机位四", deviceAlias: "private-alias-04", serial: "PRIVATE_SERIAL_04",
        identityHash: "4".repeat(64), online: true, unlocked: true, idle: true, preferenceRank: 4,
        appVersion: "9.1", adapterVersion: "2.0.0", actionRegistryVersion: "composite-actions/v1",
      },
    ],
  };
}

test("live preparation scopes checks to selected 02 and emits one complete review with no mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-live-review-"));
  let executions = 0;
  const result = await prepareLiveTask({
    spec: spec(), runtimeContext: runtime(root), activeCapability: activeCapability(), outputRoot: path.join(root, "out"), now: fixedNow,
    execute: async () => { executions += 1; throw new Error("must not execute before approval"); },
  });
  assert.equal(result.status, "review_required");
  assert.equal(result.deviceMutations, 0);
  assert.equal(executions, 0);
  assert.deepEqual(result.selectedMachines, ["02"]);
  assert.match(result.review, /Machine 02 — 机位二/u);
  assert.doesNotMatch(result.review, /PRIVATE_SERIAL|private-alias/u);
  assert.equal(result.plan.devices[0].steps[0].action, "recover.to_feed");
  assert.equal(result.plan.devices[0].steps.filter((step) => step.action.startsWith("engagement.")).length, 2);
});

test("only the exact reviewed plan hash creates one-shot approval and starts execution once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-live-approval-"));
  const args = {
    spec: spec(), runtimeContext: runtime(root), activeCapability: activeCapability(), outputRoot: path.join(root, "out"), now: fixedNow,
  };
  const review = await prepareLiveTask(args);
  let executions = 0;
  await assert.rejects(() => prepareLiveTask({
    ...args,
    confirmPlanHash: "0".repeat(64),
    execute: async () => { executions += 1; },
  }), /confirmation mismatch/u);
  assert.equal(executions, 0);

  const result = await prepareLiveTask({
    ...args,
    confirmPlanHash: review.planHash,
    execute: async ({ plan, approvalHash }) => {
      executions += 1;
      assert.equal(plan.planHash, review.planHash);
      assert.match(approvalHash, /^[a-f0-9]{64}$/u);
      return { status: "completed", attemptId: "attempt-0123456789abcdef" };
    },
  });
  assert.equal(executions, 1);
  assert.equal(result.status, "completed");
  assert.match(result.approvalId, /^approval-[a-f0-9]{16}$/u);
});

test("auto idle selects by current preference while unrelated offline devices remain diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-live-auto-"));
  const task = spec({
    taskId: "live-auto",
    deviceSelection: { mode: "auto_idle", count: 1 },
    actions: [],
  });
  const result = await prepareLiveTask({
    spec: task, runtimeContext: runtime(root), activeCapability: activeCapability(), outputRoot: path.join(root, "out"), now: fixedNow,
  });
  assert.deepEqual(result.selectedMachines, ["02"]);
});

test("approved live plan completes the parent, slot, ledger, and worker pipeline with fake devices", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-live-pipeline-"));
  const task = spec({ taskId: "live-fake-pipeline", actions: [] });
  class FakeFeedAdapter {}
  class FakeDeviceAdapter {
    async observe(step) { return { status: "observed", pageState: step.action === "feed.open_visible" ? "HOME_FEED" : "IMAGE_NOTE" }; }
    async bindTarget(step) { return { targetHash: "f".repeat(64), observationId: `fake-${step.stepId}`, pageState: "IMAGE_NOTE" }; }
    async sendOnce(_step, binding) { return { status: "verified", targetHash: binding.targetHash, sent: false }; }
    async verify(_step, binding, { sendOutcome }) { return sendOutcome ?? { status: "verified", targetHash: binding.targetHash }; }
  }
  const result = await prepareLiveTask({
    spec: task,
    runtimeContext: runtime(root),
    activeCapability: activeCapability(),
    outputRoot: path.join(root, "out"),
    now: fixedNow,
  });
  const executed = await prepareLiveTask({
    spec: task,
    runtimeContext: runtime(root),
    activeCapability: activeCapability(),
    outputRoot: path.join(root, "out"),
    now: fixedNow,
    confirmPlanHash: result.planHash,
    execute: (args) => executeApprovedTaskPlan({
      ...args,
      dependencies: {
        AdbFeedAdapter: FakeFeedAdapter,
        CompositeDeviceAdapter: FakeDeviceAdapter,
        loadRules: async () => ({}),
      },
    }),
  });
  assert.equal(executed.status, "completed");
  assert.equal(executed.execution.completedWorkers, 1);
  assert.deepEqual(executed.execution.workers.map((entry) => entry.machine), ["02"]);
  assert.equal(JSON.stringify(executed).includes("PRIVATE_SERIAL"), false);
  assert.equal(JSON.stringify(executed).includes("private-alias"), false);
});

test("approved search, direct URL, and research plans pass the unified live executor capability gate", async () => {
  for (const [taskId, source] of [
    ["live-search-source", { type: "search_results", query: "summer commute", count: 2, maxScrollsPerResult: 3 }],
    ["live-url-source", { type: "url_list", urls: ["https://www.xiaohongshu.com/explore/64abcde01234567890fedcba"] }],
    ["live-research-source", {
      type: "research_read_only", topic: "summer commute", seedKeywords: ["office"], sources: ["search"],
      commentMode: "none",
      budgets: {
        wallClockSeconds: 60, maxQueries: 2, maxNotes: 2, maxNotesPerQuery: 1,
        maxResultScrollsPerQuery: 1, maxNoteScrolls: 0, maxCommentPanels: 0,
        maxCommentsPerNote: 0, maxNoNewScrolls: 1,
      },
      aiPolicy: { topicPlanner: false, pageFallback: false, resultAnalysis: false, maxAutomaticCalls: 0 },
    }],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `${taskId}-`));
    const task = spec({ taskId, source, actions: [] });
    class FakeFeedAdapter {}
    class FakeSourceAdapter { constructor() {} }
    class FakeDeviceAdapter {
      async observe() { return { status: "observed", pageState: "UNKNOWN" }; }
      async bindTarget(step) { return { targetHash: "f".repeat(64), observationId: `fake-${step.stepId}`, pageState: "UNKNOWN" }; }
      async sendOnce(_step, binding) { return { status: "verified", targetHash: binding.targetHash, sent: false }; }
      async verify(_step, binding, { sendOutcome }) { return sendOutcome ?? { status: "verified", targetHash: binding.targetHash }; }
    }
    const args = {
      spec: task,
      runtimeContext: runtime(root),
      activeCapability: activeCapability(),
      outputRoot: path.join(root, "out"),
      now: fixedNow,
    };
    const review = await prepareLiveTask(args);
    const executed = await prepareLiveTask({
      ...args,
      confirmPlanHash: review.planHash,
      execute: (input) => executeApprovedTaskPlan({
        ...input,
        dependencies: {
          AdbFeedAdapter: FakeFeedAdapter,
          CompositeDeviceAdapter: FakeDeviceAdapter,
          TaskSourceDeviceAdapter: FakeSourceAdapter,
          createAdbResearchProvider: () => ({}),
          createWindowsLocalOcr: () => null,
          loadLocalEnvironment: async () => {},
          loadRules: async () => ({}),
        },
      }),
    });
    assert.equal(executed.status, "completed");
  }
});

test("short URL live plans fail before workers or device actions are created", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-short-url-"));
  const task = spec({
    taskId: "live-short-url",
    source: { type: "url_list", urls: ["https://xhslink.com/abc123"] },
    actions: [],
  });
  const args = {
    spec: task, runtimeContext: runtime(root), activeCapability: activeCapability(), outputRoot: path.join(root, "out"), now: fixedNow,
  };
  const review = await prepareLiveTask(args);
  await assert.rejects(() => prepareLiveTask({
    ...args,
    confirmPlanHash: review.planHash,
    execute: (input) => executeApprovedTaskPlan(input),
  }), /cannot prebind url-001/u);
});
