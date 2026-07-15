import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import {
  canonicalizeJson,
  compileCompositePlan,
  hashPlan,
  seededIndex,
} from "../scripts/composite-plan-core.mjs";
import { schemaErrors } from "./json-schema-lite.mjs";

const execFileAsync = promisify(execFile);
const configUrl = new URL("../config/", import.meta.url);
const fixtureUrl = new URL("./fixtures/", import.meta.url);
const EXPECTED_ACTIONS = new Set([
  "feed.scroll", "feed.open_visible", "detail.inspect", "image.scroll_content",
  "video.advance", "comments.observe_count", "comments.open", "comments.collect",
  "comments.close", "navigation.return_to_feed", "wait.for_condition", "recover.to_feed",
  "engagement.ensure_liked", "engagement.ensure_favorited",
]);

async function json(url, name) {
  return JSON.parse(await readFile(new URL(name, url), "utf8"));
}

function fixtureRequest(count = 2, seed = "ZGV0ZXJtaW5pc3RpYy1zZWVkLTAwMDAwMDAwMDAwMDAwMDA=") {
  return {
    schemaVersion: "xhs-composite-request/v1",
    policyProfileId: "supervised-composite-v1",
    capabilityProfileId: `composite-capability-synthetic-${count}`,
    seed,
    devices: Array.from({ length: count }, (_, index) => ({
      machine: String(count - index).padStart(2, "0"),
      taskId: `task-${String(count - index).padStart(2, "0")}`,
    })),
    actionPool: [...EXPECTED_ACTIONS],
    recipe: {
      targetValidVisitsPerDevice: 2,
      maxVisitAttemptsPerDevice: 4,
      maxSkippedTargetsPerDevice: 2,
      maxFeedScrollsPerAttempt: 1,
      maxFeedScrollsTotalPerDevice: 4,
      visibleCandidateCap: 4,
      imageContentScrolls: { min: 0, max: 2 },
      videoAdvances: { min: 0, max: 1 },
      comments: { policyRef: "count-adaptive-v1" },
      engagementsPerDevice: {
        ensureLiked: 1,
        ensureFavorited: 1,
        eligibleVisitOrdinals: { min: 1, max: 2 },
      },
    },
    limits: {
      maxParallel: count,
      maxStateChangesTotal: count * 2,
      maxReadStepsTotal: count * 40,
      maxVisionCallsTotal: count * 10,
      maxWallClockMs: 900000,
    },
  };
}

function fixtureContext(capability) {
  return {
    compilerVersion: "1.0.0",
    policyHash: "a".repeat(64),
    capabilityProfile: capability,
    capabilityProfileHash: "b".repeat(64),
    preparationSnapshot: {
      inventorySnapshotHash: "c".repeat(64),
      capabilitySnapshotHash: "d".repeat(64),
    },
  };
}

function allSteps(plan) {
  return plan.devices.flatMap((device) => device.steps);
}

function assertNoPrimitiveKeys(value, location = "$") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPrimitiveKeys(entry, `${location}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!["x", "y", "selector", "commands", "script", "url", "path"].includes(key), `${location}.${key}`);
    assertNoPrimitiveKeys(entry, `${location}.${key}`);
  }
}

test("canonical JSON is stable across key order and covers core RFC-compatible values", () => {
  const a = { z: true, nested: { b: 2, a: "雪" }, list: [null, false, 0, -0, 1.5] };
  const b = { list: [null, false, 0, 0, 1.5], nested: { a: "雪", b: 2 }, z: true };
  assert.equal(canonicalizeJson(a), canonicalizeJson(b));
  assert.equal(canonicalizeJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalizeJson({ text: "line\n雪" }), JSON.stringify({ text: "line\n雪" }));
  assert.throws(() => canonicalizeJson({ bad: Number.NaN }), /finite/);
  assert.throws(() => canonicalizeJson({ bad: undefined }), /unsupported/);
});

test("same request and seed produce identical plan and hash", async () => {
  const [capability, planSchema] = await Promise.all([
    json(fixtureUrl, "composite-capability.synthetic-2.json"),
    json(configUrl, "composite-plan.schema.json"),
  ]);
  const request = fixtureRequest(2);
  const context = fixtureContext(capability);
  const a = compileCompositePlan(request, context);
  const b = compileCompositePlan(structuredClone(request), structuredClone(context));
  assert.deepEqual(a, b);
  assert.match(a.planHash, /^[a-f0-9]{64}$/);
  assert.equal(hashPlan(a), a.planHash);
  assert.deepEqual(a.devices.map((device) => device.machine), ["01", "02"]);
  assert.deepEqual(schemaErrors(planSchema, a), []);
});

test("key order and whitespace do not change canonical hash while one material field does", () => {
  const planA = { schemaVersion: "v1", limits: { maxParallel: 2, maxWallClockMs: 10 }, devices: ["01"] };
  const reordered = JSON.parse('{ "devices" : ["01"], "limits" : { "maxWallClockMs" : 10, "maxParallel" : 2 }, "schemaVersion" : "v1" }');
  assert.equal(hashPlan(planA), hashPlan(reordered));
  assert.notEqual(hashPlan(planA), hashPlan({ ...planA, limits: { ...planA.limits, maxWallClockMs: 1 } }));
});

test("planId is deterministic and runtime attemptId is absent", async () => {
  const capability = await json(fixtureUrl, "composite-capability.synthetic-1.json");
  const plan = compileCompositePlan(fixtureRequest(1), fixtureContext(capability));
  assert.match(plan.planId, /^plan-[a-f0-9]{16}$/);
  assert.equal(plan.attemptId, undefined);
  assert.deepEqual(plan.runtimeProfile, capability.runtimeProfile);
});

test("seeded index is deterministic, version-bound, and always inside the finite set", () => {
  let versionDifferences = 0;
  for (let size = 1; size <= 32; size += 1) {
    const args = { seed: "seed", compilerVersion: "1.0.0", stepId: "m01.s001", choiceKind: "visibleRank", counter: 0, size };
    const a = seededIndex(args);
    assert.equal(a, seededIndex(args));
    assert.ok(a >= 0 && a < size);
    if (a !== seededIndex({ ...args, compilerVersion: "2.0.0" })) versionDifferences += 1;
  }
  assert.ok(versionDifferences > 20, "compiler version must materially alter the deterministic stream");
  assert.throws(() => seededIndex({ seed: "x", compilerVersion: "1", stepId: "s", choiceKind: "c", counter: 0, size: 0 }), /size/);
});

test("5,000 seeds and 1/2/4/8-device profiles never widen actions, budgets, or primitive authority", async () => {
  const counts = [1, 2, 4, 8];
  const profiles = new Map(await Promise.all(counts.map(async (count) => [
    count,
    await json(fixtureUrl, `composite-capability.synthetic-${count}.json`),
  ])));
  for (let index = 0; index < 5000; index += 1) {
    const count = counts[index % counts.length];
    const capability = profiles.get(count);
    const seed = Buffer.from(`seed-${index}`.padEnd(32, "_")).toString("base64");
    const request = fixtureRequest(count, seed);
    const plan = compileCompositePlan(request, fixtureContext(capability));
    assert.equal(plan.devices.length, count);
    assert.ok(plan.limits.maxParallel <= capability.maxParallel);
    assert.ok(plan.limits.maxStateChangesTotal <= capability.maxStateChangesTotal);
    for (const step of allSteps(plan)) assert.ok(EXPECTED_ACTIONS.has(step.action), step.action);
    assertNoPrimitiveKeys(plan);
  }
});

test("compiler rejects hidden two-device assumptions and request-side runtime overrides", async () => {
  const initial = await json(configUrl, "composite-capability.initial-v1.json");
  const tooMany = { ...fixtureRequest(4), capabilityProfileId: initial.capabilityProfileId };
  assert.throws(() => compileCompositePlan(tooMany, fixtureContext(initial)), /capability/);
  const valid = { ...fixtureRequest(2), capabilityProfileId: initial.capabilityProfileId };
  assert.throws(() => compileCompositePlan({ ...valid, runtimeProfile: { startPolicy: "all_ready" } }, fixtureContext(initial)), /runtimeProfile/);
  assert.throws(() => compileCompositePlan({ ...valid, limits: { ...valid.limits, maxParallel: 3 } }, fixtureContext(initial)), /selected devices/);
});

test("two fresh Node processes emit byte-identical canonical plans", async () => {
  const capability = await json(fixtureUrl, "composite-capability.synthetic-2.json");
  const request = fixtureRequest(2, Buffer.from("cross-process-seed".padEnd(32, "_")).toString("base64"));
  const context = fixtureContext(capability);
  const moduleUrl = new URL("../scripts/composite-plan-core.mjs", import.meta.url).href;
  const source = `import { compileCompositePlan, canonicalizeJson } from ${JSON.stringify(moduleUrl)};\n`
    + `const plan = compileCompositePlan(${JSON.stringify(request)}, ${JSON.stringify(context)});\n`
    + "process.stdout.write(canonicalizeJson(plan));\n";
  const [a, b] = await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "-e", source]),
    execFileAsync(process.execPath, ["--input-type=module", "-e", source]),
  ]);
  assert.equal(a.stdout, b.stdout);
});
