[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskPath,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [string[]]$DeviceAlias = @("device-01", "device-02", "device-03"),

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\research" }
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot "run-topic-research.mjs"
$resolvedTask = (Resolve-Path -LiteralPath $TaskPath).Path
$task = Get-Content -LiteralPath $resolvedTask -Raw -Encoding UTF8 | ConvertFrom-Json

$arguments = @($runner, "--task", $resolvedTask, "--output-root", $OutputRoot)
if ($DryRun) {
    $aliases = @($DeviceAlias | Where-Object { $_ -match '^[A-Za-z0-9._-]{1,64}$' } | Select-Object -Unique)
    if (!$aliases.Count) { throw "DryRun requires at least one safe device alias" }
    $arguments += @("--dry-run", "--devices", ($aliases -join ","))
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Research session exited with code $LASTEXITCODE" }
    return
}

if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "Config not found. Copy config/matrix.example.psd1 to ignored config/local.psd1 and map every online device first."
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath)) { throw "Configured AdbPath does not exist" }
if (!$config.Devices -or $config.Devices.Count -eq 0) { throw "Formal research is blocked until online devices have local aliases" }
if (!$config.Groups -or !$config.Groups.ContainsKey($task.deviceGroup)) {
    throw "Formal research is blocked until task deviceGroup is mapped in config/local.psd1"
}

$online = @(
    & $config.AdbPath devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)
if (!$online.Count) { throw "No online ADB devices found" }
$unmappedOnline = @($online | Where-Object { !$config.Devices.ContainsKey($_) })
if ($unmappedOnline.Count) {
    throw "Formal research is blocked: one or more online devices have no local alias"
}

$groupSerials = @($config.Groups[$task.deviceGroup] | Select-Object -Unique)
if (!$groupSerials.Count) { throw "The selected device group is empty" }
$seenAliases = @{}
foreach ($serial in $groupSerials) {
    if (!$config.Devices.ContainsKey($serial)) { throw "A group member has no local alias" }
}

# Pass every mapped device to the Node gate so it can independently verify that
# every currently-online ADB identifier is mapped. Explicit per-device groups
# still ensure that only the task group is selected by the research provider.
$devices = @()
foreach ($serialKey in $config.Devices.Keys) {
    $serial = [string]$serialKey
    $alias = [string]$config.Devices[$serialKey]
    if ($alias -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $alias -eq "unmapped") { throw "A device alias is invalid" }
    if ($seenAliases.ContainsKey($alias)) { throw "Device aliases must be unique" }
    $seenAliases[$alias] = $true
    $explicitGroups = @(
        foreach ($groupName in $config.Groups.Keys) {
            if (@($config.Groups[$groupName]) -contains $serialKey) { [string]$groupName }
        }
    )
    if (!$explicitGroups.Count) { throw "Every mapped device must belong to at least one explicit group" }
    $devices += [ordered]@{ alias = $alias; serial = $serial; groups = @($explicitGroups | Select-Object -Unique) }
}

$unicodeIme = if ($config.TextInput) { $config.TextInput.UnicodeIme } else { $null }
$unicodeEnabled = [bool]($unicodeIme -and $unicodeIme.Enabled -and $unicodeIme.HumanApproved)
$approvedAliases = @()
if ($unicodeEnabled -and $unicodeIme.ApprovedAliases) {
    $approvedAliases = @($unicodeIme.ApprovedAliases | Where-Object { $seenAliases.ContainsKey([string]$_) } | Select-Object -Unique)
}
$nativeIme = if ($config.TextInput -and $config.TextInput.NativeIme) { $config.TextInput.NativeIme } elseif ($config.InputMethod) { $config.InputMethod } else { $null }
$nativeEnabled = [bool]($nativeIme -and $nativeIme.Enabled -and $nativeIme.HumanApproved)
$nativeApprovedAliases = @()
if ($nativeEnabled -and $nativeIme.ApprovedAliases) {
    $nativeApprovedAliases = @($nativeIme.ApprovedAliases | Where-Object { $seenAliases.ContainsKey([string]$_) } | Select-Object -Unique)
}
$nativePreferredServices = @()
if ($nativeIme -and $nativeIme.PreferredServices) {
    $nativePreferredServices = @($nativeIme.PreferredServices | ForEach-Object { [string]$_ } | Select-Object -Unique)
}
$nativePerDevice = [ordered]@{}
if ($nativeIme -and $nativeIme.PerDevice) {
    foreach ($aliasKey in $nativeIme.PerDevice.Keys) {
        $alias = [string]$aliasKey
        if (!$seenAliases.ContainsKey($alias)) { continue }
        $profile = $nativeIme.PerDevice[$aliasKey]
        $toggle = if ($profile.ChineseModeToggle) { $profile.ChineseModeToggle } else { $null }
        $nativePerDevice[$alias] = [ordered]@{
            preferredService = if ($profile.PreferredService) { [string]$profile.PreferredService } else { "" }
            preferredServices = if ($profile.PreferredServices) { @($profile.PreferredServices | ForEach-Object { [string]$_ } | Select-Object -Unique) } else { @() }
            allowVerifiedFirstCandidate = [bool]($profile.AllowVerifiedFirstCandidate)
            chineseModeToggle = if ($toggle) { [ordered]@{
                humanApproved = [bool]($toggle.HumanApproved)
                imeService = if ($toggle.ImeService) { [string]$toggle.ImeService } else { "" }
                x = [int]$toggle.X
                y = [int]$toggle.Y
                displayWidth = [int]$toggle.DisplayWidth
                displayHeight = [int]$toggle.DisplayHeight
                densityDpi = [int]$toggle.DensityDpi
            } } else { $null }
        }
    }
}
$providerConfig = [ordered]@{
    adbPath = [string]$config.AdbPath
    packageName = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
    devices = $devices
    unicodeInput = [ordered]@{
        enabled = $unicodeEnabled
        action = if ($unicodeIme -and $unicodeIme.Action) { [string]$unicodeIme.Action } else { "ADB_INPUT_B64" }
        extraKey = if ($unicodeIme -and $unicodeIme.ExtraKey) { [string]$unicodeIme.ExtraKey } else { "msg" }
        approvedAliases = $approvedAliases
    }
    nativeIme = [ordered]@{
        enabled = $nativeEnabled
        humanApproved = [bool]($nativeIme -and $nativeIme.HumanApproved)
        preferredServices = $nativePreferredServices
        approvedAliases = $nativeApprovedAliases
        calibrationProbe = if ($nativeIme -and $nativeIme.CalibrationProbe) { [string]$nativeIme.CalibrationProbe } else { "测试" }
        calibrationPinyin = if ($nativeIme -and $nativeIme.CalibrationPinyin) { [string]$nativeIme.CalibrationPinyin } else { "ceshi" }
        perDevice = $nativePerDevice
    }
}

$temporaryConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-provider-{0}.json" -f [guid]::NewGuid().ToString("N"))
try {
    $json = $providerConfig | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporaryConfig, $json, (New-Object System.Text.UTF8Encoding($false)))
    $arguments += @("--provider-config", $temporaryConfig)
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Research session exited with code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}
