import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

import { ACTION_REGISTRY } from "../scripts/composite-action-registry.mjs";
import { canonicalizeJson, hashPlan, seededIndex } from "../scripts/composite-plan-core.mjs";
import { compileUnifiedTaskPlan } from "../scripts/task-compiler.mjs";

const execFileAsync = promisify(execFile);

function fixture() {
  const task = {
    schemaVersion: "xhs-task-spec/v1",
    taskId: "canonical-plan-test",
    capabilityProfileId: "canonical-capability-v1",
    seed: Buffer.from("canonical-unified-plan-test-v1").toString("base64"),
    deviceSelection: { mode: "explicit", machines: ["02", "04"] },
    maxParallel: 2,
    source: { type: "feed", count: 3, candidateCap: 4 },
    actions: [
      { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
      { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_favorited" },
    ],
  };
  const context = {
    compilerVersion: "2.0.0",
    policyHash: "a".repeat(64),
    capabilityProfileHash: "b".repeat(64),
    capabilityProfile: {
      capabilityProfileId: task.capabilityProfileId,
      maxDevices: 2,
      maxParallel: 2,
      maxStateChangesTotal: 4,
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
    },
    preparationSnapshot: {
      inventorySnapshotHash: "c".repeat(64),
      capabilitySnapshotHash: "d".repeat(64),
      devices: [{ machine: "02" }, { machine: "04" }],
    },
  };
  return { task, context };
}

test("canonical JSON is stable across key order and rejects unsupported values", () => {
  const first = { z: true, nested: { b: 2, a: "snow" }, list: [null, false, 0, -0, 1.5] };
  const second = { list: [null, false, 0, 0, 1.5], nested: { a: "snow", b: 2 }, z: true };
  assert.equal(canonicalizeJson(first), canonicalizeJson(second));
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.throws(() => canonicalizeJson({ bad: Number.NaN }), /finite/);
  assert.throws(() => canonicalizeJson({ bad: undefined }), /unsupported/);
});

test("plan hash ignores its own field but changes on material content", () => {
  const plan = { schemaVersion: "v1", limits: { maxParallel: 2 }, devices: ["02"] };
  const hash = hashPlan(plan);
  assert.equal(hashPlan({ ...plan, planHash: hash }), hash);
  assert.notEqual(hashPlan(plan), hashPlan({ ...plan, limits: { maxParallel: 1 } }));
});

test("seeded index is deterministic, version-bound, and inside the finite set", () => {
  let differences = 0;
  for (let size = 1; size <= 32; size += 1) {
    const args = { seed: "seed", compilerVersion: "2.0.0", stepId: "m02.s00001", choiceKind: "candidate", counter: 0, size };
    const value = seededIndex(args);
    assert.equal(value, seededIndex(args));
    assert.ok(value >= 0 && value < size);
    if (value !== seededIndex({ ...args, compilerVersion: "3.0.0" })) differences += 1;
  }
  assert.ok(differences > 20);
  assert.throws(() => seededIndex({ seed: "x", compilerVersion: "1", stepId: "s", choiceKind: "c", counter: 0, size: 0 }), /size/);
});

test("the unified compiler is byte-deterministic in-process and across fresh processes", async () => {
  const { task, context } = fixture();
  const first = compileUnifiedTaskPlan(task, context);
  const second = compileUnifiedTaskPlan(structuredClone(task), structuredClone(context));
  assert.equal(canonicalizeJson(first), canonicalizeJson(second));
  assert.equal(hashPlan(first), first.planHash);

  const compilerUrl = new URL("../scripts/task-compiler.mjs", import.meta.url).href;
  const coreUrl = new URL("../scripts/composite-plan-core.mjs", import.meta.url).href;
  const source = `import { compileUnifiedTaskPlan } from ${JSON.stringify(compilerUrl)};\n`
    + `import { canonicalizeJson } from ${JSON.stringify(coreUrl)};\n`
    + `process.stdout.write(canonicalizeJson(compileUnifiedTaskPlan(${JSON.stringify(task)}, ${JSON.stringify(context)})));\n`;
  const [left, right] = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", source]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", source]),
  ]);
  assert.equal(left.stdout, right.stdout);
});
