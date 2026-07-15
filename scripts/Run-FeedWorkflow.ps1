[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskId,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 50)]
    [int]$Count,

    [string]$MachineNumber,

    [string]$MachineName,

    [string]$DeviceAlias,

    [ValidateRange(1, 50)]
    [int]$LikeAt,

    [ValidateRange(1, 50)]
    [int]$FavoriteAt,

    [ValidateRange(1, 60)]
    [int]$ImageMinSeconds,

    [ValidateRange(1, 60)]
    [int]$ImageMaxSeconds,

    [ValidateRange(1, 60)]
    [int]$VideoMinSeconds,

    [ValidateRange(1, 60)]
    [int]$VideoMaxSeconds,

    [ValidateSet("normal", "skip_and_count")]
    [string]$VideoPolicy,

    [ValidateRange(0, 20000)]
    [int]$VideoDwellMs,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [string]$BatchRoot,

    [string]$BatchAttemptId
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")
. (Join-Path $PSScriptRoot "Feed-BatchControl.ps1")

if ($TaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw "TaskId must contain 3-80 safe characters" }
if ($LikeAt -and $LikeAt -gt $Count) { throw "LikeAt cannot exceed Count" }
if ($FavoriteAt -and $FavoriteAt -gt $Count) { throw "FavoriteAt cannot exceed Count" }
if ($LikeAt -and $FavoriteAt -and $LikeAt -eq $FavoriteAt) { throw "LikeAt and FavoriteAt must target different feed positions" }
if ($ImageMinSeconds -and $ImageMaxSeconds -and $ImageMinSeconds -gt $ImageMaxSeconds) { throw "ImageMinSeconds cannot exceed ImageMaxSeconds" }
if ($VideoMinSeconds -and $VideoMaxSeconds -and $VideoMinSeconds -gt $VideoMaxSeconds) { throw "VideoMinSeconds cannot exceed VideoMaxSeconds" }
$batchMode = [bool]$BatchRoot -or [bool]$BatchAttemptId
if ($batchMode -and (!$BatchRoot -or !$BatchAttemptId)) { throw "BatchRoot and BatchAttemptId must be supplied together" }
if ($batchMode -and ($LikeAt -or $FavoriteAt)) { throw "Feed batch V1 is read-only and rejects interactions" }
if ($batchMode -and $Count -gt 10) { throw "Feed batch V1 allows at most 10 items per machine" }
if ($batchMode -and $VideoPolicy -ne "skip_and_count") { throw "Feed batch V1 requires VideoPolicy=skip_and_count" }
if ($batchMode -and $VideoDwellMs -ne 0) { throw "Feed batch V1 requires VideoDwellMs=0" }

if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\feed" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Config not found: $ConfigPath" }
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath -PathType Leaf)) { throw "Configured AdbPath does not exist" }
if (!$config.Devices) { throw "No local device aliases are configured" }
$machineDirectory = @(Get-MachineDirectory -Config $config)
$machineIdentity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber $MachineNumber -MachineName $MachineName -DeviceAlias $DeviceAlias
$DeviceAlias = [string]$machineIdentity.DeviceAlias

$matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq $DeviceAlias })
if ($matchingSerials.Count -ne 1) { throw "The selected machine must resolve to exactly one local device" }
$serial = [string]$matchingSerials[0]
$allowed = if (
    $config.Xhs -and
    $config.Xhs.Interactions -and
    $config.Xhs.Interactions.AllowedActionsByAlias -and
    $config.Xhs.Interactions.AllowedActionsByAlias.ContainsKey($DeviceAlias)
) {
    @($config.Xhs.Interactions.AllowedActionsByAlias[$DeviceAlias] | ForEach-Object { [string]$_ })
} else {
    @()
}
if ($LikeAt -and $allowed -notcontains "like") { throw "Like is not authorized for the selected machine" }
if ($FavoriteAt -and $allowed -notcontains "favorite") { throw "Favorite is not authorized for the selected machine" }

$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot "feed-device-runner.mjs"
$rules = Join-Path $projectRoot "config\xhs-page-rules.json"
$arguments = @(
    $runner,
    "--adb-path", [string]$config.AdbPath,
    "--serial", $serial,
    "--device-alias", $DeviceAlias,
    "--task-id", $TaskId,
    "--count", [string]$Count,
    "--output-root", $OutputRoot,
    "--rules", $rules
)
if ($LikeAt) { $arguments += @("--like-at", [string]$LikeAt) }
if ($FavoriteAt) { $arguments += @("--favorite-at", [string]$FavoriteAt) }
if ($PSBoundParameters.ContainsKey("ImageMinSeconds")) { $arguments += @("--image-min-seconds", [string]$ImageMinSeconds) }
if ($PSBoundParameters.ContainsKey("ImageMaxSeconds")) { $arguments += @("--image-max-seconds", [string]$ImageMaxSeconds) }
if ($PSBoundParameters.ContainsKey("VideoMinSeconds")) { $arguments += @("--video-min-seconds", [string]$VideoMinSeconds) }
if ($PSBoundParameters.ContainsKey("VideoMaxSeconds")) { $arguments += @("--video-max-seconds", [string]$VideoMaxSeconds) }
if ($PSBoundParameters.ContainsKey("VideoPolicy")) { $arguments += @("--video-policy", $VideoPolicy) }
if ($PSBoundParameters.ContainsKey("VideoDwellMs")) { $arguments += @("--video-dwell-ms", [string]$VideoDwellMs) }
if ($batchMode) { $arguments += @("--batch-root", $BatchRoot, "--batch-attempt-id", $BatchAttemptId) }

$locks = @()
$exitCode = 2
try {
    $locks += @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @($DeviceAlias))
    $locks += @(Enter-TaskLocks -ProjectRoot $projectRoot -TaskIds @($TaskId))
    if ($batchMode) {
        $batchPaths = Get-FeedBatchControlPaths -BatchRoot $BatchRoot -AttemptId $BatchAttemptId
        Write-FeedBatchReady -Paths $batchPaths -Stage "lock" -TaskId $TaskId -MachineNumber $MachineNumber
        Wait-FeedBatchBarrier -Paths $batchPaths -AttemptId $BatchAttemptId -Stage "preflight"
    }

    $online = @(
        & $config.AdbPath devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
            if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
        }
    )
    if ($online -notcontains $serial) { throw "The selected machine is not online" }

    if ($batchMode) {
        Assert-FeedBatchParentActive -Paths $batchPaths -AttemptId $BatchAttemptId
        $capabilities = [ordered]@{
            profile = "feed_batch_read_only_v1"
            freshInventory = $true
            uniqueMachineBinding = $true
            taskLockHeld = $true
            deviceLockHeld = $true
            rulesPresent = (Test-Path -LiteralPath $rules -PathType Leaf)
            mutationLeaseGate = $true
        }
        if (!$capabilities.rulesPresent) { throw "Feed page rules are unavailable" }
        Write-FeedBatchReady -Paths $batchPaths -Stage "preflight" -TaskId $TaskId -MachineNumber $MachineNumber -Capabilities $capabilities
        Wait-FeedBatchBarrier -Paths $batchPaths -AttemptId $BatchAttemptId -Stage "start"
    }
    & $node @arguments
    $exitCode = $LASTEXITCODE
} finally {
    Exit-DeviceLocks -Handles $locks
}
if ($exitCode -ne 0) { exit $exitCode }
