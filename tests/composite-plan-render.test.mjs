import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compileCompositePlan, hashPlan } from "../scripts/composite-plan-core.mjs";
import { escapePlanDisplay, renderCompositePlan } from "../scripts/composite-plan-render.mjs";

async function planFixture() {
  const profile = JSON.parse(await readFile(new URL("./fixtures/composite-capability.synthetic-1.json", import.meta.url), "utf8"));
  return compileCompositePlan({
    schemaVersion: "xhs-composite-request/v1", policyProfileId: "supervised-composite-v1",
    capabilityProfileId: profile.capabilityProfileId,
    seed: Buffer.from("render-test".padEnd(32, "_")).toString("base64"),
    devices: [{ machine: "01", taskId: "render-task-01" }],
    actionPool: profile.allowedActions,
    recipe: {
      targetValidVisitsPerDevice: 1, maxVisitAttemptsPerDevice: 2, maxSkippedTargetsPerDevice: 1,
      maxFeedScrollsPerAttempt: 1, maxFeedScrollsTotalPerDevice: 2, visibleCandidateCap: 4,
      imageContentScrolls: { min: 1, max: 1 }, videoAdvances: { min: 1, max: 1 },
      comments: { policyRef: "count-adaptive-v1" },
      engagementsPerDevice: { ensureLiked: 1, ensureFavorited: 1, eligibleVisitOrdinals: { min: 1, max: 1 } },
    },
    limits: { maxParallel: 1, maxStateChangesTotal: 2, maxReadStepsTotal: 40, maxVisionCallsTotal: 10, maxWallClockMs: 60000 },
  }, {
    compilerVersion: "1.0.0", policyHash: "a".repeat(64), capabilityProfile: profile,
    capabilityProfileHash: "b".repeat(64),
    preparationSnapshot: { inventorySnapshotHash: "c".repeat(64), capabilitySnapshotHash: "d".repeat(64) },
  });
}

test("render shows exact machines, steps, branches, budgets, runtime profile, stops, bindings, and hash", async () => {
  const plan = await planFixture();
  const rendered = renderCompositePlan(plan);
  for (const value of [
    plan.planId, plan.planHash, "Machine 01", "render-task-01", "comments.observe_count",
    "not_equals", "maxStateChangesTotal", "startup_strict_runtime_light_account_state_strict",
    "ready_subset_after_deadline", "cpaWorkflowSoftTimeoutMs", "global fuse", plan.capabilityProfileHash,
    plan.inventorySnapshotHash, plan.capabilitySnapshotHash,
  ]) assert.match(rendered, new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("render states the one-confirmation continuous-execution contract", async () => {
  const plan = await planFixture();
  const rendered = renderCompositePlan(plan);
  for (const value of [
    "single confirmation boundary",
    "without intermediate confirmation",
    "required by this compiled plan",
    "Other online machines do not block",
    "must not be substituted after approval",
    "one terminal completion or blocked report",
    "must not be rerun automatically",
  ]) assert.match(rendered, new RegExp(value, "i"));
});

test("renderer escapes Markdown display characters and rejects controls, ANSI, bidi, and newline spoofing", async () => {
  assert.equal(escapePlanDisplay("name|`[x](y)#"), "name\\|\\`\\[x\\]\\(y\\)\\#");
  for (const value of ["evil\n# fake", "evil\u001b[31m", "evil\u202Ehash", "evil\u2066plan"]) {
    assert.throws(() => escapePlanDisplay(value), /control|bidi/);
  }
  const plan = await planFixture();
  plan.devices[0].taskId = "evil\n# fake action";
  plan.planHash = hashPlan(plan);
  assert.throws(() => renderCompositePlan(plan), /control|bidi/);
});

test("renderer rejects a stale or forged plan hash", async () => {
  const plan = await planFixture();
  plan.runtimeProfile.snapshotReuseMs += 1;
  assert.throws(() => renderCompositePlan(plan), /plan hash/);
});
