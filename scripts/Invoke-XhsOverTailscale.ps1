#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[^-\s][^\s]*$')]
    [string]$HostName,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$UserName,

    [string]$IdentityFile,

    [ValidateRange(1, 65535)]
    [int]$Port = 2222,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$XhsArguments,

    [switch]$PrintOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sshCommand = Get-Command ssh -ErrorAction SilentlyContinue
if ($null -eq $sshCommand) {
    $sshCommand = Get-Command ssh.exe -ErrorAction Stop
}
$ssh = $sshCommand.Source
$resolvedIdentityFile = $null
if ($IdentityFile) {
    $resolvedIdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
}

$payloadJson = [ordered]@{
    projectRoot = $ProjectRoot
    arguments = @($XhsArguments)
} | ConvertTo-Json -Compress -Depth 4
$payloadBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payloadJson))

$remoteScript = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$utf8 = [System.Text.UTF8Encoding]::new(`$false)
[Console]::InputEncoding = `$utf8
[Console]::OutputEncoding = `$utf8
`$OutputEncoding = `$utf8
`$payloadJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$payloadBase64'))
`$payload = `$payloadJson | ConvertFrom-Json
`$xhsArguments = @(`$payload.arguments | ForEach-Object { [string]`$_ })
Set-Location -LiteralPath ([string]`$payload.projectRoot)
& (Join-Path ([string]`$payload.projectRoot) 'xhs.cmd') @xhsArguments
if (`$null -ne `$LASTEXITCODE) { exit `$LASTEXITCODE }
"@
$encodedCommand = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($remoteScript))

$sshArguments = @(
    '-T',
    '-p', [string]$Port,
    '-l', $UserName,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3'
)
if ($resolvedIdentityFile) {
    $sshArguments += @('-i', $resolvedIdentityFile)
}
$sshArguments += @(
    $HostName,
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-InputFormat',
    'Text',
    '-OutputFormat',
    'Text',
    '-EncodedCommand',
    $encodedCommand
)

if ($PrintOnly) {
    [pscustomobject]@{
        Target = "$UserName@$HostName"
        Port = $Port
        ProjectRoot = $ProjectRoot
        XhsArguments = @($XhsArguments)
        Authentication = if ($resolvedIdentityFile) { 'identity-file' } else { 'ssh-agent-or-default-key' }
    }
    return
}

& $ssh @sshArguments
exit $LASTEXITCODE
