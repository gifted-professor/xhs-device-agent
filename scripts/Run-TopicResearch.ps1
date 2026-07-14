[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TaskPath,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [string[]]$DeviceAlias = @("device-01", "device-02", "device-03"),

    [string]$DeviceAliasesCsv,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\research" }
$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot "run-topic-research.mjs"
$resolvedTask = (Resolve-Path -LiteralPath $TaskPath).Path
$task = Get-Content -LiteralPath $resolvedTask -Raw -Encoding UTF8 | ConvertFrom-Json

if (![string]::IsNullOrWhiteSpace($DeviceAliasesCsv)) {
    $parsedAliases = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() })
    if (!$parsedAliases.Count -or $parsedAliases.Count -ne @($parsedAliases | Select-Object -Unique).Count) {
        throw "DeviceAliasesCsv requires unique aliases"
    }
    $DeviceAlias = $parsedAliases
}

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
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
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
    if ($alias -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $alias -eq "unmapped" -or $alias -eq $serial) { throw "A device alias is invalid or exposes the raw ADB identifier" }
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
$xiaoweiTextInput = if ($config.Xiaowei -and $config.Xiaowei.TextInput) { $config.Xiaowei.TextInput } else { $null }
$xiaoweiApiPolicy = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
$xiaoweiAcceptedActionsByAlias = if ($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedActionsByAlias) { $xiaoweiApiPolicy.AcceptedActionsByAlias } else { $null }
$xiaoweiAcceptedDeviceSerialsByAlias = if ($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedDeviceSerialsByAlias) { $xiaoweiApiPolicy.AcceptedDeviceSerialsByAlias } else { $null }
$xiaoweiOperatorActions = @("screen", "pushEvent", "apkList", "startApk", "stopApk", "imeList", "selectIme", "inputText")
$xiaoweiCurrentVersion = $null
if ($config.Xiaowei -and $config.Xiaowei.Executable -and (Test-Path -LiteralPath $config.Xiaowei.Executable -PathType Leaf)) {
    $xiaoweiCurrentVersion = (Get-Item -LiteralPath $config.Xiaowei.Executable).VersionInfo.ProductVersion
}
$xiaoweiAcceptedVersion = if ($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedXiaoweiVersion) { [string]$xiaoweiApiPolicy.AcceptedXiaoweiVersion } else { "" }
$xiaoweiVersionAccepted = [bool]($xiaoweiCurrentVersion -and $xiaoweiAcceptedVersion -and ([string]$xiaoweiCurrentVersion -eq $xiaoweiAcceptedVersion))
$xiaoweiTextRequested = [bool]($xiaoweiTextInput -and $xiaoweiTextInput.Enabled)
$xiaoweiTextActionsAccepted = [bool]($xiaoweiApiPolicy -and !$xiaoweiApiPolicy.ContainsKey("AcceptedActions"))
if ($xiaoweiAcceptedActionsByAlias) {
    foreach ($aliasKey in $xiaoweiAcceptedActionsByAlias.Keys) {
        $configuredAlias = [string]$aliasKey
        $configuredActions = @($xiaoweiAcceptedActionsByAlias[$aliasKey] | ForEach-Object { [string]$_ } | Select-Object -Unique)
        $matchingDevices = @($devices | Where-Object { $_.alias -eq $configuredAlias })
        $bindingMatches = [bool](!$configuredActions.Count -or ($matchingDevices.Count -eq 1 -and
            $xiaoweiAcceptedDeviceSerialsByAlias -and
            $xiaoweiAcceptedDeviceSerialsByAlias.ContainsKey($configuredAlias) -and
            [string]$xiaoweiAcceptedDeviceSerialsByAlias[$configuredAlias] -eq [string]$matchingDevices[0].serial))
        if (!$seenAliases.ContainsKey($configuredAlias) -or !$bindingMatches -or @($configuredActions | Where-Object { $xiaoweiOperatorActions -notcontains $_ }).Count) {
            $xiaoweiTextActionsAccepted = $false
        }
    }
}
foreach ($approvedAlias in @($xiaoweiTextInput.ApprovedAliases)) {
    $alias = [string]$approvedAlias
    $acceptedForAlias = if ($xiaoweiAcceptedActionsByAlias -and $xiaoweiAcceptedActionsByAlias.ContainsKey($alias)) { @($xiaoweiAcceptedActionsByAlias[$alias] | ForEach-Object { [string]$_ } | Select-Object -Unique) } else { @() }
    if (@("imeList", "selectIme", "inputText" | Where-Object { $acceptedForAlias -notcontains $_ }).Count) { $xiaoweiTextActionsAccepted = $false }
}
$xiaoweiTextEnabled = [bool]($xiaoweiTextRequested -and $xiaoweiTextInput.HumanApproved -and $xiaoweiApiPolicy -and $xiaoweiApiPolicy.Enabled -and $xiaoweiVersionAccepted -and $xiaoweiTextActionsAccepted)
if ($xiaoweiTextRequested -and !$xiaoweiTextEnabled) {
    throw "Enabled Xiaowei text input requires HumanApproved, Xiaowei.Api.Enabled, exact AcceptedXiaoweiVersion, and per-alias accepted imeList/selectIme/inputText actions"
}
$xiaoweiApprovedAliases = @()
if ($xiaoweiTextEnabled -and $xiaoweiTextInput.ApprovedAliases) {
    $xiaoweiApprovedAliases = @($xiaoweiTextInput.ApprovedAliases | Where-Object { $seenAliases.ContainsKey([string]$_) } | Select-Object -Unique)
}
$xiaoweiPreferredImeServices = @()
if ($xiaoweiTextInput -and $xiaoweiTextInput.PreferredImeServices) {
    $xiaoweiPreferredImeServices = @($xiaoweiTextInput.PreferredImeServices | ForEach-Object { [string]$_ } | Select-Object -Unique)
}
$xiaoweiPerDevice = [ordered]@{}
if ($xiaoweiTextInput -and $xiaoweiTextInput.PerDevice) {
    foreach ($aliasKey in $xiaoweiTextInput.PerDevice.Keys) {
        $alias = [string]$aliasKey
        if (!$seenAliases.ContainsKey($alias)) { continue }
        $profile = $xiaoweiTextInput.PerDevice[$aliasKey]
        if (!$profile.ContainsKey("AllowTemporaryEnable") -or $profile.AllowTemporaryEnable -isnot [bool]) {
            throw "Xiaowei per-device AllowTemporaryEnable must be a boolean"
        }
        $echoVerification = if ($profile.ContainsKey("EchoVerification")) { [string]$profile.EchoVerification } else { "" }
        if ($echoVerification -cne "ui_text" -and $echoVerification -cne "local_ocr") {
            throw "Xiaowei per-device EchoVerification must be ui_text or local_ocr"
        }
        $xiaoweiPerDevice[$alias] = [ordered]@{
            preferredImeService = if ($profile.PreferredImeService) { [string]$profile.PreferredImeService } else { "" }
            allowTemporaryEnable = [bool]($profile.AllowTemporaryEnable)
            echoVerification = $echoVerification
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
    xiaowei = [ordered]@{
        endpoint = if ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { [string]$config.Xiaowei.ApiEndpoint } else { "ws://127.0.0.1:22222/" }
        api = [ordered]@{
            enabled = [bool]($xiaoweiApiPolicy -and $xiaoweiApiPolicy.Enabled)
            acceptedActions = @("imeList", "selectIme", "inputText")
            acceptedActionsByAlias = if ($xiaoweiAcceptedActionsByAlias) { $xiaoweiAcceptedActionsByAlias } else { [ordered]@{} }
            acceptedDeviceSerialsByAlias = if ($xiaoweiAcceptedDeviceSerialsByAlias) { $xiaoweiAcceptedDeviceSerialsByAlias } else { [ordered]@{} }
            acceptedXiaoweiVersion = $xiaoweiAcceptedVersion
            currentXiaoweiVersion = if ($xiaoweiCurrentVersion) { [string]$xiaoweiCurrentVersion } else { "" }
        }
        textInput = [ordered]@{
            enabled = $xiaoweiTextEnabled
            humanApproved = [bool]($xiaoweiTextInput -and $xiaoweiTextInput.HumanApproved)
            approvedAliases = $xiaoweiApprovedAliases
            preferredImeServices = $xiaoweiPreferredImeServices
            perDevice = $xiaoweiPerDevice
        }
    }
}

$researchLockAliases = @($groupSerials | ForEach-Object { [string]$config.Devices[$_] } | Select-Object -Unique)
$deviceLockHandles = @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases $researchLockAliases)
$temporaryConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-provider-{0}.json" -f [guid]::NewGuid().ToString("N"))
try {
    $json = $providerConfig | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($temporaryConfig, $json, (New-Object System.Text.UTF8Encoding($false)))
    $arguments += @("--provider-config", $temporaryConfig)
    & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Research session exited with code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
    Exit-DeviceLocks -Handles $deviceLockHandles
}
