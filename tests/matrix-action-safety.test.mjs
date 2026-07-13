import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const actionScript = join(root, "scripts", "Invoke-MatrixAction.ps1");
const collectScript = join(root, "scripts", "Collect-PhoneAssets.ps1");
const missingConfig = join(tmpdir(), `xhs-missing-${process.pid}.psd1`);
const windowsOnly = { skip: process.platform !== "win32" };

function runAction(args) {
  return spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", actionScript, ...args,
    "-ConfigPath", missingConfig,
  ], { encoding: "utf8" });
}

function runFingerprintCheck(scriptPath) {
  const quotedPath = `'${scriptPath.replaceAll("'", "''")}'`;
  const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quotedPath}, [ref]$tokens, [ref]$errors)
foreach ($name in @('Normalize-UiFingerprintText', 'Get-UiFingerprint')) {
  $definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if (!$definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
$firstPath = [System.IO.Path]::GetTempFileName()
$secondPath = [System.IO.Path]::GetTempFileName()
try {
  Set-Content -LiteralPath $firstPath -Encoding UTF8 -Value '<hierarchy><node class="android.widget.TextView" resource-id="id/note" text="12 likes 2 minutes ago 12:34" content-desc="yesterday 99" clickable="false" enabled="true" checked="false" selected="false" scrollable="false" bounds="[0,0][10,10]" /></hierarchy>'
  Set-Content -LiteralPath $secondPath -Encoding UTF8 -Value '<hierarchy><node class="android.widget.TextView" resource-id="id/note" text="999 likes just now 09:05" content-desc="3 hours ago 1000" clickable="false" enabled="true" checked="false" selected="false" scrollable="false" bounds="[50,80][500,900]" /></hierarchy>'
  if ((Get-UiFingerprint $firstPath) -ne (Get-UiFingerprint $secondPath)) { throw 'Volatile hierarchy fields changed the fingerprint' }
} finally {
  Remove-Item -LiteralPath $firstPath, $secondPath -Force -ErrorAction SilentlyContinue
}`;
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { encoding: "utf8" });
}

test("risk classes match the fixed policy", windowsOnly, async () => {
  const source = await readFile(actionScript, "utf8");
  const readOnlyLine = source.match(/\$readOnlyActions\s*=\s*@\(([^\r\n]+)\)/)?.[1] ?? "";
  const deviceLocalLine = source.match(/\$deviceLocalActions\s*=\s*@\(([^\r\n]+)\)/)?.[1] ?? "";

  for (const action of ["OpenXhs", "OpenProfile", "Home", "Back", "DumpUi", "Screenshot", "Inventory"]) {
    assert.match(readOnlyLine, new RegExp(`"${action}"`));
  }
  assert.doesNotMatch(source, /"Swipe"/);
  for (const action of ["OpenSettings", "TapText", "ScreenOff", "ScreenOn", "PushFile", "InstallApk", "SetResolution", "SetDensity", "ResetDisplay"]) {
    assert.match(deviceLocalLine, new RegExp(`"${action}"`));
  }

  const readOnly = runAction(["-Action", "Home"]);
  assert.notEqual(readOnly.status, 0);
  assert.match(`${readOnly.stdout}${readOnly.stderr}`, /Config not found/);

  const localChange = runAction(["-Action", "OpenSettings"]);
  assert.notEqual(localChange.status, 0);
  assert.match(`${localChange.stdout}${localChange.stderr}`, /changes local device state/);

  const missingRollback = runAction([
    "-Action", "OpenSettings", "-ConfirmAction", "-ConfirmationReason", "test-only",
  ]);
  assert.notEqual(missingRollback.status, 0);
  assert.match(`${missingRollback.stdout}${missingRollback.stderr}`, /RollbackInfo/);
});

test("TapText interaction labels cannot be confirmed or grouped through", windowsOnly, () => {
  const chineseLike = String.fromCodePoint(28857, 36190);
  const spacedChineseLike = String.fromCodePoint(28857, 32, 36190);
  for (const label of ["Like", "favoriteButton", chineseLike, spacedChineseLike]) {
    const result = runAction([
      "-Action", "TapText", "-Text", label, "-Group", "all", "-ConfirmAction",
      "-ConfirmationReason", "test-only",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /permanently blocked/);
  }

  const groupedSafeLabel = runAction([
    "-Action", "TapText", "-Text", "Cancel", "-Group", "all", "-ConfirmAction",
    "-ConfirmationReason", "test-only", "-ExpectText", "Home",
  ]);
  assert.notEqual(groupedSafeLabel.status, 0);
  assert.match(`${groupedSafeLabel.stdout}${groupedSafeLabel.stderr}`, /single-device only/);

  const arbitrarySingleLabel = runAction([
    "-Action", "TapText", "-Text", "Continue", "-Serials", "device-01", "-ConfirmAction",
    "-ConfirmationReason", "test-only", "-ExpectText", "Home",
  ]);
  assert.notEqual(arbitrarySingleLabel.status, 0);
  assert.match(`${arbitrarySingleLabel.stdout}${arbitrarySingleLabel.stderr}`, /allowlist/);
});

test("profile navigation is semantic-only and stable waits are bounded", async () => {
  const [actionSource, collectSource] = await Promise.all([
    readFile(actionScript, "utf8"),
    readFile(collectScript, "utf8"),
  ]);
  assert.doesNotMatch(collectSource, /\*\s*0\.9[35]/);
  assert.match(collectSource, /Find-SemanticTapPoint/);
  assert.match(collectSource, /Profile verification failed: public ID and profile metrics/);
  for (const source of [actionSource, collectSource]) {
    const attributes = source.match(/\$attributeNames\s*=\s*@\(([^\r\n]+)\)/)?.[1] ?? "";
    assert.doesNotMatch(attributes, /bounds/);
    assert.match(source, /Normalize-UiFingerprintText/);
    assert.match(source, /Start-Sleep -Milliseconds 500/);
    assert.match(source, /TimeoutMilliseconds = 8000/);
    assert.match(source, /two identical normalized hierarchy fingerprints/);
  }
  assert.equal([...actionSource].some((character) => character.codePointAt(0) > 127), false);
});

test("fingerprints ignore bounds, counters, relative time, and clocks", windowsOnly, () => {
  for (const scriptPath of [actionScript, collectScript]) {
    const result = runFingerprintCheck(scriptPath);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
});
