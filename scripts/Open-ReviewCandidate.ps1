[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskPath,

    [Parameter(Mandatory = $true)]
    [string]$CandidateId,

    [Parameter(Mandatory = $true)]
    [string]$DeviceAlias,

    [string]$CandidatesPath,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [switch]$ConfirmSingleDeviceAndSyncOff
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\research" }
if (!$ConfirmSingleDeviceAndSyncOff) {
    throw "Before handoff, show only this one phone in Xiaowei and turn group synchronization off, then pass -ConfirmSingleDeviceAndSyncOff."
}
if ($DeviceAlias -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "DeviceAlias is invalid" }
if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Local matrix config was not found" }

$resolvedTask = (Resolve-Path -LiteralPath $TaskPath).Path
$task = Get-Content -LiteralPath $resolvedTask -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$CandidatesPath) { $CandidatesPath = Join-Path $OutputRoot "$($task.taskId)\candidates.jsonl" }
$resolvedCandidates = (Resolve-Path -LiteralPath $CandidatesPath).Path
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath)) { throw "Configured AdbPath does not exist" }
if (!$config.Devices -or !$config.Groups -or !$config.Groups.ContainsKey($task.deviceGroup)) { throw "The task device group is not fully mapped" }

$matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq $DeviceAlias })
if ($matchingSerials.Count -ne 1) { throw "DeviceAlias must resolve to exactly one local device" }
$serial = [string]$matchingSerials[0]
if (@($config.Groups[$task.deviceGroup]) -notcontains $serial) { throw "DeviceAlias is not a member of the task device group" }
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
try {
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
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}
