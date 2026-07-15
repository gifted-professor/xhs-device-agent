import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("search input capability is scoped only to selected machines", () => {
  const helper = path.join(projectRoot, "scripts", "Task-TextInputContext.ps1").replaceAll("'", "''");
  const script = `
. '${helper}'
$config = @{
  TextInput = @{
    UnicodeIme = @{
      Enabled = $true; HumanApproved = $true; Action = 'ADB_INPUT_B64'; ExtraKey = 'msg';
      ApprovedAliases = @('alias-02')
    }
  }
  Xiaowei = @{
    ApiEndpoint = 'ws://127.0.0.1:22222/'
    TextInput = @{ Enabled = $true; HumanApproved = $true; ApprovedAliases = @('alias-04'); PreferredImeServices = @('com.android.xwkeyboard/.IME'); PerDevice = @{} }
    Api = @{ Enabled = $true; AcceptedXiaoweiVersion = '1.0'; AcceptedActionsByAlias = @{}; AcceptedDeviceSerialsByAlias = @{} }
  }
}
$devices = @([pscustomobject]@{ deviceAlias = 'alias-02'; serial = 'PRIVATE-02' })
$context = Get-TaskTextInputContext -Config $config -RuntimeDevices $devices
[ordered]@{
  context = $context
  selectedChinese = Test-TaskQueryInputCapability -Query '通勤穿搭' -TextInputContext $context -DeviceAliases @('alias-02')
  unrelatedChinese = Test-TaskQueryInputCapability -Query '通勤穿搭' -TextInputContext $context -DeviceAliases @('alias-04')
} | ConvertTo-Json -Compress -Depth 20
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    cwd: projectRoot, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim());
  assert.deepEqual(output.context.unicodeInput.approvedAliases, ["alias-02"]);
  assert.deepEqual(output.context.xiaowei.textInput.approvedAliases, []);
  assert.equal(output.selectedChinese, true);
  assert.equal(output.unrelatedChinese, false);
  assert.equal(JSON.stringify(output).includes("PRIVATE-02"), false);
});
