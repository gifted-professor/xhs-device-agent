<#
.SYNOPSIS
  xhs-watcher-launch.ps1 — Register and run a one-shot Task Scheduler job via XML

.PARAMETER runId   Must match: run-YYYYMMDD-HHMMSS-xxxxxxxx (8 hex)
.PARAMETER agentId Must match: agent-run-YYYYMMDD-HHMMSS-xxxxxxxx (8 hex)
.PARAMETER statusOnly  Read-only mode
#>

param(
    [Parameter(Mandatory=$true)] [string]$runId,
    [Parameter(Mandatory=$true)] [string]$agentId,
    [switch]$statusOnly
)
$ErrorActionPreference = "Stop"

# ── Validate IDs ──
if ($runId -notmatch '^run-\d{8}-\d{6}-[0-9a-f]{8}$') { Write-Error "Invalid runId: $runId"; exit 1 }
if ($agentId -notmatch '^agent-run-\d{8}-\d{6}-[0-9a-f]{8}$') { Write-Error "Invalid agentId: $agentId"; exit 1 }

# ── Paths ──
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watcherPath = Join-Path $repo 'scripts\xhs-watcher.mjs'
$taskName = "XHS-Watcher-$runId"

if (-not (Test-Path $watcherPath)) { Write-Error "Watcher not found: $watcherPath"; exit 1 }

# ── Find node.exe absolute path ──
$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Error "node.exe not found in PATH"; exit 1 }

# ── Build arguments (watcher handles its own logging) ──
$q = [char]34
$nodeArgs = "$q$watcherPath$q --runId $q$runId$q --agentId $q$agentId$q"
if ($statusOnly) { $nodeArgs += " --status-only" }

# ── Build task XML ──
$startTime = (Get-Date).AddSeconds(5).ToString('yyyy-MM-ddTHH:mm:ss')

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>XHS watcher runId=$runId</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>$startTime</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$nodeExe</Command>
      <Arguments>$nodeArgs</Arguments>
      <WorkingDirectory>$repo</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@

$xmlPath = Join-Path 'C:\Users\Public\xhs-agent-runs' "$runId-task.xml"
New-Item -ItemType Directory -Force -Path 'C:\Users\Public\xhs-agent-runs' | Out-Null
$xml | Out-File -FilePath $xmlPath -Encoding Unicode

# ── Register and run ──
schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
$r = schtasks.exe /Create /TN $taskName /XML $xmlPath /F 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /create failed: $r"; exit 1 }

$r2 = schtasks.exe /Run /TN $taskName 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "schtasks /run failed: $r2"; exit 1 }

# ── Output ──
[ordered]@{
    ok = $true
    taskName = $taskName
    runId = $runId
    agentId = $agentId
    statusOnly = [bool]$statusOnly
    triggerAt = $startTime
    nodeExe = $nodeExe
} | ConvertTo-Json -Compress
