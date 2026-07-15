[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SpecPath,
    [string]$ConfigPath,
    [string]$OutputRoot,
    [string]$AcceptanceRoot,
    [string]$ConfirmPlanHash,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $algorithm.Dispose()
    }
}

function Get-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Value))
}

function Test-TargetUnlocked {
    param(
        [Parameter(Mandatory = $true)][string]$AdbPath,
        [Parameter(Mandatory = $true)][string]$Serial
    )
    try {
        $power = (& $AdbPath -s $Serial shell dumpsys power 2>$null | Out-String)
        $window = (& $AdbPath -s $Serial shell dumpsys window policy 2>$null | Out-String)
        $awake = $power -match 'mWakefulness=Awake|Display Power: state=ON|mInteractive=true'
        $locked = $window -match 'mShowingLockscreen=true|isStatusBarKeyguard=true|showing=true.*keyguard'
        return [bool]($awake -and !$locked)
    } catch {
        return $false
    }
}

function Get-AppVersion {
    param(
        [Parameter(Mandatory = $true)][string]$AdbPath,
        [Parameter(Mandatory = $true)][string]$Serial
    )
    try {
        $dump = (& $AdbPath -s $Serial shell dumpsys package com.xingin.xhs 2>$null | Out-String)
        return [string]([regex]::Match($dump, 'versionName=([^\s]+)').Groups[1].Value)
    } catch {
        return ""
    }
}

if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\tasks" }
if (!$AcceptanceRoot) { $AcceptanceRoot = Join-Path $projectRoot "data\composite-capability" }
$SpecPath = Get-AbsolutePath $SpecPath
$ConfigPath = Get-AbsolutePath $ConfigPath
$OutputRoot = Get-AbsolutePath $OutputRoot
$AcceptanceRoot = Get-AbsolutePath $AcceptanceRoot
if (!(Test-Path -LiteralPath $SpecPath -PathType Leaf)) { throw "Task spec not found" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Local config not found" }
$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($spec.schemaVersion -cne "xhs-task-spec/v1") { throw "Task spec schemaVersion is invalid" }
if ([string]$spec.taskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,69}$') { throw "TaskId is invalid" }
if ($spec.deviceSelection.mode -notin @("explicit", "auto_idle")) { throw "Task device selection mode is invalid" }
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath -PathType Leaf)) { throw "Configured AdbPath does not exist" }
$machineDirectory = @(Get-MachineDirectory -Config $config)
$onlineSerials = @(
    & $config.AdbPath devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)

$locks = @()
$runtimePath = $null
$exitCode = 2
try {
    $locks += @(Enter-TaskLocks -ProjectRoot $projectRoot -TaskIds @([string]$spec.taskId))
    $selected = @()
    if ($spec.deviceSelection.mode -eq "explicit") {
        $numbers = @($spec.deviceSelection.machines | ForEach-Object { ConvertTo-MachineNumber ([string]$_) })
        if (!$numbers.Count -or @($numbers | Select-Object -Unique).Count -ne $numbers.Count) { throw "Explicit task machines must be unique" }
        foreach ($number in $numbers) {
            $selected += @(Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber $number)
        }
        $locks += @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @($selected.DeviceAlias))
    } else {
        $requiredCount = [int]$spec.deviceSelection.count
        if ($requiredCount -lt 1 -or $requiredCount -gt 64) { throw "Auto-idle device count is invalid" }
        $candidates = @($machineDirectory | Sort-Object @{ Expression = {
            $profile = $config.Machines[[string]$_.Number]
            if ($profile -and $profile.ContainsKey("PreferenceRank")) { [int]$profile.PreferenceRank } else { [int]$_.Number }
        } }, Number)
        foreach ($identity in $candidates) {
            $serialMatches = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq [string]$identity.DeviceAlias })
            if ($serialMatches.Count -ne 1 -or $onlineSerials -notcontains [string]$serialMatches[0]) { continue }
            if (!(Test-TargetUnlocked -AdbPath $config.AdbPath -Serial ([string]$serialMatches[0]))) { continue }
            try {
                $handle = @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @([string]$identity.DeviceAlias))
                $locks += $handle
                $selected += $identity
                if ($selected.Count -eq $requiredCount) { break }
            } catch {
                continue
            }
        }
        if ($selected.Count -ne $requiredCount) { throw "Not enough online, unlocked, idle machines are available" }
    }

    $runtimeDevices = @()
    $rank = 0
    foreach ($identity in $selected) {
        $rank++
        $serialMatches = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq [string]$identity.DeviceAlias })
        if ($serialMatches.Count -ne 1) { throw "Selected machine has no unique internal binding" }
        $serial = [string]$serialMatches[0]
        $online = $onlineSerials -contains $serial
        $unlocked = if ($online) { Test-TargetUnlocked -AdbPath $config.AdbPath -Serial $serial } else { $false }
        $runtimeDevices += [ordered]@{
            machine = [string]$identity.Number
            visibleName = [string]$identity.Name
            deviceAlias = [string]$identity.DeviceAlias
            serial = $serial
            identityHash = Get-Sha256Hex ("{0}`0{1}`0{2}" -f $serial, $identity.DeviceAlias, $identity.Number)
            online = [bool]$online
            unlocked = [bool]$unlocked
            idle = $true
            preferenceRank = $rank
            appVersion = if ($online) { Get-AppVersion -AdbPath $config.AdbPath -Serial $serial } else { "" }
            adapterVersion = "2.0.0"
            actionRegistryVersion = "composite-actions/v1"
        }
    }
    $runtime = [ordered]@{
        schemaVersion = "xhs-task-runtime-context/v1"
        locksHeld = $true
        adbPath = [System.IO.Path]::GetFullPath([string]$config.AdbPath)
        rulesPath = Join-Path $projectRoot "config\xhs-page-rules.json"
        acceptanceRoot = $AcceptanceRoot
        devices = $runtimeDevices
    }
    $runtimeRoot = Join-Path $OutputRoot ".runtime"
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    $runtimePath = Join-Path $runtimeRoot (([guid]::NewGuid().ToString("N")) + ".json")
    [System.IO.File]::WriteAllText(
        $runtimePath,
        ($runtime | ConvertTo-Json -Depth 12),
        (New-Object System.Text.UTF8Encoding($false))
    )
    $node = (Get-Command node -ErrorAction Stop).Source
    $arguments = @(
        (Join-Path $PSScriptRoot "task-live-runner.mjs"),
        "--spec", $SpecPath,
        "--runtime-context", $runtimePath,
        "--output", $OutputRoot
    )
    if ($ConfirmPlanHash) { $arguments += @("--confirm-plan-hash", $ConfirmPlanHash) }
    if ($Json) { $arguments += "--json" }
    & $node @arguments
    $exitCode = $LASTEXITCODE
} finally {
    if ($runtimePath) { Remove-Item -LiteralPath $runtimePath -Force -ErrorAction SilentlyContinue }
    Exit-DeviceLocks -Handles $locks
}
exit $exitCode
