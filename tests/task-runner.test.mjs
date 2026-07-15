import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runTaskDryRun } from "../scripts/task-runner.mjs";

async function setup(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-runner-"));
  const specPath = path.join(root, "task.json");
  const outputRoot = path.join(root, "output");
  const task = {
    schemaVersion: "xhs-task-spec/v1",
    taskId: "dry-run-11",
    capabilityProfileId: "planning-capability-v1",
    seed: Buffer.from("task-runner-determinism-v1").toString("base64"),
    deviceSelection: { mode: "explicit", machines: ["02"] },
    maxParallel: 1,
    source: { type: "feed", count: 11, candidateCap: 4 },
    actions: [
      { target: { mode: "ordinal", ordinal: 2 }, action: "engagement.ensure_liked" },
      { target: { mode: "ordinal", ordinal: 7 }, action: "engagement.ensure_favorited" },
    ],
    ...overrides,
  };
  await writeFile(specPath, `${JSON.stringify(task)}\n`, "utf8");
  return { root, specPath, outputRoot, task };
}

test("task dry-run writes a deterministic non-executable full-plan review without device operations", async () => {
  const state = await setup();
  const first = await runTaskDryRun(state);
  const second = await runTaskDryRun(state);
  assert.equal(first.status, "dry_run_review");
  assert.equal(first.executable, false);
  assert.equal(first.deviceOperations, 0);
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.selectedMachines, ["02"]);
  assert.match(first.review, /engagement\.ensure_liked/u);
  assert.match(first.review, /engagement\.ensure_favorited/u);
  assert.match(first.review, new RegExp(`planHash=${first.planHash}`, "u"));
  assert.equal(JSON.parse(await readFile(first.paths.plan, "utf8")).planHash, first.planHash);
  assert.match(await readFile(first.paths.review, "utf8"), /single confirmation boundary/u);
});

test("auto-idle dry-run uses clearly synthetic deterministic machines and cannot become approval", async () => {
  const state = await setup({
    taskId: "dry-run-auto",
    deviceSelection: { mode: "auto_idle", count: 2 },
    maxParallel: 2,
    actions: [],
  });
  const result = await runTaskDryRun(state);
  assert.deepEqual(result.selectedMachines, ["01", "02"]);
  assert.equal(result.executable, false);
  assert.equal(Object.hasOwn(result, "approval"), false);
});
