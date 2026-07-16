import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolvePowerShellExecutable } from "../scripts/powershell-runtime.mjs";

test("PowerShell runtime prefers an installed PowerShell 7 executable", () => {
  const localAppData = path.join("C:\\", "Users", "test", "AppData", "Local");
  const expected = path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe");
  const actual = resolvePowerShellExecutable({
    env: { LOCALAPPDATA: localAppData },
    fileExists: (candidate) => candidate === expected,
    probe: () => false,
  });
  assert.equal(actual, expected);
});

test("PowerShell runtime falls back to Windows PowerShell when pwsh is unavailable", () => {
  const actual = resolvePowerShellExecutable({
    env: {},
    fileExists: () => false,
    probe: () => false,
  });
  assert.equal(actual, "powershell.exe");
});

test("PowerShell runtime accepts a validated explicit override and rejects a missing one", () => {
  assert.equal(resolvePowerShellExecutable({
    env: { XHS_POWERSHELL_PATH: "custom-pwsh.exe" },
    fileExists: () => false,
    probe: (candidate) => candidate === "custom-pwsh.exe",
  }), "custom-pwsh.exe");
  assert.throws(() => resolvePowerShellExecutable({
    env: { XHS_POWERSHELL_PATH: "missing-pwsh.exe" },
    fileExists: () => false,
    probe: () => false,
  }), /does not identify an available PowerShell executable/u);
});
