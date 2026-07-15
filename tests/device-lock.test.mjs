import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockScript = path.join(root, "scripts", "Device-Lock.ps1");

test("device locks reject a second owner and can be reacquired after release", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "xhs-device-lock-"));
  try {
    const command = [
      ". $env:XHS_LOCK_SCRIPT",
      "$first = @(Enter-DeviceLocks -ProjectRoot $env:XHS_LOCK_ROOT -DeviceAliases @('device-01'))",
      "$blocked = $false",
      "try { $second = @(Enter-DeviceLocks -ProjectRoot $env:XHS_LOCK_ROOT -DeviceAliases @('device-01')); Exit-DeviceLocks -Handles $second } catch { $blocked = $true }",
      "Exit-DeviceLocks -Handles $first",
      "$third = @(Enter-DeviceLocks -ProjectRoot $env:XHS_LOCK_ROOT -DeviceAliases @('device-01'))",
      "Exit-DeviceLocks -Handles $third",
      "if (!$blocked -or !$third.Count) { exit 1 }",
    ].join("; ");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command,
    ], {
      encoding: "utf8",
      env: { ...process.env, XHS_LOCK_SCRIPT: lockScript, XHS_LOCK_ROOT: temporaryRoot },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("task locks reject concurrent reuse of one taskId", () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "xhs-task-lock-"));
  try {
    const command = [
      ". $env:XHS_LOCK_SCRIPT",
      "$first = @(Enter-TaskLocks -ProjectRoot $env:XHS_LOCK_ROOT -TaskIds @('feed-task-001'))",
      "$blocked = $false",
      "try { $second = @(Enter-TaskLocks -ProjectRoot $env:XHS_LOCK_ROOT -TaskIds @('feed-task-001')); Exit-DeviceLocks -Handles $second } catch { $blocked = $true }",
      "Exit-DeviceLocks -Handles $first",
      "if (!$blocked) { exit 1 }",
    ].join("; ");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command,
    ], {
      encoding: "utf8",
      env: { ...process.env, XHS_LOCK_SCRIPT: lockScript, XHS_LOCK_ROOT: temporaryRoot },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("feed workers lock device and task before fresh inventory and use both batch barriers", () => {
  const source = readFileSync(path.join(root, "scripts", "Run-FeedWorkflow.ps1"), "utf8");
  const deviceLock = source.indexOf("Enter-DeviceLocks");
  const taskLock = source.indexOf("Enter-TaskLocks");
  const inventory = source.indexOf("$config.AdbPath devices");
  assert.ok(deviceLock >= 0 && taskLock > deviceLock && inventory > taskLock);
  assert.match(source, /Write-FeedBatchReady[\s\S]*?-Stage "lock"[\s\S]*?Wait-FeedBatchBarrier[\s\S]*?-Stage "preflight"/u);
  assert.match(source, /Write-FeedBatchReady[\s\S]*?-Stage "preflight"[\s\S]*?Wait-FeedBatchBarrier[\s\S]*?-Stage "start"/u);
});

test("all multi-step device entry scripts release shared locks in finally blocks", () => {
  for (const file of [
    "Invoke-MatrixAction.ps1",
    "Run-TopicResearch.ps1",
    "Run-FeedWorkflow.ps1",
    "Open-ReviewCandidate.ps1",
    "Open-AccountRampCandidate.ps1",
    "Run-Pipeline.ps1",
  ]) {
    const source = readFileSync(path.join(root, "scripts", file), "utf8");
    assert.match(source, /Device-Lock\.ps1/u, `${file} must use the shared lock helper`);
    assert.match(source, /finally\s*\{[\s\S]*?Exit-DeviceLocks/u, `${file} must release locks in finally`);
  }
});
