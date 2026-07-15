import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ACTION_REGISTRY,
  EXPECTED_ACTIONS,
  validateActionInvocation,
  validateCompiledSteps,
} from "../scripts/composite-action-registry.mjs";
import { compileCompositePlan } from "../scripts/composite-plan-core.mjs";

const fixtureUrl = new URL("./fixtures/", import.meta.url);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureUrl), "utf8"));
}

function step(stepId, action, params = {}, extra = {}) {
  return { stepId, action, params, ...extra };
}

test("registry is immutable and contains exactly the 14 approved semantic actions", () => {
  assert.deepEqual(Object.keys(ACTION_REGISTRY).sort(), [...EXPECTED_ACTIONS].sort());
  assert.equal(Object.keys(ACTION_REGISTRY).length, 14);
  assert.ok(Object.isFrozen(ACTION_REGISTRY));
  for (const [name, definition] of Object.entries(ACTION_REGISTRY)) {
    assert.ok(Object.isFrozen(definition), name);
    assert.equal(definition.version, "1");
    assert.ok(["read_only", "account_state"].includes(definition.risk));
    assert.ok(Array.isArray(definition.allowedPages) && definition.allowedPages.length > 0);
    assert.equal(definition.paramsSchema.additionalProperties, false);
    assert.ok(Number.isInteger(definition.observationTtlMs) && definition.observationTtlMs > 0);
    assert.equal(typeof definition.oneSend, "boolean");
    assert.equal(typeof definition.expectedPostcondition, "string");
    assert.ok(["local", "global"].includes(definition.failureClass));
  }
});

test("unknown and generic device primitives are rejected", () => {
  assert.throws(() => validateCompiledSteps([step("m01.s001", "message.send")]), /unsupported action/);
  assert.throws(() => validateCompiledSteps([step("m01.s001", "tap", { x: 1, y: 2 })]), /unsupported action/);
  assert.throws(() => validateCompiledSteps([step("m01.s001", "swipe", { direction: "up" })]), /unsupported action/);
});

test("wait and recovery accept only closed versioned identifiers", () => {
  assert.throws(
    () => validateCompiledSteps([step("m01.s001", "wait.for_condition", { selector: "任意文字" })]),
    /conditionId/,
  );
  assert.throws(
    () => validateCompiledSteps([step("m01.s001", "recover.to_feed", { commands: ["BACK", "tap"] })]),
    /strategyId/,
  );
  assert.doesNotThrow(() => validateCompiledSteps([
    step("m01.s001", "wait.for_condition", { conditionId: "feed_ready", timeoutMs: 5000 }),
    step("m01.s002", "recover.to_feed", { strategyId: "back_once_then_verify" }),
  ]));
});

test("comment panel must be closed before video advance or return", () => {
  const openPanel = [
    step("m01.s001", "detail.inspect"),
    step("m01.s002", "comments.open"),
    step("m01.s003", "video.advance", { targetBindingRef: "m01.s001.target" }),
  ];
  assert.throws(() => validateCompiledSteps(openPanel), /comments\.close/);
  assert.doesNotThrow(() => validateCompiledSteps([
    ...openPanel.slice(0, 2),
    step("m01.s003", "comments.close"),
    step("m01.s004", "video.advance", { targetBindingRef: "m01.s001.target" }),
    step("m01.s005", "navigation.return_to_feed"),
  ]));
});

test("video advance invalidates the old engagement target binding", () => {
  const engageOldVideoAfterAdvance = [
    step("m01.s001", "detail.inspect"),
    step("m01.s002", "video.advance", { targetBindingRef: "m01.s001.target" }),
    step("m01.s003", "engagement.ensure_liked", { targetBindingRef: "m01.s001.target" }, {
      operationId: "operation-0123456789abcdef", budgetSlotId: "budget-0123456789abcdef",
    }),
  ];
  assert.throws(() => validateCompiledSteps(engageOldVideoAfterAdvance), /target binding/);
});

test("per-action parameter caps and allowed page states fail closed", () => {
  assert.throws(() => validateActionInvocation({
    action: "feed.open_visible", pageState: "HOME_FEED",
    params: { visibleRank: 21, candidateCap: 4, fallback: "feed_scroll_once_then_skip" },
  }), /visibleRank/);
  assert.throws(() => validateActionInvocation({
    action: "image.scroll_content", pageState: "VIDEO_NOTE", params: { targetBindingRef: "m01.s001.target" },
  }), /page state/);
  assert.doesNotThrow(() => validateActionInvocation({
    action: "image.scroll_content", pageState: "IMAGE_NOTE", params: { targetBindingRef: "m01.s001.target" },
  }));
});

test("account-state operations require unique non-transferable slots and obey the shared budget", () => {
  const actions = [
    step("m01.s001", "detail.inspect"),
    step("m01.s002", "engagement.ensure_liked", { targetBindingRef: "m01.s001.target" }, {
      operationId: "operation-0123456789abcdef", budgetSlotId: "budget-0123456789abcdef",
    }),
    step("m01.s003", "engagement.ensure_favorited", { targetBindingRef: "m01.s001.target" }, {
      operationId: "operation-fedcba9876543210", budgetSlotId: "budget-fedcba9876543210",
    }),
  ];
  assert.throws(() => validateCompiledSteps(actions, { maxStateChangesTotal: 1 }), /shared state-change budget/);
  assert.doesNotThrow(() => validateCompiledSteps(actions, { maxStateChangesTotal: 2 }));

  const duplicated = structuredClone(actions);
  duplicated[2].operationId = duplicated[1].operationId;
  assert.throws(() => validateCompiledSteps(duplicated, { maxStateChangesTotal: 2 }), /operationId/);
});

test("conditions can reference only an earlier typed observation", () => {
  const future = [
    step("m01.s001", "comments.open", {}, {
      when: { observationRef: "m01.s002.countBand", operator: "not_equals", value: "ZERO" },
    }),
    step("m01.s002", "comments.observe_count"),
  ];
  assert.throws(() => validateCompiledSteps(future), /earlier typed observation/);
});

test("compiler output is accepted by the registry and preserves the global budget", async () => {
  const capability = await fixture("composite-capability.synthetic-2.json");
  const request = {
    schemaVersion: "xhs-composite-request/v1", policyProfileId: "supervised-composite-v1",
    capabilityProfileId: capability.capabilityProfileId,
    seed: Buffer.from("registry-integration".padEnd(32, "_")).toString("base64"),
    devices: [{ machine: "02", taskId: "task-02" }, { machine: "01", taskId: "task-01" }],
    actionPool: [...EXPECTED_ACTIONS],
    recipe: {
      targetValidVisitsPerDevice: 2, maxVisitAttemptsPerDevice: 4, maxSkippedTargetsPerDevice: 2,
      maxFeedScrollsPerAttempt: 1, maxFeedScrollsTotalPerDevice: 4, visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 2 }, videoAdvances: { min: 0, max: 1 },
      comments: { policyRef: "count-adaptive-v1" },
      engagementsPerDevice: { ensureLiked: 1, ensureFavorited: 1, eligibleVisitOrdinals: { min: 1, max: 2 } },
    },
    limits: { maxParallel: 2, maxStateChangesTotal: 4, maxReadStepsTotal: 80, maxVisionCallsTotal: 20, maxWallClockMs: 900000 },
  };
  const plan = compileCompositePlan(request, {
    compilerVersion: "1.0.0", policyHash: "a".repeat(64), capabilityProfile: capability,
    capabilityProfileHash: "b".repeat(64),
    preparationSnapshot: { inventorySnapshotHash: "c".repeat(64), capabilitySnapshotHash: "d".repeat(64) },
  });
  assert.doesNotThrow(() => validateCompiledSteps(plan.devices.flatMap((device) => device.steps), plan.limits));
  assert.equal(plan.devices.flatMap((device) => device.steps).filter((entry) => ACTION_REGISTRY[entry.action].risk === "account_state").length, 4);
});
