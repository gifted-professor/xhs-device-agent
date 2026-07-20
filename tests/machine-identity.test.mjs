import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(root, "scripts", "Machine-Identity.ps1");
const windowsOnly = { skip: process.platform !== "win32" };

test("machine identity normalizes numbers and rejects ambiguous visible names", windowsOnly, () => {
  const quotedHelper = `'${helper.replaceAll("'", "''")}'`;
  const command = `
$ErrorActionPreference = 'Stop'
. ${quotedHelper}
$config = @{
  Devices = @{
    'PRIVATE_SERIAL_A' = 'internal-a'
    'PRIVATE_SERIAL_B' = 'internal-b'
    'PRIVATE_SERIAL_C' = 'internal-c'
  }
  Machines = @{
    '01' = @{ Name = 'SAME_NAME'; DeviceAlias = 'internal-a' }
    '02' = @{ Name = 'UNIQUE_NAME'; DeviceAlias = 'internal-b' }
    '03' = @{ Name = 'SAME_NAME'; DeviceAlias = 'internal-c' }
  }
}
$directory = @(Get-MachineDirectory -Config $config)
if ($directory.Count -ne 3) { throw 'directory count mismatch' }
if ((Resolve-MachineIdentity -Directory $directory -MachineNumber '2').Number -cne '02') { throw 'number normalization failed' }
if ((Resolve-MachineIdentity -Directory $directory -MachineName 'UNIQUE_NAME').Number -cne '02') { throw 'unique name resolution failed' }
try {
  Resolve-MachineIdentity -Directory $directory -MachineName 'SAME_NAME' | Out-Null
  throw 'ambiguous name was accepted'
} catch {
  if ($_.Exception.Message -notmatch 'ambiguous') { throw }
}
exit 0`;
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
