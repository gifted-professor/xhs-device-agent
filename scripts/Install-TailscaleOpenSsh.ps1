#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$PublicKeyPath,

    [ValidateRange(1, 65535)]
    [int]$TailnetPort = 2222
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Set-GlobalSshdSetting {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Get-Content -LiteralPath $Path)) {
        $lines.Add([string]$line)
    }

    $matchIndex = $lines.Count
    for ($index = 0; $index -lt $lines.Count; $index += 1) {
        if ($lines[$index] -match '^\s*Match\s+') {
            $matchIndex = $index
            break
        }
    }

    $settingPattern = '^\s*#?\s*' + [regex]::Escape($Name) + '(?:\s+.*)?$'
    $settingIndex = -1
    for ($index = 0; $index -lt $matchIndex; $index += 1) {
        if ($lines[$index] -match $settingPattern) {
            $settingIndex = $index
            break
        }
    }

    $setting = "$Name $Value"
    if ($settingIndex -ge 0) {
        $lines[$settingIndex] = $setting
    } else {
        $lines.Insert($matchIndex, $setting)
    }

    [System.IO.File]::WriteAllLines(
        $Path,
        $lines,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function Ensure-AdministratorAuthorizedKeysMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $source = Get-Content -LiteralPath $Path -Raw
    if ($source -match '(?im)^\s*Match\s+Group\s+administrators\s*$') {
        return
    }

    $suffix = @"

Match Group administrators
       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"@
    [System.IO.File]::AppendAllText(
        $Path,
        $suffix,
        [System.Text.UTF8Encoding]::new($false)
    )
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window using the Windows account that will receive SSH access."
}

$resolvedPublicKeyPath = (Resolve-Path -LiteralPath $PublicKeyPath).Path
$publicKeys = @(
    Get-Content -LiteralPath $resolvedPublicKeyPath |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') }
)
if ($publicKeys.Count -eq 0) {
    throw "The public-key file does not contain an SSH public key."
}

$supportedKeyPattern = '^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/]+={0,3}(?:\s+.*)?$'
foreach ($publicKey in $publicKeys) {
    if ($publicKey -notmatch $supportedKeyPattern) {
        throw "The public-key file contains an unsupported or malformed SSH public key."
    }
}

$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) {
    throw "Tailscale CLI was not found at the standard Windows installation path."
}

$tailscaleStatus = (& $tailscale status --json | ConvertFrom-Json)
if ($tailscaleStatus.BackendState -ne 'Running' -or -not $tailscaleStatus.Self.Online) {
    throw "Tailscale must be running and online before remote access is configured."
}

$serverCapabilityName = 'OpenSSH.Server~~~~0.0.1.0'
$serverCapability = Get-WindowsCapability -Online -Name $serverCapabilityName
if ($serverCapability.State -ne 'Installed') {
    $installResult = Add-WindowsCapability -Online -Name $serverCapabilityName
    if (-not $installResult.Online) {
        throw "Windows did not report a successful OpenSSH Server installation."
    }
}

$sshDirectory = Join-Path $env:ProgramData 'ssh'
$sshdConfig = Join-Path $sshDirectory 'sshd_config'
$sshdCandidates = @(
    (Join-Path $env:ProgramFiles 'OpenSSH\sshd.exe'),
    (Join-Path $env:ProgramFiles 'OpenSSH-Win64\sshd.exe'),
    (Join-Path $env:WINDIR 'System32\OpenSSH\sshd.exe')
)
$sshdExecutable = $sshdCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $sshdExecutable) {
    throw "OpenSSH Server was installed, but sshd.exe could not be located."
}
$sshdDefaultConfig = Join-Path (Split-Path -Parent $sshdExecutable) 'sshd_config_default'

New-Item -ItemType Directory -Path $sshDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $sshdConfig -PathType Leaf)) {
    if (-not (Test-Path -LiteralPath $sshdDefaultConfig -PathType Leaf)) {
        throw "The OpenSSH Server default configuration was not installed."
    }
    Copy-Item -LiteralPath $sshdDefaultConfig -Destination $sshdConfig
}

Set-GlobalSshdSetting -Path $sshdConfig -Name 'Port' -Value '22'
Set-GlobalSshdSetting -Path $sshdConfig -Name 'PubkeyAuthentication' -Value 'yes'
Set-GlobalSshdSetting -Path $sshdConfig -Name 'PasswordAuthentication' -Value 'no'
Set-GlobalSshdSetting -Path $sshdConfig -Name 'PermitEmptyPasswords' -Value 'no'
Ensure-AdministratorAuthorizedKeysMatch -Path $sshdConfig

$authorizedKeysPath = Join-Path $sshDirectory 'administrators_authorized_keys'
$existingKeys = @()
if (Test-Path -LiteralPath $authorizedKeysPath -PathType Leaf) {
    $existingKeys = @(
        Get-Content -LiteralPath $authorizedKeysPath |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
}
$mergedKeys = @($existingKeys + $publicKeys | Select-Object -Unique)
[System.IO.File]::WriteAllLines(
    $authorizedKeysPath,
    $mergedKeys,
    [System.Text.ASCIIEncoding]::new()
)

& icacls.exe $authorizedKeysPath /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Unable to apply the required ACL to administrators_authorized_keys."
}

$powerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
$defaultShellProperty = @{
    Path = 'HKLM:\SOFTWARE\OpenSSH'
    Name = 'DefaultShell'
    Value = $powerShellPath
    PropertyType = 'String'
    Force = $true
}
New-ItemProperty @defaultShellProperty | Out-Null

& $sshdExecutable -t -f $sshdConfig
if ($LASTEXITCODE -ne 0) {
    throw "OpenSSH rejected the generated sshd_config."
}

$defaultFirewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
if ($null -ne $defaultFirewallRule) {
    $defaultFirewallRule | Disable-NetFirewallRule | Out-Null
}

Set-Service -Name sshd -StartupType Automatic
if ((Get-Service -Name sshd).Status -eq 'Running') {
    Restart-Service -Name sshd
} else {
    Start-Service -Name sshd
}

$serveArguments = @(
    'serve',
    '--bg',
    '--yes',
    "--tcp=$TailnetPort",
    'tcp://127.0.0.1:22'
)
& $tailscale @serveArguments | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "OpenSSH is installed locally, but Tailscale Serve could not publish the private TCP endpoint."
}

$dnsName = [string]$tailscaleStatus.Self.DNSName
if ($dnsName) {
    $dnsName = $dnsName.TrimEnd('.')
}

[pscustomobject]@{
    Status = 'ready'
    WindowsUser = $env:USERNAME
    TailnetHost = $dnsName
    TailnetPort = $TailnetPort
    Authentication = 'publickey-only'
    RemoteShell = 'Windows PowerShell'
    ProjectRoot = (Split-Path $PSScriptRoot -Parent)
}
