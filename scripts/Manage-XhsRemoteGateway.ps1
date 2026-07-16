[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Status", "Stop", "Install", "Uninstall")]
    [string]$Action,

    [switch]$ElevatedChild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "PowerShell-Runtime.ps1")
$powerShellExecutable = Resolve-XhsPowerShellExecutable
$gatewayScript = (Resolve-Path (Join-Path $PSScriptRoot "xhs-remote-gateway.mjs")).Path
$pidPath = Join-Path $projectRoot "data\remote-gateway.pid"
$healthUrl = "http://127.0.0.1:17891/health"
$taskName = "XhsDeviceAgentRemoteStack"

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

function Get-GatewayProcess {
    if (!(Test-Path -LiteralPath $pidPath -PathType Leaf)) { return $null }
    $raw = (Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8).Trim()
    if ($raw -notmatch '^\d+$') { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$raw" -ErrorAction SilentlyContinue
    if (!$process -or $process.Name -ne "node.exe" -or $process.CommandLine -notlike "*$gatewayScript*") { return $null }
    return $process
}

function Test-GatewayHealth {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 2
        return $response.ok -eq $true -and $response.service -eq "xhs-remote-gateway"
    } catch { return $false }
}

$process = Get-GatewayProcess
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

if ($Action -eq "Start" -and !$process) {
    $node = (Get-Command node -ErrorAction Stop).Source
    $process = Start-Process -FilePath $node -ArgumentList @(('"' + $gatewayScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    New-Item -ItemType Directory -Path (Split-Path -Parent $pidPath) -Force | Out-Null
    [System.IO.File]::WriteAllText($pidPath, [string]$process.Id, (New-Object System.Text.UTF8Encoding($false)))
    $deadline = (Get-Date).AddSeconds(10)
    do { Start-Sleep -Milliseconds 250 } while (!(Test-GatewayHealth) -and (Get-Date) -lt $deadline)
    if (!(Test-GatewayHealth)) { throw "XHS remote gateway did not become healthy within 10 seconds" }
    $process = Get-GatewayProcess
}

if ($Action -eq "Stop") {
    if ($process) { Stop-Process -Id $process.ProcessId -Force }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    [pscustomobject][ordered]@{ action = "stop"; running = $false; health = $false }
    return
}

$healthy = Test-GatewayHealth
[pscustomobject][ordered]@{
    action = $Action.ToLowerInvariant()
    running = [bool]$process
    health = $healthy
    bind = "127.0.0.1:17891"
    tailscaleOnly = $true
    startupTaskInstalled = [bool](Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)
    next = if ($healthy) { ".\xhs.cmd remote status" } else { ".\xhs.cmd remote start" }
}
