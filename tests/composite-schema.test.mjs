import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { schemaErrors } from "./json-schema-lite.mjs";

const configUrl = new URL("../config/", import.meta.url);
const fixtureUrl = new URL("./fixtures/", import.meta.url);

const ACTIONS = [
  "feed.scroll", "feed.open_visible", "search.open_results", "search.open_result",
  "content.open_xhs_url", "detail.inspect", "detail.evaluate_title_rule", "image.scroll_content",
  "video.advance", "comments.observe_count", "comments.open", "comments.collect",
  "comments.close", "navigation.return_to_feed", "navigation.return_to_source", "wait.for_condition", "recover.to_feed",
  "engagement.ensure_liked", "engagement.ensure_favorited",
];

const SCHEMAS = [
  "composite-request.schema.json", "composite-plan.schema.json",
  "composite-approval.schema.json", "composite-policy.schema.json",
  "composite-capability.schema.json", "composite-capability-acceptance.schema.json",
  "composite-worker-ticket.schema.json", "composite-attempt.schema.json",
  "cpa-request.schema.json", "cpa-comment-count.schema.json", "task-spec.schema.json",
];

async function json(url, name) {
  return JSON.parse(await readFile(new URL(name, url), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function semanticErrors(kind, value, { capability } = {}) {
  const errors = [];
  const devices = value?.devices ?? [];
  const machines = devices.map((entry) => entry.machine);
  const tasks = devices.map((entry) => entry.taskId).filter(Boolean);
  if (new Set(machines).size !== machines.length) errors.push("duplicate machine");
  if (new Set(tasks).size !== tasks.length) errors.push("duplicate taskId");
  if (value?.limits?.maxParallel > devices.length) errors.push("maxParallel exceeds selected devices");
  if (kind === "plan" && value?.runtimeProfile?.minReady > devices.length) {
    errors.push("minReady exceeds selected devices");
  }
  if (capability && devices.length > capability.maxDevices) errors.push("device count exceeds capability");
  if (capability && value?.limits?.maxParallel > capability.maxParallel) errors.push("parallelism exceeds capability");
  if (capability && value?.limits?.maxStateChangesTotal > capability.maxStateChangesTotal) {
    errors.push("state budget exceeds capability");
  }
  if (kind === "capability") {
    if (value.runtimeProfile.minReady > value.maxDevices) errors.push("minReady exceeds maxDevices");
    if (value.runtimeProfile.cpaWorkflowSoftTimeoutMs >= value.cpaLimits.providerHardTimeoutMs) {
      errors.push("CPA soft timeout must be below provider hard timeout");
    }
  }
  if (kind === "cpaResponse") {
    const count = value?.result?.count;
    const countKind = value?.result?.countKind;
    if ((countKind === "unknown") !== (count === null)) errors.push("unknown count must be null");
  }
  return errors;
}

function errors(kind, schema, value, options) {
  return [...schemaErrors(schema, value), ...semanticErrors(kind, value, options)];
}

function assertClosedObjects(node, location = "$") {
  if (!node || typeof node !== "object") return;
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${location} must reject unknown fields`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "examples" || key === "default") continue;
    if (Array.isArray(value)) value.forEach((item, index) => assertClosedObjects(item, `${location}.${key}[${index}]`));
    else if (value && typeof value === "object") assertClosedObjects(value, `${location}.${key}`);
  }
}

const runtimeProfile = {
  validationMode: "startup_strict_runtime_light_account_state_strict",
  startPolicy: "ready_subset_after_deadline",
  readyDeadlineMs: 8000,
  minReady: 1,
  snapshotReuseMs: 1500,
  readOnlyFlushIntervalMs: 1000,
  readOnlyFlushMaxEvents: 32,
  cpaWorkflowSoftTimeoutMs: 8000,
};

function request() {
  return {
    schemaVersion: "xhs-composite-request/v1",
    policyProfileId: "supervised-composite-v1",
    capabilityProfileId: "composite-capability-initial-v1",
    seed: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    devices: [{ machine: "01", taskId: "task-01" }, { machine: "02", taskId: "task-02" }],
    actionPool: ACTIONS,
    recipe: {
      targetValidVisitsPerDevice: 10,
      maxVisitAttemptsPerDevice: 16,
      maxSkippedTargetsPerDevice: 6,
      maxFeedScrollsPerAttempt: 1,
      maxFeedScrollsTotalPerDevice: 20,
      visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 2 },
      videoAdvances: { min: 0, max: 2 },
      comments: { policyRef: "count-adaptive-v1" },
      engagementsPerDevice: {
        ensureLiked: 1,
        ensureFavorited: 1,
        eligibleVisitOrdinals: { min: 2, max: 9 },
      },
    },
    limits: {
      maxParallel: 2,
      maxStateChangesTotal: 4,
      maxReadStepsTotal: 80,
      maxVisionCallsTotal: 20,
      maxWallClockMs: 900000,
    },
  };
}

function plan() {
  return {
    schemaVersion: "xhs-composite-plan/v1",
    planId: "plan-0123456789abcdef",
    policyProfileId: "supervised-composite-v1",
    policyHash: "a".repeat(64),
    capabilityProfileId: "composite-capability-initial-v1",
    capabilityProfileHash: "b".repeat(64),
    compilerVersion: "1.0.0",
    rng: { algorithm: "hmac-sha256-counter-v1", seed: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
    inventorySnapshotHash: "c".repeat(64),
    capabilitySnapshotHash: "d".repeat(64),
    capabilityRequirements: {
      actionRegistry: "composite-actions/v1",
      commentPolicy: "count-adaptive-v1",
      cpaCommentCountSchema: "cpa-comment-count/v1",
    },
    visitPolicy: {
      targetValidVisitsPerDevice: 2,
      maxVisitAttemptsPerDevice: 4,
      maxSkippedTargetsPerDevice: 2,
      maxFeedScrollsPerAttempt: 1,
      maxFeedScrollsTotalPerDevice: 4,
      visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 2 },
      videoAdvances: { min: 0, max: 1 },
      commentPolicyRef: "count-adaptive-v1",
      ensureLikedPerDevice: 0,
      ensureFavoritedPerDevice: 0,
      eligibleVisitOrdinals: { min: 1, max: 2 },
    },
    devices: [{
      machine: "01",
      taskId: "task-01",
      steps: [
        { stepId: "m01.s001", action: "detail.inspect", params: {} },
        {
          stepId: "m01.s002",
          action: "comments.open",
          when: { observationRef: "m01.s001.status", operator: "equals", value: "VERIFIED" },
          params: {},
        },
      ],
    }],
    limits: { maxParallel: 1, maxStateChangesTotal: 0, maxReadStepsTotal: 10, maxVisionCallsTotal: 2, maxWallClockMs: 60000 },
    runtimeProfile,
    failurePolicyRef: "supervised-failure-policy-v1",
    planHash: "e".repeat(64),
  };
}

test("all composite schemas are Draft 2020-12 and close every object", async () => {
  for (const name of SCHEMAS) {
    const schema = await json(configUrl, name);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assertClosedObjects(schema, name);
  }
});

test("request schema and capability validation reject structural and cross-field escapes", async () => {
  const [schema, capability] = await Promise.all([
    json(configUrl, "composite-request.schema.json"),
    json(configUrl, "composite-capability.initial-v1.json"),
  ]);
  const valid = request();
  assert.deepEqual(errors("request", schema, valid, { capability }), []);
  const invalid = [
    { ...valid, devices: [{ machine: "01", taskId: "one" }, { machine: "01", taskId: "two" }] },
    { ...valid, devices: [{ machine: "1", taskId: "one" }] },
    { ...valid, limits: { ...valid.limits, maxParallel: 3 } },
    { ...valid, limits: { ...valid.limits, maxStateChangesTotal: -1 } },
    { ...valid, limits: { ...valid.limits, surprise: true } },
    { ...valid, runtimeProfile },
  ];
  for (const value of invalid) assert.notDeepEqual(errors("request", schema, value, { capability }), []);

  const threeDevices = clone(valid);
  threeDevices.devices.push({ machine: "03", taskId: "task-03" });
  threeDevices.limits.maxParallel = 3;
  assert.match(errors("request", schema, threeDevices, { capability }).join("\n"), /capability/);
});

test("plan schema exposes exactly the closed action set and typed earlier-observation conditions", async () => {
  const schema = await json(configUrl, "composite-plan.schema.json");
  const valid = plan();
  assert.deepEqual(errors("plan", schema, valid), []);
  const actions = schema.properties.devices.items.properties.steps.items.properties.action.enum;
  assert.deepEqual([...actions].sort(), [...ACTIONS].sort());

  const genericTap = clone(valid);
  genericTap.devices[0].steps[0] = { stepId: "m01.s001", action: "tap", params: { x: 1, y: 2 } };
  assert.notDeepEqual(errors("plan", schema, genericTap), []);

  const expression = clone(valid);
  expression.devices[0].steps[1].when = { expression: "anything()" };
  assert.notDeepEqual(errors("plan", schema, expression), []);
  const attempt = { ...valid, attemptId: "attempt-not-compile-time" };
  assert.notDeepEqual(errors("plan", schema, attempt), []);
});

test("policy, profile, acceptance, ticket, and attempt examples validate with capability-owned runtime tuning", async () => {
  const [policySchema, policy, capabilitySchema, capability, acceptanceSchema, ticketSchema, attemptSchema] = await Promise.all([
    json(configUrl, "composite-policy.schema.json"), json(configUrl, "composite-policy.supervised-v1.json"),
    json(configUrl, "composite-capability.schema.json"), json(configUrl, "composite-capability.initial-v1.json"),
    json(configUrl, "composite-capability-acceptance.schema.json"), json(configUrl, "composite-worker-ticket.schema.json"),
    json(configUrl, "composite-attempt.schema.json"),
  ]);
  assert.deepEqual(errors("policy", policySchema, policy), []);
  assert.equal(policy.businessAuthority.source, "approved_task_spec");
  assert.equal(policy.businessAuthority.templateBehavior, "defaults_only");
  assert.equal(policy.businessAuthority.explicitTaskValuesWin, true);
  assert.equal(policy.businessAuthority.validationScope, "selected_devices_and_required_capabilities");
  assert.equal(policy.businessAuthority.midRunBusinessConfirmation, false);
  assert.equal(policy.commentPolicy.budgetSource, "compiled_plan_within_capability_profile");
  assert.equal(policy.commentPolicy.bandsAreDefaults, true);
  assert.equal(policy.supervision.confirmationMode, "single_plan_approval");
  assert.equal(policy.supervision.postApprovalExecution, "continuous_within_approved_plan");
  assert.equal(policy.supervision.readinessScope, "required_capabilities_only");
  assert.equal(policy.supervision.terminalReportMode, "single_terminal_or_blocked");
  assert.equal(policy.supervision.otherOnlineDevicesBlock, false);
  assert.equal(policy.supervision.deviceSubstitutionAfterApproval, false);
  assert.deepEqual(errors("capability", capabilitySchema, capability), []);
  assert.deepEqual(capability.runtimeProfile, runtimeProfile);

  const acceptance = {
    schemaVersion: "xhs-composite-capability-acceptance/v1", acceptanceId: "acceptance-0123456789abcdef",
    capabilityProfileId: capability.capabilityProfileId, capabilityProfileHash: "a".repeat(64),
    acceptedBy: "human", acceptedAt: "2026-07-15T00:00:00.000Z", acceptanceEvidenceHash: "b".repeat(64),
    acceptedLimits: {
      maxDevices: 2, maxParallel: 2, maxStateChangesTotal: 4, maxStateChangesPerMinute: 4,
      cpaConcurrency: 2, allowedActions: ACTIONS,
    },
  };
  assert.deepEqual(errors("acceptance", acceptanceSchema, acceptance), []);
  assert.notDeepEqual(errors("acceptance", acceptanceSchema, { ...acceptance, acceptedBy: "hermes" }), []);

  const ticket = {
    schemaVersion: "xhs-composite-worker-ticket/v1", ticketId: "ticket-0123456789abcdef",
    attemptId: "attempt-0123456789abcdef", workerId: "worker-01", machine: "01", taskId: "task-01",
    planHash: "a".repeat(64), approvalHash: "b".repeat(64), policyHash: "c".repeat(64),
    capabilityProfileId: capability.capabilityProfileId, capabilityProfileHash: "d".repeat(64),
    inventorySnapshotHash: "e".repeat(64), capabilitySnapshotHash: "f".repeat(64),
    allowedStepIds: ["m01.s001"], allowedOperationIds: [], issuedAt: "2026-07-15T00:00:00.000Z",
    expiresAt: "2026-07-15T00:05:00.000Z", nonce: "ticket-nonce-0123456789", parentEpoch: 1,
  };
  assert.deepEqual(errors("ticket", ticketSchema, ticket), []);

  const attempt = {
    schemaVersion: "xhs-composite-attempt/v1", attemptId: ticket.attemptId, planHash: ticket.planHash,
    approvalHash: ticket.approvalHash, policyHash: ticket.policyHash,
    capabilityProfileId: capability.capabilityProfileId, capabilityProfileHash: ticket.capabilityProfileHash,
    inventorySnapshotHash: ticket.inventorySnapshotHash, capabilitySnapshotHash: ticket.capabilitySnapshotHash,
    runtimeInventoryHash: "1".repeat(64), runtimeCapabilityHash: "2".repeat(64), parentEpoch: 1,
    selectedMachines: ["01", "02"], admittedMachines: ["01"], skippedNotReadyMachines: ["02"],
    status: "prepared", createdAt: "2026-07-15T00:00:00.000Z",
  };
  assert.deepEqual(errors("attempt", attemptSchema, attempt), []);
});

test("synthetic profiles scale structurally but cannot be production-accepted", async () => {
  const schema = await json(configUrl, "composite-capability.schema.json");
  for (const count of [1, 2, 4, 8]) {
    const profile = await json(fixtureUrl, `composite-capability.synthetic-${count}.json`);
    assert.deepEqual(errors("capability", schema, profile), []);
    assert.equal(profile.profileKind, "synthetic_test");
    assert.equal(profile.maxDevices, count);
    assert.equal(profile.maxParallel, count);
  }
});

test("CPA request and response schemas reject authority, coordinates, and count ambiguity", async () => {
  const [requestSchema, responseSchema] = await Promise.all([
    json(configUrl, "cpa-request.schema.json"), json(configUrl, "cpa-comment-count.schema.json"),
  ]);
  const cpaRequest = {
    schemaVersion: "cpa-request/v1", requestId: "123e4567-e89b-12d3-a456-426614174000", role: "comment_count",
    execution: { planHash: "a".repeat(64), attemptId: "attempt-0123456789abcdef", stepId: "m01.s007" },
    artifact: {
      artifactId: "artifact-0123456789abcdef", mediaType: "image/png", sha256: "b".repeat(64),
      byteLength: 123456, width: 400, height: 160, regionKind: "comment_counter", base64: "iVBORw0KGgo=",
    },
  };
  assert.deepEqual(errors("cpaRequest", requestSchema, cpaRequest), []);
  for (const field of ["path", "url", "prompt", "provider", "model", "action", "x", "y", "machine"] ) {
    assert.notDeepEqual(errors("cpaRequest", requestSchema, { ...cpaRequest, [field]: "forbidden" }), []);
  }

  const exactZero = {
    schemaVersion: "cpa-comment-count/v1", requestId: cpaRequest.requestId, artifactSha256: "b".repeat(64),
    status: "ok", result: { count: 0, countKind: "exact", confidence: 1 },
    provider: { adapterId: "default-vision", modelId: "server-configured" },
  };
  const unknown = { ...exactZero, status: "unknown", result: { count: null, countKind: "unknown", confidence: 0 } };
  assert.deepEqual(errors("cpaResponse", responseSchema, exactZero), []);
  assert.deepEqual(errors("cpaResponse", responseSchema, unknown), []);
  assert.notDeepEqual(errors("cpaResponse", responseSchema, { ...exactZero, result: { ...exactZero.result, x: 10 } }), []);
  assert.notDeepEqual(errors("cpaResponse", responseSchema, { ...exactZero, result: { count: null, countKind: "exact", confidence: 1 } }), []);
});

test("approval is exact, human-only, expiring, and one-shot by schema", async () => {
  const schema = await json(configUrl, "composite-approval.schema.json");
  const approval = {
    schemaVersion: "xhs-plan-approval/v1", approvalId: "approval-0123456789abcdef",
    planHash: "a".repeat(64), policyProfileId: "supervised-composite-v1", policyHash: "b".repeat(64),
    capabilityProfileId: "composite-capability-initial-v1", capabilityProfileHash: "c".repeat(64),
    inventorySnapshotHash: "d".repeat(64), capabilitySnapshotHash: "e".repeat(64),
    approvedBy: "human", approvedAt: "2026-07-15T00:00:00.000Z", expiresAt: "2026-07-15T00:05:00.000Z",
    executionNonce: "approval-nonce-0123456789", singleUse: true,
  };
  assert.deepEqual(errors("approval", schema, approval), []);
  assert.notDeepEqual(errors("approval", schema, { ...approval, approved: true }), []);
  assert.notDeepEqual(errors("approval", schema, { ...approval, singleUse: false }), []);
});
