import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ACTION_REGISTRY, validateCompiledSteps } from "../scripts/composite-action-registry.mjs";
import { compileUnifiedTaskPlan, normalizeTaskSpec, resolveTaskMachines } from "../scripts/task-compiler.mjs";
import { schemaErrors } from "./json-schema-lite.mjs";

const configUrl = new URL("../config/", import.meta.url);
const seed = Buffer.from("unified-task-compiler-tests-v1").toString("base64");

function capability(overrides = {}) {
  return {
    capabilityProfileId: "task-capability-test-v1",
    maxDevices: 8,
    maxParallel: 8,
    maxStateChangesTotal: 100000,
    allowedActions: Object.keys(ACTION_REGISTRY),
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
    ...overrides,
  };
}

function spec(overrides = {}) {
  return {
    schemaVersion: "xhs-task-spec/v1",
    taskId: "task-acceptance",
    capabilityProfileId: "task-capability-test-v1",
    seed,
    deviceSelection: { mode: "explicit", machines: ["02"] },
    maxParallel: 1,
    source: { type: "feed", count: 11, candidateCap: 4 },
    actions: [],
    ...overrides,
  };
}

function context(taskSpec, overrides = {}) {
  const machines = overrides.resolvedMachines ?? (taskSpec.deviceSelection.mode === "explicit" ? taskSpec.deviceSelection.machines : []);
  return {
    compilerVersion: "2.0.0",
    policyHash: "a".repeat(64),
    capabilityProfile: capability(),
    capabilityProfileHash: "b".repeat(64),
    preparationSnapshot: {
      inventorySnapshotHash: "c".repeat(64),
      capabilitySnapshotHash: "d".repeat(64),
      devices: machines.map((machine) => ({ machine })),
    },
    ...overrides,
  };
}

function compile(taskSpec, overrides = {}) {
  return compileUnifiedTaskPlan(taskSpec, context(taskSpec, overrides));
}

function actionsAt(plan, ordinal) {
  const steps = plan.devices[0].steps;
  const inspections = steps.flatMap((step, index) => step.action === "detail.inspect" ? [index] : []);
  const start = inspections[ordinal - 1];
  const end = inspections[ordinal] ?? steps.length;
  return steps.slice(start, end).map((step) => step.action);
}

test("task schema and runtime accept the 11-item split engagement plan", async () => {
  const taskSpec = spec({ actions: [
    { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited" },
  ] });
  const schema = JSON.parse(await readFile(new URL("task-spec.schema.json", configUrl), "utf8"));
  assert.deepEqual(schemaErrors(schema, taskSpec), []);
  assert.deepEqual(normalizeTaskSpec(taskSpec).source, { ...taskSpec.source, maxScrollsPerItem: 1 });
  const plan = compile(taskSpec);
  assert.ok(actionsAt(plan, 2).includes("engagement.ensure_liked"));
  assert.ok(actionsAt(plan, 7).includes("engagement.ensure_favorited"));
  assert.equal(plan.limits.maxStateChangesTotal, 2);
  assert.doesNotThrow(() => validateCompiledSteps(plan.devices[0].steps, plan.limits));
});

test("one target may like and favorite in the exact requested order", () => {
  const plan = compile(spec({ actions: [
    { target: { mode: "ordinal", ordinal: 4 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 4 }, action: "engagement.ensure_favorited" },
  ] }));
  assert.deepEqual(actionsAt(plan, 4).filter((action) => action.startsWith("engagement.")), [
    "engagement.ensure_liked", "engagement.ensure_favorited",
  ]);
});

test("multiple likes and favorites remain distinct approved operations", () => {
  const plan = compile(spec({ actions: [
    { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 3 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited" },
    { target: { mode: "ordinal", ordinal: 9 }, action: "engagement.ensure_favorited" },
  ] }));
  const changes = plan.devices[0].steps.filter((step) => step.action.startsWith("engagement."));
  assert.equal(changes.length, 4);
  assert.equal(new Set(changes.map((step) => step.operationId)).size, 4);
  assert.equal(new Set(changes.map((step) => step.budgetSlotId)).size, 4);
});

test("an ordered list of 11 URLs compiles without target substitution", () => {
  const urls = Array.from({ length: 11 }, (_, index) => `https://www.xiaohongshu.com/explore/note_${String(index + 1).padStart(2, "0")}`);
  const taskSpec = spec({ source: { type: "url_list", urls }, actions: [] });
  const plan = compile(taskSpec);
  assert.deepEqual(plan.taskSource.urls.map((entry) => entry.url), urls);
  assert.deepEqual(
    plan.devices[0].steps.filter((step) => step.action === "content.open_xhs_url").map((step) => step.params.urlRef),
    Array.from({ length: 11 }, (_, index) => `url-${String(index + 1).padStart(3, "0")}`),
  );
});

test("comment-band and title rules compile into closed typed branches", () => {
  const plan = compile(spec({ actions: [
    {
      target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked",
      when: { type: "comment_band", bands: ["SIX_TO_TWENTY", "TWENTY_ONE_TO_NINETY_NINE", "HUNDRED_PLUS"] },
    },
    {
      target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited",
      when: { type: "title_contains", text: "穿搭" },
    },
  ] }));
  const like = plan.devices[0].steps.find((step) => step.action === "engagement.ensure_liked");
  const favorite = plan.devices[0].steps.find((step) => step.action === "engagement.ensure_favorited");
  assert.equal(like.when.operator, "in");
  assert.deepEqual(like.when.value, ["SIX_TO_TWENTY", "TWENTY_ONE_TO_NINETY_NINE", "HUNDRED_PLUS"]);
  assert.equal(favorite.when.operator, "equals");
  assert.deepEqual(plan.titleRules, [{ ruleRef: "title-rule-001", operator: "normalized_contains", value: "穿搭" }]);
  assert.equal(plan.limits.maxVisionCallsTotal, 1);
});

test("multi-device plans preserve selected order and user concurrency", () => {
  const taskSpec = spec({
    deviceSelection: { mode: "explicit", machines: ["02", "04", "05"] },
    maxParallel: 3,
    actions: [{ target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" }],
  });
  const plan = compile(taskSpec);
  assert.deepEqual(plan.devices.map((entry) => entry.machine), ["02", "04", "05"]);
  assert.equal(plan.limits.maxParallel, 3);
  assert.equal(plan.limits.maxStateChangesTotal, 3);
});

test("per-machine Feed counts compile to exact finite worker lengths", () => {
  const taskSpec = spec({
    deviceSelection: { mode: "explicit", machines: ["02", "04", "05"] },
    maxParallel: 3,
    source: { type: "feed", count: 11, candidateCap: 4 },
    sourceCountsByMachine: [
      { machine: "02", count: 11 },
      { machine: "04", count: 3 },
      { machine: "05", count: 7 },
    ],
    taskIdsByMachine: [
      { machine: "02", taskId: "batch-worker-a" },
      { machine: "04", taskId: "batch-worker-b" },
      { machine: "05", taskId: "batch-worker-c" },
    ],
  });
  const plan = compile(taskSpec);
  assert.deepEqual(plan.devices.map((entry) => [entry.machine, entry.sourceCount]), [["02", 11], ["04", 3], ["05", 7]]);
  assert.deepEqual(plan.devices.map((entry) => entry.steps.filter((step) => step.action === "detail.inspect").length), [11, 3, 7]);
  assert.deepEqual(plan.taskSource.countsByMachine, taskSpec.sourceCountsByMachine);
  assert.deepEqual(plan.devices.map((entry) => entry.taskId), ["batch-worker-a", "batch-worker-b", "batch-worker-c"]);
  assert.deepEqual(plan.visitPolicy.perDevice.map((entry) => [entry.machine, entry.targetValidVisits]), [["02", 11], ["04", 3], ["05", 7]]);
});

test("auto-idle selection is deterministic and unrelated devices do not block explicit 02", () => {
  const auto = spec({ deviceSelection: { mode: "auto_idle", count: 1 } });
  const inventory = [
    { machine: "04", online: true, unlocked: true, idle: true, preferenceRank: 4 },
    { machine: "02", online: true, unlocked: true, idle: true, preferenceRank: 1 },
    { machine: "01", online: false, unlocked: false, idle: false, preferenceRank: 0 },
    { machine: "03", online: true, unlocked: false, idle: false, preferenceRank: 0 },
  ];
  assert.deepEqual(resolveTaskMachines(auto, inventory), ["02"]);
  const resolved = ["02"];
  const plan = compileUnifiedTaskPlan(auto, context(auto, { resolvedMachines: resolved }));
  assert.deepEqual(plan.devices.map((entry) => entry.machine), ["02"]);

  const explicit = normalizeTaskSpec(spec(), { resolvedMachines: ["04"] });
  assert.deepEqual(explicit.deviceSelection.machines, ["02"]);
});

test("capability limits and duplicate same-action targets fail closed before execution", () => {
  const duplicate = spec({ actions: [
    { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
    { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
  ] });
  assert.throws(() => normalizeTaskSpec(duplicate), /more than once/);

  const unsupported = spec({ source: { type: "search_results", query: "穿搭", count: 3 } });
  assert.throws(() => compileUnifiedTaskPlan(unsupported, context(unsupported, {
    capabilityProfile: capability({ allowedActions: ["detail.inspect"] }),
  })), /unaccepted capability/);
});
