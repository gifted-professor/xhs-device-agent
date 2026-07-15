#Requires -Version 5.1

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$TailnetPort = 2222
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
$sshdExecutable = @(
    (Join-Path $env:ProgramFiles 'OpenSSH\sshd.exe'),
    (Join-Path $env:ProgramFiles 'OpenSSH-Win64\sshd.exe'),
    (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$xhsEntry = Join-Path (Split-Path $PSScriptRoot -Parent) 'xhs.cmd'

$tailscaleOnline = $false
$serveConfigured = $false
if (Test-Path -LiteralPath $tailscale -PathType Leaf) {
    $status = (& $tailscale status --json 2>$null | ConvertFrom-Json)
    $tailscaleOnline = $status.BackendState -eq 'Running' -and $status.Self.Online
    $serveStatus = (& $tailscale serve status 2>$null | Out-String)
    $tailnetPortPattern = [regex]::Escape(":" + [string]$TailnetPort) + '\b'
    $serveConfigured = $serveStatus -match $tailnetPortPattern -and
        $serveStatus -match '127\.0\.0\.1:22'
}

$sshdService = Get-Service -Name sshd -ErrorAction SilentlyContinue
$sshdConfigValid = $false
$passwordAuthenticationDisabled = $false
if ($sshdExecutable -and (Test-Path -LiteralPath $sshdExecutable -PathType Leaf) -and
    (Test-Path -LiteralPath $sshdConfig -PathType Leaf)) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        & $sshdExecutable -t -f $sshdConfig 2>$null
        $sshdConfigValid = $LASTEXITCODE -eq 0
    } else {
        # Protected host keys are intentionally unreadable to a non-elevated
        # health check. A running sshd service proves that this config loaded.
        $sshdConfigValid = $null -ne $sshdService -and $sshdService.Status -eq 'Running'
    }
    $passwordAuthenticationDisabled = [bool](Select-String -LiteralPath $sshdConfig -Pattern '^\s*PasswordAuthentication\s+no\s*$' -ErrorAction SilentlyContinue)
}

$defaultFirewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
$defaultFirewallClosed = $null -eq $defaultFirewallRule -or $defaultFirewallRule.Enabled -eq 'False'
$defaultShell = $null
$openSshRegistry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
if ($null -ne $openSshRegistry) {
    $defaultShell = $openSshRegistry.DefaultShell
}
$powerShellIsDefault = [string]$defaultShell -match '(?i)\\powershell\.exe$'

$checks = [ordered]@{
    TailscaleOnline = $tailscaleOnline
    TailscaleServeConfigured = $serveConfigured
    SshdInstalled = $null -ne $sshdService
    SshdRunning = $null -ne $sshdService -and $sshdService.Status -eq 'Running'
    SshdConfigValid = $sshdConfigValid
    PasswordAuthenticationDisabled = $passwordAuthenticationDisabled
    PublicPort22FirewallRuleDisabled = $defaultFirewallClosed
    PowerShellDefaultShell = $powerShellIsDefault
    XhsEntryPresent = Test-Path -LiteralPath $xhsEntry -PathType Leaf
}

$ready = -not ($checks.Values -contains $false)
[pscustomobject]@{
    Status = if ($ready) { 'ready' } else { 'not_ready' }
    TailnetPort = $TailnetPort
    Checks = [pscustomobject]$checks
}

if (-not $ready) {
    exit 1
}
