import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { hashPlan } from "../scripts/composite-plan-core.mjs";
import { escapePlanDisplay, renderCompositePlan } from "../scripts/composite-plan-render.mjs";
import { compileUnifiedTaskPlan } from "../scripts/task-compiler.mjs";

async function planFixture() {
  const profile = JSON.parse(await readFile(new URL("./fixtures/composite-capability.synthetic-1.json", import.meta.url), "utf8"));
  return compileUnifiedTaskPlan({
    schemaVersion: "xhs-task-spec/v1",
    taskId: "render-task",
    capabilityProfileId: profile.capabilityProfileId,
    seed: Buffer.from("render-test".padEnd(32, "_")).toString("base64"),
    deviceSelection: { mode: "explicit", machines: ["01"] },
    maxParallel: 1,
    source: { type: "feed", count: 1, candidateCap: 4, maxScrollsPerItem: 1 },
    actions: [
      {
        target: { mode: "ordinal", ordinal: 1 },
        action: "engagement.ensure_liked",
        when: { type: "comment_band", bands: ["SIX_TO_TWENTY"] },
      },
      { target: { mode: "ordinal", ordinal: 1 }, action: "engagement.ensure_favorited" },
    ],
    maxWallClockMs: 60000,
  }, {
    compilerVersion: "2.0.0", policyHash: "a".repeat(64), capabilityProfile: profile,
    capabilityProfileHash: "b".repeat(64),
    preparationSnapshot: {
      inventorySnapshotHash: "c".repeat(64),
      capabilitySnapshotHash: "d".repeat(64),
      devices: [{ machine: "01" }],
    },
  });
}

test("render shows exact machines, steps, branches, budgets, runtime profile, stops, bindings, and hash", async () => {
  const plan = await planFixture();
  const rendered = renderCompositePlan(plan);
  for (const value of [
    plan.planId, plan.planHash, "Machine 01", "render-task-01", "comments.observe_count",
    "SIX_TO_TWENTY", "maxStateChangesTotal", "startup_strict_runtime_light_account_state_strict",
    "ready_subset_after_deadline", "cpaWorkflowSoftTimeoutMs", "global fuse", plan.capabilityProfileHash,
    plan.inventorySnapshotHash, plan.capabilitySnapshotHash,
  ]) assert.match(rendered, new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("render treats planHash as integrity binding without a second conversational approval", async () => {
  const plan = await planFixture();
  const rendered = renderCompositePlan(plan);
  for (const value of [
    "technical integrity binding",
    "without asking for the same authorization again",
    "required by this compiled plan",
    "Other online machines do not block",
    "must not be substituted after integrity binding",
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
