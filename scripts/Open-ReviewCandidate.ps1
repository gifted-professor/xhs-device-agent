[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskPath,

    [Parameter(Mandatory = $true)]
    [string]$CandidateId,

    [string]$MachineNumber,

    [string]$MachineName,

    [string]$DeviceAlias,

    [string]$CandidatesPath,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [Parameter(DontShow = $true)]
    [System.IO.FileStream[]]$InheritedDeviceLockHandles,

    [switch]$ConfirmSingleDeviceAndSyncOff
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\research" }
if (!$ConfirmSingleDeviceAndSyncOff) {
    throw "Before handoff, show only this one phone in Xiaowei and turn group synchronization off, then pass -ConfirmSingleDeviceAndSyncOff."
}
if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Local matrix config was not found" }

$resolvedTask = (Resolve-Path -LiteralPath $TaskPath).Path
$task = Get-Content -LiteralPath $resolvedTask -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$CandidatesPath) { $CandidatesPath = Join-Path $OutputRoot "$($task.taskId)\candidates.jsonl" }
$resolvedCandidates = (Resolve-Path -LiteralPath $CandidatesPath).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath)) { throw "Configured AdbPath does not exist" }
if (!$config.Devices -or !$config.Groups -or !$config.Groups.ContainsKey($task.deviceGroup)) { throw "The task device group is not fully mapped" }
$machineDirectory = @(Get-MachineDirectory -Config $config)
$machineIdentity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber $MachineNumber -MachineName $MachineName -DeviceAlias $DeviceAlias
$DeviceAlias = [string]$machineIdentity.DeviceAlias

$matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq $DeviceAlias })
if ($matchingSerials.Count -ne 1) { throw "The selected machine must resolve to exactly one local device" }
$serial = [string]$matchingSerials[0]
if ($DeviceAlias -eq $serial) { throw "DeviceAlias must not expose the raw ADB identifier" }
if (@($config.Groups[$task.deviceGroup]) -notcontains $serial) { throw "The selected machine is not a member of the task device group" }
$deviceLockHandles = $null
$ownsDeviceLock = $false
$temporaryConfig = $null
try {
    if ($InheritedDeviceLockHandles) {
        $expectedLockPath = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "data\locks\$DeviceAlias.lock"))
        $inheritedHandles = @($InheritedDeviceLockHandles)
        if ($inheritedHandles.Count -ne 1) { throw "Inherited device lock is invalid" }
        try {
            $inheritedLockPath = [System.IO.Path]::GetFullPath([string]$inheritedHandles[0].Name)
            $inheritedLockUsable = [bool]$inheritedHandles[0].CanWrite
        } catch {
            throw "Inherited device lock is invalid"
        }
        if (!$inheritedLockUsable -or ![string]::Equals($inheritedLockPath, $expectedLockPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Inherited device lock does not match DeviceAlias"
        }
        $deviceLockHandles = $inheritedHandles
    } else {
        $deviceLockHandles = Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @($DeviceAlias)
        $ownsDeviceLock = $true
    }

    $state = (& $config.AdbPath -s $serial get-state 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $state -ne "device") { throw "The selected device is not online" }

    $unicodeIme = if ($config.TextInput) { $config.TextInput.UnicodeIme } else { $null }
    $unicodeEnabled = [bool]($unicodeIme -and $unicodeIme.Enabled -and $unicodeIme.HumanApproved)
    $providerConfig = [ordered]@{
        adbPath = [string]$config.AdbPath
        packageName = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
        devices = @([ordered]@{ alias = $DeviceAlias; serial = $serial; groups = @([string]$task.deviceGroup) })
        unicodeInput = [ordered]@{
            enabled = $unicodeEnabled
            action = if ($unicodeIme -and $unicodeIme.Action) { [string]$unicodeIme.Action } else { "ADB_INPUT_B64" }
            extraKey = if ($unicodeIme -and $unicodeIme.ExtraKey) { [string]$unicodeIme.ExtraKey } else { "msg" }
            approvedAliases = if ($unicodeEnabled -and @($unicodeIme.ApprovedAliases) -contains $DeviceAlias) { @($DeviceAlias) } else { @() }
        }
    }

    $temporaryConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-handoff-{0}.json" -f [guid]::NewGuid().ToString("N"))
    [System.IO.File]::WriteAllText(
        $temporaryConfig,
        ($providerConfig | ConvertTo-Json -Depth 8),
        (New-Object System.Text.UTF8Encoding($false))
    )
    $node = (Get-Command node -ErrorAction Stop).Source
    & $node (Join-Path $PSScriptRoot "navigate-review-candidate.mjs") `
        --task $resolvedTask `
        --candidates $resolvedCandidates `
        --candidate-id $CandidateId `
        --device-alias $DeviceAlias `
        --provider-config $temporaryConfig
    if ($LASTEXITCODE -ne 0) { throw "Candidate handoff exited with code $LASTEXITCODE" }
} finally {
    if ($temporaryConfig) { Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue }
    if ($ownsDeviceLock) { Exit-DeviceLocks -Handles $deviceLockHandles }
}
