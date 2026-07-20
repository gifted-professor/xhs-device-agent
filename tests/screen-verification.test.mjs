import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const actionScript = join(root, "scripts", "Invoke-MatrixAction.ps1");
const windowsOnly = { skip: process.platform !== "win32" };

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runImageHelperChecks(scriptPath, workDirectory) {
  const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(scriptPath)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
foreach ($name in @('Get-ImageDimensions', 'Save-ImageAsPng', 'Get-ImageDifferenceScore', 'Get-ImageDirectorySnapshot', 'Wait-XiaoweiScreenshotArtifact')) {
  $definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  if (!$definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
Add-Type -AssemblyName System.Drawing
$directory = ${quotePowerShell(workDirectory)}
$sameA = Join-Path $directory 'same-a.png'
$sameB = Join-Path $directory 'same-b.png'
$different = Join-Path $directory 'different.jpg'
$normalized = Join-Path $directory 'normalized.png'
$changed = Join-Path $directory 'changed.png'

function New-SolidImage([string]$Path, [int]$Width, [int]$Height, [System.Drawing.Color]$Color, [System.Drawing.Imaging.ImageFormat]$Format) {
  $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear($Color)
    $bitmap.Save($Path, $Format)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

New-SolidImage $sameA 64 96 ([System.Drawing.Color]::FromArgb(32, 64, 96)) ([System.Drawing.Imaging.ImageFormat]::Png)
Copy-Item -LiteralPath $sameA -Destination $sameB
New-SolidImage $different 64 96 ([System.Drawing.Color]::FromArgb(224, 192, 160)) ([System.Drawing.Imaging.ImageFormat]::Jpeg)
Save-ImageAsPng $different $normalized

New-SolidImage $changed 10 10 ([System.Drawing.Color]::Black) ([System.Drawing.Imaging.ImageFormat]::Png)
$snapshot = Get-ImageDirectorySnapshot $directory
$notBefore = [DateTime]::UtcNow.AddSeconds(-2)
New-SolidImage $changed 20 20 ([System.Drawing.Color]::White) ([System.Drawing.Imaging.ImageFormat]::Png)
$detected = Wait-XiaoweiScreenshotArtifact $directory $snapshot $notBefore 1500
if (!$detected) { throw 'Changed screenshot artifact was not detected' }

$normalizedImage = [System.Drawing.Image]::FromFile($normalized)
try {
  [pscustomobject]@{
    sameScore = Get-ImageDifferenceScore $sameA $sameB
    differentScore = Get-ImageDifferenceScore $sameA $different
    normalizedWidth = $normalizedImage.Width
    normalizedHeight = $normalizedImage.Height
    normalizedIsPng = $normalizedImage.RawFormat.Guid -eq [System.Drawing.Imaging.ImageFormat]::Png.Guid
    changedWidth = (Get-ImageDimensions $detected.FullName).width
  } | ConvertTo-Json -Compress
} finally {
  $normalizedImage.Dispose()
}`;
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  );
}

test("Xiaowei screenshots require a bounded temporal ADB correlation check", async () => {
  const source = await readFile(actionScript, "utf8");
  assert.match(source, /screen-verify-before-adb\.png/);
  assert.match(source, /screen-verify-after-adb\.png/);
  assert.match(source, /Wait-XiaoweiScreenshotArtifact \$deviceDir \$beforeSnapshot \$notBeforeUtc/);
  assert.match(source, /exec-out screencap -p/);
  assert.match(source, /StandardOutput\.BaseStream\.CopyTo/);
  assert.doesNotMatch(source, /\/sdcard\/xhs_matrix_(?:screen|failure)[^"']*\.png/);
  assert.match(source, /Get-ImageDifferenceScore \$apiPath \$beforePath/);
  assert.match(source, /Get-ImageDifferenceScore \$apiPath \$afterPath/);
  assert.match(source, /\$minimumDifference -gt 0\.20/);
  assert.match(source, /accepted_and_verified/);
  assert.match(source, /api_unknown_with_verified_adb_read/);
  assert.match(source, /api_inconclusive_adb_artifact_verified/);
  assert.match(source, /The request is never replayed while waiting for its file/);
});

test("image helpers normalize formats, compare content, and detect overwritten artifacts", windowsOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), "xhs-screen-verification-"));
  try {
    const result = runImageHelperChecks(actionScript, directory);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    const check = JSON.parse(output);
    assert.equal(check.sameScore, 0);
    assert.ok(check.differentScore > 0.4, `unexpected difference score: ${check.differentScore}`);
    assert.equal(check.normalizedWidth, 64);
    assert.equal(check.normalizedHeight, 96);
    assert.equal(check.normalizedIsPng, true);
    assert.equal(check.changedWidth, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
