[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilePath,

    [string]$TaskDate = (Get-Date -Format "yyyy-MM-dd"),

    [ValidateRange(1, 99)]
    [int]$Sequence = 1,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [switch]$GenerateOnly,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$generator = Join-Path $PSScriptRoot "account-ramp.mjs"
$researchRunner = Join-Path $PSScriptRoot "Run-TopicResearch.ps1"
$preflight = Join-Path $PSScriptRoot "Matrix-Preflight.ps1"
$resolvedProfile = (Resolve-Path -LiteralPath $ProfilePath).Path
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\research" }

$manifestRaw = & $node $generator build --profile $resolvedProfile --date $TaskDate --sequence ([string]$Sequence) 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw $manifestRaw.Trim() }
$manifest = $manifestRaw | ConvertFrom-Json

if ($GenerateOnly) {
    $manifest | ConvertTo-Json -Depth 6
    return
}

if (!$DryRun) {
    $preflightArgs = @{ ProbeApi = $true }
    if ($ConfigPath) { $preflightArgs.ConfigPath = $ConfigPath }
    $null = & $preflight @preflightArgs 6>&1
}

$researchArgs = @{
    TaskPath = [string]$manifest.taskPath
    OutputRoot = $OutputRoot
}
if ($ConfigPath) { $researchArgs.ConfigPath = $ConfigPath }
if ($DryRun) {
    $researchArgs.DryRun = $true
    $researchArgs.DeviceAlias = @([string]$manifest.deviceAlias)
}

$null = & $researchRunner @researchArgs 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "Account ramp research task failed" }

$summaryPath = Join-Path (Join-Path $OutputRoot ([string]$manifest.taskId)) "summary.json"
if (!(Test-Path -LiteralPath $summaryPath)) { throw "Account ramp summary was not created" }
$recordRaw = & $node $generator record --profile $resolvedProfile --summary $summaryPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw $recordRaw.Trim() }
$record = $recordRaw | ConvertFrom-Json

[ordered]@{
    schemaVersion = 1
    accountAlias = [string]$manifest.accountAlias
    phase = [string]$manifest.phase
    taskId = [string]$manifest.taskId
    status = [string]$record.status
    needsHuman = [bool]$record.needsHuman
    taskPath = [string]$manifest.taskPath
    summaryPath = $summaryPath
    reportPath = [string]$record.reportPath
    statePath = [string]$record.statePath
    queuePath = [string]$record.queuePath
    todayQueuePath = [string]$record.todayQueuePath
} | ConvertTo-Json -Depth 6
