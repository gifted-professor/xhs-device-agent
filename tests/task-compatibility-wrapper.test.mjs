import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("legacy Batch wrapper performs a three-machine exact dry conversion with zero device operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-compat-test-"));
  try {
    const specPath = path.join(root, "legacy-batch.json");
    const outputRoot = path.join(root, "output");
    await writeFile(specPath, JSON.stringify({
      schemaVersion: 1,
      batchId: "legacy-wrapper-001",
      mode: "feed_read_only",
      maxParallel: 2,
      runs: [
        { machine: "02", taskId: "legacy-wrapper-001-02", count: 11 },
        { machine: "04", taskId: "legacy-wrapper-001-04", count: 3 },
        { machine: "05", taskId: "legacy-wrapper-001-05", count: 7 },
      ],
    }), "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "scripts", "Run-TaskCompatibility.ps1"),
      "-Kind", "Batch", "-LegacySpecPath", specPath, "-OutputRoot", outputRoot, "-DryRun", "-Json",
    ], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const publicResult = JSON.parse(result.stdout.trim());
    assert.equal(publicResult.deviceOperations, 0);
    assert.deepEqual(publicResult.selectedMachines, ["02", "04", "05"]);
    const plan = JSON.parse(await readFile(publicResult.paths.plan, "utf8"));
    assert.deepEqual(plan.devices.map((entry) => [entry.machine, entry.sourceCount]), [["02", 11], ["04", 3], ["05", 7]]);
    assert.deepEqual(plan.devices.map((entry) => entry.taskId), [
      "legacy-wrapper-001-02", "legacy-wrapper-001-04", "legacy-wrapper-001-05",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy Feed dry conversion accepts explicit machine numbers without local configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-compat-feed-test-"));
  try {
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "scripts", "Run-TaskCompatibility.ps1"),
      "-Kind", "Feed",
      "-TaskId", "legacy-wrapper-feed-001",
      "-MachineNumbersCsv", "02,04",
      "-Count", "11",
      "-LikeAt", "2",
      "-FavoriteAt", "7",
      "-MaxParallel", "2",
      "-ConfigPath", path.join(root, "missing-local.psd1"),
      "-OutputRoot", path.join(root, "output"),
      "-DryRun", "-Json",
    ], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const publicResult = JSON.parse(result.stdout.trim());
    assert.equal(publicResult.deviceOperations, 0);
    assert.deepEqual(publicResult.selectedMachines, ["02", "04"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
