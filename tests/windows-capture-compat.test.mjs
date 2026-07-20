import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(projectRoot, "scripts", "Get-WindowsCaptureCompatibility.ps1");

function inspectBuild(buildNumber) {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-BuildNumber", String(buildNumber),
      "-AsJson",
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test("Windows 10 build 19045 routes Computer Use screenshots to the ADB fallback", () => {
  const result = inspectBuild(19045);

  assert.equal(result.isBorderRequiredApiAvailable, false);
  assert.equal(result.computerUseWindowScreenshotCompatible, false);
  assert.equal(result.reasonCode, "windows_build_below_20348");
  assert.equal(result.fallback, "adb-screenshot-and-ui-hierarchy");
  assert.equal(result.visibleWindowCaptureAvailable, true);
  assert.equal(result.visibleWindowCaptureRecommended, true);
  assert.equal(result.visibleWindowCaptureScript, "scripts/Capture-VisibleWindow.ps1");
});

test("build 20348 and newer allow the Computer Use window screenshot path", () => {
  const result = inspectBuild(20348);

  assert.equal(result.isBorderRequiredApiAvailable, true);
  assert.equal(result.computerUseWindowScreenshotCompatible, true);
  assert.equal(result.reasonCode, "supported");
  assert.equal(result.fallback, "computer-use");
  assert.equal(result.visibleWindowCaptureAvailable, true);
  assert.equal(result.visibleWindowCaptureRecommended, false);
  assert.equal(result.visibleWindowCaptureScript, "scripts/Capture-VisibleWindow.ps1");
});
