[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Status", "Stop", "Restart", "Install", "Uninstall")]
    [string]$Action,

    [switch]$ElevatedChild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "PowerShell-Runtime.ps1")
$powerShellExecutable = Resolve-XhsPowerShellExecutable
$gatewayScript = (Resolve-Path (Join-Path $PSScriptRoot "xhs-remote-gateway.mjs")).Path
$node = (Get-Command node -ErrorAction Stop).Source
$pidPath = Join-Path $projectRoot "data\remote-gateway.pid"
$controlTokenPath = Join-Path $projectRoot "data\remote-gateway-control.token"
$healthUrl = "http://127.0.0.1:17891/health"
$shutdownUrl = "http://127.0.0.1:17891/admin/drain-and-shutdown"
$taskName = "XhsDeviceAgentRemoteStack"
$expectedBuildId = (& $node $gatewayScript --print-build-id).Trim()
if ($LASTEXITCODE -ne 0 -or $expectedBuildId -notmatch '^[a-f0-9]{64}$') {
    throw "Unable to calculate the current resident gateway build identity"
}

$principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
$isAdministrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Action -in @("Install", "Uninstall") -and !$isAdministrator -and !$ElevatedChild) {
    $arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'),
        "-Action", $Action, "-ElevatedChild"
    )
    try {
        $elevated = Start-Process -FilePath $powerShellExecutable -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
    } catch { throw "Administrator approval for the remote gateway startup task was cancelled or failed" }
    if ($elevated.ExitCode -ne 0) { throw "The elevated remote gateway task operation failed with exit code $($elevated.ExitCode)" }
    [pscustomobject][ordered]@{ action = $Action.ToLowerInvariant(); administratorApproved = $true; taskName = $taskName }
    return
}

function Get-GatewayHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        if ($response.ok -eq $true -and $response.service -eq "xhs-remote-gateway") { return $response }
    } catch { }
    return $null
}

function Get-GatewayListener {
    $listeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 17891 -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 1) { return $listeners[0] }
    return $null
}

function Get-GatewayProcess {
    $listener = Get-GatewayListener
    if (!$listener -or !(Get-GatewayHealth)) { return $null }
    $candidatePid = [int]$listener.OwningProcess
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$candidatePid" -ErrorAction SilentlyContinue
    if ($candidate) {
        if ($candidate.Name -ne "node.exe") { return $null }
        if ($candidate.CommandLine -and $candidate.CommandLine -notlike "*$gatewayScript*") { return $null }
        return $candidate
    }
    $fallback = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
    if (!$fallback -or $fallback.ProcessName -ne "node") { return $null }
    return [pscustomobject]@{ ProcessId = $candidatePid; Name = "node.exe"; CommandLine = $null }
}

function Get-OrCreateControlToken {
    if (Test-Path -LiteralPath $controlTokenPath -PathType Leaf) {
        $existing = (Get-Content -LiteralPath $controlTokenPath -Raw -Encoding UTF8).Trim()
        if ($existing -match '^[A-Za-z0-9+/=_-]{32,256}$') { return $existing }
    }
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $token = [Convert]::ToBase64String($bytes)
    New-Item -ItemType Directory -Path (Split-Path -Parent $controlTokenPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($controlTokenPath, $token, (New-Object System.Text.UTF8Encoding($false)))
    return $token
}

function Request-GatewayDrain {
    param([object]$Health)
    if (!(Test-Path -LiteralPath $controlTokenPath -PathType Leaf)) { return $false }
    $token = (Get-Content -LiteralPath $controlTokenPath -Raw -Encoding UTF8).Trim()
    if ($token -notmatch '^[A-Za-z0-9+/=_-]{32,256}$') { return $false }
    try {
        $response = Invoke-RestMethod -Uri $shutdownUrl -Method Post -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
    } catch { return $false }
    if ($response.ok -ne $true -or $response.draining -ne $true) { return $false }
    if ($Health.bootId -and $response.bootId -ne $Health.bootId) { throw "Gateway instance changed before drain acknowledgement" }
    return $true
}

function Wait-GatewayPortClosed {
    param([int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (!(Get-GatewayListener)) { return $true }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Stop-ActiveGateway {
    param([object]$Process, [object]$Health)
    if (Request-GatewayDrain -Health $Health) {
        if (Wait-GatewayPortClosed -TimeoutSeconds 300) { return "authenticated_drain" }
        throw "Gateway drain did not release port 17891 within 300 seconds"
    }
    if ($Health -and [int]$Health.queueDepth -gt 0) {
        throw "Gateway is running active commands and does not support authenticated draining"
    }
    try {
        Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
    } catch [System.UnauthorizedAccessException] {
        throw
    }
    if (!(Wait-GatewayPortClosed -TimeoutSeconds 10)) {
        throw "XHS remote gateway port did not close within 10 seconds"
    }
    return "idle_legacy_termination"
}

function Start-VerifiedGateway {
    param([string]$PreviousBootId)
    if (Get-GatewayListener) { throw "Port 17891 is already occupied; refusing to claim another process as the new gateway" }
    $token = Get-OrCreateControlToken
    $previousToken = $env:XHS_REMOTE_GATEWAY_CONTROL_TOKEN
    try {
        $env:XHS_REMOTE_GATEWAY_CONTROL_TOKEN = $token
        $child = Start-Process -FilePath $node -ArgumentList @(('"' + $gatewayScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    } finally {
        if ($null -eq $previousToken) { Remove-Item Env:XHS_REMOTE_GATEWAY_CONTROL_TOKEN -ErrorAction SilentlyContinue }
        else { $env:XHS_REMOTE_GATEWAY_CONTROL_TOKEN = $previousToken }
    }

    $deadline = (Get-Date).AddSeconds(15)
    $verifiedHealth = $null
    do {
        $child.Refresh()
        if ($child.HasExited) { throw "New gateway process exited before binding port 17891" }
        $health = Get-GatewayHealth
        $listener = Get-GatewayListener
        if (
            $health -and
            $listener -and
            [int]$listener.OwningProcess -eq $child.Id -and
            $health.buildId -eq $expectedBuildId -and
            $health.accepting -eq $true -and
            $health.bootId -match '^[a-f0-9-]{36}$' -and
            (!$PreviousBootId -or $health.bootId -ne $PreviousBootId)
        ) {
            $verifiedHealth = $health
            break
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    if (!$verifiedHealth) {
        Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
        throw "New gateway did not prove PID ownership, a fresh boot identity, and the expected build within 15 seconds"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $pidPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($pidPath, [string]$child.Id, (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ Process = $child; Health = $verifiedHealth }
}

function Invoke-ElevatedLifecycle {
    param([string]$LifecycleAction)
    $arguments = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'),
        "-Action", $LifecycleAction, "-ElevatedChild"
    )
    $elevated = Start-Process -FilePath $powerShellExecutable -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw "The elevated gateway $($LifecycleAction.ToLowerInvariant()) failed with exit code $($elevated.ExitCode)" }
}

$process = Get-GatewayProcess
$health = Get-GatewayHealth
$listener = Get-GatewayListener

if ($Action -eq "Install") {
    $startupScript = (Resolve-Path (Join-Path $PSScriptRoot "Start-XhsRemoteStack.ps1")).Path
    $taskAction = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"$startupScript`"")
    $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
    $taskSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
    [pscustomobject][ordered]@{ action = "install"; installed = $true; taskName = $taskName; runLevel = "highest"; trigger = "at_logon" }
    return
}

if ($Action -eq "Uninstall") {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    [pscustomobject][ordered]@{ action = "uninstall"; installed = $false; taskName = $taskName }
    return
}

if ($listener -and !$process) {
    throw "Port 17891 is occupied by an unrecognized process; refusing to overwrite the PID file or trust its health response"
}

if ($Action -in @("Restart", "Stop") -and $process) {
    $previousBootId = if ($health.bootId) { [string]$health.bootId } else { $null }
    try {
        $shutdownMode = Stop-ActiveGateway -Process $process -Health $health
    } catch [System.UnauthorizedAccessException] {
        if (!$isAdministrator -and !$ElevatedChild) {
            Invoke-ElevatedLifecycle -LifecycleAction $Action
            if ($Action -eq "Stop") {
                [pscustomobject][ordered]@{ action = "stop"; delegatedToAdministrator = $true; running = $false; health = $false }
            } else {
                $newHealth = Get-GatewayHealth
                if (!$newHealth -or $newHealth.buildId -ne $expectedBuildId -or ($previousBootId -and $newHealth.bootId -eq $previousBootId)) {
                    throw "Elevated restart completed without proving a new current-build gateway"
                }
                [pscustomobject][ordered]@{ action = "restart"; delegatedToAdministrator = $true; running = $true; health = $true; codeCurrent = $true; reloaded = $true; buildId = $newHealth.buildId; bootId = $newHealth.bootId }
            }
            return
        }
        throw
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    $process = $null
    $health = $null
    $listener = $null
    if ($Action -eq "Stop") {
        [pscustomobject][ordered]@{ action = "stop"; running = $false; health = $false; shutdownMode = $shutdownMode }
        return
    }
}

if ($Action -eq "Stop") {
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    [pscustomobject][ordered]@{ action = "stop"; running = $false; health = $false }
    return
}

if ($Action -eq "Restart" -and !$process) {
    $started = Start-VerifiedGateway -PreviousBootId $previousBootId
    [pscustomobject][ordered]@{
        action = "restart"; running = $true; health = $true; codeCurrent = $true; reloaded = $true
        buildId = $started.Health.buildId; bootId = $started.Health.bootId; shutdownMode = $shutdownMode; bind = "127.0.0.1:17891"
    }
    return
}

if ($Action -eq "Start" -and !$process) {
    $started = Start-VerifiedGateway -PreviousBootId $null
    $process = $started.Process
    $health = $started.Health
}

$healthy = [bool]$health
$codeCurrent = $healthy -and $health.buildId -eq $expectedBuildId
[pscustomobject][ordered]@{
    action = $Action.ToLowerInvariant()
    running = [bool]$process
    health = $healthy
    accepting = if ($healthy -and $null -ne $health.accepting) { [bool]$health.accepting } else { $null }
    codeCurrent = $codeCurrent
    buildId = if ($healthy -and $health.buildId) { [string]$health.buildId } else { $null }
    bootId = if ($healthy -and $health.bootId) { [string]$health.bootId } else { $null }
    bind = "127.0.0.1:17891"
    tailscaleOnly = $true
    startupTaskInstalled = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    next = if ($healthy -and !$codeCurrent) { ".\xhs.cmd remote restart" } elseif ($healthy) { ".\xhs.cmd remote status" } else { ".\xhs.cmd remote start" }
}
