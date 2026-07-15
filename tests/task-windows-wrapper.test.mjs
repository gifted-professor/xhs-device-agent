import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ACTION_REGISTRY } from "../scripts/composite-action-registry.mjs";
import { activateCapability, hashCapabilityDocument } from "../scripts/composite-capability-activation.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function ps(value) {
  return String(value).replaceAll("'", "''");
}

test("Windows task wrapper performs selected-device read-only preparation and removes its private context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xhs-task-wrapper-"));
  const outputRoot = path.join(root, "output");
  const acceptanceRoot = path.join(root, "acceptance");
  const adbPath = path.join(root, "fake-adb.cmd");
  const adbLog = path.join(root, "adb.log");
  const configPath = path.join(root, "local.psd1");
  const specPath = path.join(root, "task.json");
  const profilePath = path.join(root, "profile.json");
  const evidencePath = path.join(root, "evidence.json");
  const taskId = `wrapper-${process.pid}-${Date.now()}`;

  await writeFile(adbPath, [
    "@echo off",
    `echo %*>>"${adbLog}"`,
    "if \"%1\"==\"devices\" (",
    "  echo List of devices attached",
    "  echo SERIAL_02 device",
    "  exit /b 0",
    ")",
    "if \"%5\"==\"power\" echo mWakefulness=Awake",
    "if \"%5\"==\"policy\" echo mShowingLockscreen=false",
    "if \"%5\"==\"package\" echo versionName=9.1.0",
    "exit /b 0",
    "",
  ].join("\r\n"), "utf8");
  await writeFile(configPath, `@{
    AdbPath = '${ps(adbPath)}'
    Devices = @{ 'SERIAL_02' = 'alias-02'; 'SERIAL_04' = 'alias-04' }
    Machines = @{
      '02' = @{ Name = '机位二'; DeviceAlias = 'alias-02'; PreferenceRank = 1 }
      '04' = @{ Name = '机位四'; DeviceAlias = 'alias-04'; PreferenceRank = 4 }
    }
  }\n`, "utf8");
  const profile = {
    schemaVersion: "xhs-composite-capability/v1",
    capabilityProfileId: "wrapper-accepted-v1",
    profileKind: "production_candidate",
    actionRegistryVersion: "composite-actions/v1",
    allowedActions: Object.keys(ACTION_REGISTRY),
    maxDevices: 2, maxParallel: 2, maxStateChangesTotal: 10, maxStateChangesPerMinute: 4, cpaConcurrency: 2,
    commentLiveCap: { maxScrolls: 3, maxItems: 20 },
    cpaLimits: { providerHardTimeoutMs: 45000 },
    runtimeProfile: {
      validationMode: "startup_strict_runtime_light_account_state_strict", startPolicy: "all_ready",
      readyDeadlineMs: 8000, minReady: 1, snapshotReuseMs: 1500,
      readOnlyFlushIntervalMs: 1000, readOnlyFlushMaxEvents: 32, cpaWorkflowSoftTimeoutMs: 8000,
    },
  };
  const evidence = { schemaVersion: "xhs-capability-evidence/v1", tests: "no-device", deviceGate: "closed" };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`, "utf8");
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  await activateCapability({
    profilePath, evidencePath, acceptanceRoot,
    confirmProfileHash: hashCapabilityDocument(profile),
    confirmEvidenceHash: hashCapabilityDocument(evidence),
    confirmHuman: true,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });
  await writeFile(specPath, `${JSON.stringify({
    schemaVersion: "xhs-task-spec/v1", taskId, capabilityProfileId: profile.capabilityProfileId,
    seed: Buffer.from("windows-wrapper-no-device-v1").toString("base64"),
    deviceSelection: { mode: "explicit", machines: ["02"] }, maxParallel: 1,
    source: { type: "feed", count: 11, candidateCap: 4 }, actions: [],
  })}\n`, "utf8");

  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(projectRoot, "scripts", "Run-TaskWorkflow.ps1"),
    "-SpecPath", specPath, "-ConfigPath", configPath, "-OutputRoot", outputRoot,
    "-AcceptanceRoot", acceptanceRoot, "-Json",
  ], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 30000 });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const publicResult = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
    assert.equal(publicResult.status, "review_required");
    assert.deepEqual(publicResult.selectedMachines, ["02"]);
    assert.match(publicResult.planHash, /^[a-f0-9]{64}$/u);
    const log = await readFile(adbLog, "utf8");
    assert.match(log, /^devices$/mu);
    assert.match(log, /SERIAL_02 -?shell dumpsys (?:power|window|package)/u);
    assert.doesNotMatch(log, /SERIAL_04/u);
    assert.doesNotMatch(log, / input | tap | swipe |monkey|am start|keyevent/iu);
    const runtimeDirectory = path.join(outputRoot, ".runtime");
    assert.deepEqual(await readdir(runtimeDirectory), []);
  } finally {
    await rm(path.join(projectRoot, "data", "locks", "tasks", `${taskId}.lock`), { force: true });
    await rm(path.join(projectRoot, "data", "locks", "alias-02.lock"), { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
