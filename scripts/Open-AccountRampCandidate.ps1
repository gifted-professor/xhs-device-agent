[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilePath,

    [Parameter(Mandatory = $true)]
    [string]$CandidateId,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [switch]$ConfirmSingleDeviceAndSyncOff
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
if (!$ConfirmSingleDeviceAndSyncOff) {
    throw "Show only this account's phone in Xiaowei and turn group synchronization off, then pass -ConfirmSingleDeviceAndSyncOff."
}

$resolvedProfile = (Resolve-Path -LiteralPath $ProfilePath).Path
$profile = Get-Content -LiteralPath $resolvedProfile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$profile.accountAlias -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$') { throw "Account alias is invalid" }
if ([string]$profile.deviceAlias -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "Device alias is invalid" }
if ($profile.interactionPolicy -ne "human_final") { throw "Account handoff requires human_final" }

$accountRoot = Join-Path (Join-Path $projectRoot "data\accounts") ([string]$profile.accountAlias)
$queuePath = Join-Path $accountRoot "today-queue.json"
if (!(Test-Path -LiteralPath $queuePath)) { throw "Today's account queue was not found" }
$queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($queue.accountAlias -ne $profile.accountAlias -or $queue.status -ne "ready") { throw "Today's account queue is not ready for handoff" }
$matches = @($queue.candidates | Where-Object { [string]$_.candidateId -eq $CandidateId })
if ($matches.Count -ne 1) { throw "CandidateId must match exactly one item in today's queue" }
if ([string]$matches[0].deviceAlias -ne [string]$profile.deviceAlias) { throw "Candidate belongs to a different device alias" }

$taskPath = Join-Path (Join-Path $accountRoot "tasks") ("{0}.json" -f [string]$queue.taskId)
if (!(Test-Path -LiteralPath $taskPath)) { throw "The queue task file was not found" }
$handoff = Join-Path $PSScriptRoot "Open-ReviewCandidate.ps1"
$deviceLockHandles = $null
try {
    $deviceLockHandles = Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @([string]$profile.deviceAlias)
    $arguments = @{
        TaskPath = $taskPath
        CandidateId = $CandidateId
        DeviceAlias = [string]$profile.deviceAlias
        InheritedDeviceLockHandles = @($deviceLockHandles)
        ConfirmSingleDeviceAndSyncOff = $true
    }
    if ($ConfigPath) { $arguments.ConfigPath = $ConfigPath }
    if ($OutputRoot) { $arguments.OutputRoot = $OutputRoot }
    & $handoff @arguments
    if ($LASTEXITCODE -ne 0) { throw "Account candidate handoff failed" }
} finally {
    Exit-DeviceLocks -Handles $deviceLockHandles
}
