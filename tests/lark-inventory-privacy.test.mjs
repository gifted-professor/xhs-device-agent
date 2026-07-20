import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = path.join(ROOT, "scripts", "Lark-InventoryPolicy.ps1");
const SYNC = path.join(ROOT, "scripts", "Sync-LarkBase.ps1");
const COLLECT = path.join(ROOT, "scripts", "Collect-PhoneAssets.ps1");
const PIPELINE = path.join(ROOT, "scripts", "Run-Pipeline.ps1");

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(source) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("Lark inventory projection emits only the closed safe allowlist", () => {
  const source = `
. ${psLiteral(POLICY)}
$row = [pscustomobject]@{
  serial = 'R58M123456Z'; model = 'Pixel 8'; brand = 'Google'; androidVersion = '15';
  securityPatch = '2026-06-05'; resolution = '1080x2400'; density = '420'; batteryLevel = '87';
  xhsVersion = '9.1.0'; profileDetected = $true; collectedAt = '2026-07-14 09:30:00';
  wlanIp = '192.168.50.23'; xhsNickname = 'private-account'; xhsPublicId = '9384756102';
  xhsPrivatePosts = '17'; xhsProfileDetails = 'login secret should stay local'
}
$safe = @(ConvertTo-LarkSafeInventory -Inventory @($row) -DeviceAliases @{ 'R58M123456Z' = 'device-01' })
$json = $safe | ConvertTo-Json -Depth 5 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`;
  const result = runPowerShell(source);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const encoded = result.stdout.trim().split(/\r?\n/u).at(-1);
  const safe = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(safe), [
    "设备编号", "手机型号", "品牌", "Android版本", "安全补丁", "分辨率",
    "屏幕密度", "电量", "小红书版本", "页面结构已采集", "采集时间",
  ]);
  assert.equal(safe["设备编号"], "device-01");
  const serialized = JSON.stringify(safe);
  for (const privateValue of [
    "R58M123456Z", "192.168.50.23", "private-account", "9384756102", "17", "login secret",
  ]) {
    assert.equal(serialized.includes(privateValue), false, `leaked private value: ${privateValue}`);
  }
});

test("Lark projection rejects missing, raw, network-like, and duplicate aliases", () => {
  const cases = [
    "@{}",
    "@{ 'R58M123456Z' = 'R58M123456Z' }",
    "@{ 'R58M123456Z' = '192.168.1.9' }",
  ];
  for (const mapping of cases) {
    const source = `
. ${psLiteral(POLICY)}
$row = [pscustomobject]@{
  serial = 'R58M123456Z'; model = 'Pixel 8'; brand = 'Google'; androidVersion = '15';
  securityPatch = '2026-06-05'; resolution = '1080x2400'; density = '420'; batteryLevel = '87';
  xhsVersion = '9.1.0'; profileDetected = $true; collectedAt = '2026-07-14 09:30:00';
  wlanIp = ''; xhsNickname = ''; xhsPublicId = ''
}
ConvertTo-LarkSafeInventory -Inventory @($row) -DeviceAliases ${mapping} | Out-Null
`;
    const result = runPowerShell(source);
    assert.notEqual(result.status, 0, `unsafe mapping unexpectedly passed: ${mapping}`);
  }

  const duplicate = runPowerShell(`
. ${psLiteral(POLICY)}
$base = @{ model = 'Pixel 8'; brand = 'Google'; androidVersion = '15'; securityPatch = '2026-06-05'; resolution = '1080x2400'; density = '420'; batteryLevel = '87'; xhsVersion = '9.1.0'; profileDetected = $true; collectedAt = '2026-07-14 09:30:00'; wlanIp = ''; xhsNickname = ''; xhsPublicId = '' }
$one = [pscustomobject]($base + @{ serial = 'serial-one' })
$two = [pscustomobject]($base + @{ serial = 'serial-two' })
ConvertTo-LarkSafeInventory -Inventory @($one, $two) -DeviceAliases @{ 'serial-one' = 'device-01'; 'serial-two' = 'device-01' } | Out-Null
`);
  assert.notEqual(duplicate.status, 0, "duplicate aliases unexpectedly passed");
});

test("Sync-LarkBase rejects an old full inventory CSV before any Lark command", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xhs-lark-privacy-"));
  try {
    const csv = path.join(directory, "unsafe.csv");
    writeFileSync(csv, '\uFEFF"设备编号","ADB序列号","WLAN地址","私密笔记"\r\n"device-01","R58M123456Z","192.168.1.9","17"\r\n', "utf8");
    const result = spawnSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SYNC,
      "-BaseToken", "not-a-real-token", "-TableId", "not-a-real-table",
      "-InventoryCsv", csv, "-ApprovedAliasesCsv", "device-01",
    ], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /closed approved-field allowlist/u);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /lark-cli/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Lark sync payload construction has no forbidden inventory fields", () => {
  const source = readFileSync(SYNC, "utf8");
  for (const field of [
    "ADB序列号", "WLAN地址", "小红书昵称", "小红书号", "IP属地", "私密笔记", "主页资料",
  ]) {
    assert.equal(source.includes(`$device."${field}"`), false);
    assert.doesNotMatch(source, new RegExp(`"${field}"\\s*=`, "u"));
  }
  assert.match(source, /\$_\.values\["设备编号"\]\s+-eq\s+\$device\."设备编号"/u);
  assert.doesNotMatch(source, /values\["ADB序列号"\]/u);
  assert.match(source, /\$pageSize = 200/u);
  assert.match(source, /"--offset", \(\[string\]\$offset\)/u);
  assert.match(source, /"--field-id", "设备编号"/u);
  assert.match(source, /seenRecordIds\.ContainsKey/u);
  assert.doesNotMatch(source, /--page-token|--limit", "500"/u);
});

test("inventory collection uses Android launcher resolution and the locked serial snapshot", () => {
  const collect = readFileSync(COLLECT, "utf8");
  const pipeline = readFileSync(PIPELINE, "utf8");
  assert.match(collect, /shell monkey -p com\.xingin\.xhs -c android\.intent\.category\.LAUNCHER 1/u);
  assert.doesNotMatch(collect, /IndexActivityV2/u);
  assert.match(collect, /\[string\]\$DeviceSerialsCsv/u);
  assert.match(collect, /\[string\]\$DeviceAliasesCsv/u);
  assert.match(pipeline, /XHS_LOCKED_DEVICE_SERIALS_CSV/u);
  assert.match(pipeline, /XHS_LOCKED_DEVICE_ALIASES_CSV/u);
  assert.doesNotMatch(pipeline, /-DeviceSerialsCsv/u);
  assert.doesNotMatch(pipeline, /-DeviceAliasesCsv/u);
  assert.match(collect, /只能写入项目中已忽略的 data 目录/u);
  assert.match(collect, /Join-Path \$OutputDir \$deviceAlias/u);
  assert.doesNotMatch(collect, /Join-Path \$OutputDir \$serial/u);
  assert.match(collect, /设备别名不能等于真实设备序列号/u);
  assert.match(collect, /Format-Table alias,model,androidVersion,resolution,xhsInstalled,xhsVersion,profileDetected/u);
  assert.doesNotMatch(collect, /Format-Table serial/u);
  assert.match(collect, /finally \{[\s\S]*?shell rm -f \$RemotePath/u);
  assert.match(collect, /finally \{[\s\S]*?shell rm -f \$remotePng/u);
});

test("Run-Pipeline is local-only unless its explicit SyncLark switch is present", () => {
  const pipeline = readFileSync(PIPELINE, "utf8");
  assert.match(pipeline, /\[switch\]\$SyncLark/u);
  assert.match(pipeline, /if \(\$SyncLark\)\s*\{[\s\S]*?Sync-LarkBase\.ps1/u);
  assert.doesNotMatch(pipeline, /\$SkipLark/u);
});
