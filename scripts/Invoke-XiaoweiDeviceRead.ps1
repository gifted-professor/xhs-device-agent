#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("List", "Size", "Ui", "Screen", "OpenApp", "Home", "TapText", "TapOcr", "NodeResolve", "NodeActivate", "WeChatWalletBalance", "XhsObserve", "XhsOpenVisible")]
    [string]$Action,
    [string]$ConfigPath,
    [string[]]$MachineNumber,
    [string]$MachineNumbersCsv,
    [string]$MachineName,
    [string[]]$DeviceAlias,
    [string]$DeviceAliasesCsv,
    [string]$Group,
    [string]$PackageName,
    [string]$Text,
    [string]$ExpectText,
    [string]$ExpectPackage,
    [string]$ExpectResourceId,
    [string]$SelectorBase64,
    [int]$Ordinal,
    [switch]$ConfirmAction,
    [string]$ConfirmationReason,
    [string]$RollbackInfo
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Config not found" }
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$machineDirectory = @(Get-MachineDirectory -Config $config)
$api = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }

function ConvertFrom-CodePoints {
    param([int[]]$CodePoints)
    -join @($CodePoints | ForEach-Object { [char]$_ })
}
if (!$api -or $api.Enabled -ne $true) { throw "Xiaowei API is disabled" }
if (!$config.Xiaowei.Executable -or !(Test-Path -LiteralPath $config.Xiaowei.Executable -PathType Leaf)) {
    throw "The configured Xiaowei executable was not found"
}
$currentVersion = (Get-Item -LiteralPath $config.Xiaowei.Executable).VersionInfo.ProductVersion
if (!$api.AcceptedXiaoweiVersion -or [string]$api.AcceptedXiaoweiVersion -ne [string]$currentVersion) {
    throw "Xiaowei device reads require the exact accepted application version"
}

if ($Action -in @("OpenApp", "TapOcr", "NodeResolve", "NodeActivate")) {
    if ([string]::IsNullOrWhiteSpace($PackageName) -or $PackageName.Length -gt 255 -or
        $PackageName -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$') {
        throw "$Action requires a valid PackageName"
    }
    $approvedPackages = @()
    if ($config.Xhs -and $config.Xhs.PackageName) { $approvedPackages += [string]$config.Xhs.PackageName }
    if ($config.Xiaowei -and $config.Xiaowei.ApprovedAppPackages) {
        $approvedPackages += @($config.Xiaowei.ApprovedAppPackages | ForEach-Object { [string]$_ })
    }
    $temporaryRelaxed = [bool]($config.Xiaowei -and $config.Xiaowei.TemporaryRelaxedNamedCommands -eq $true)
    if (!$temporaryRelaxed -and @($approvedPackages | Select-Object -Unique) -notcontains $PackageName) {
        throw "PackageName is not in the local ApprovedAppPackages allowlist"
    }
} elseif (![string]::IsNullOrWhiteSpace($PackageName)) {
    throw "PackageName is accepted only for OpenApp, TapOcr, NodeResolve, or NodeActivate"
}

if ($Action -in @("TapText", "TapOcr")) {
    $safeLabels = @(
        "cancel", "close", "not now", "later", "back",
        (ConvertFrom-CodePoints @(21462, 28040)),
        (ConvertFrom-CodePoints @(20851, 38381)),
        (ConvertFrom-CodePoints @(31245, 21518)),
        (ConvertFrom-CodePoints @(20197, 21518)),
        (ConvertFrom-CodePoints @(36820, 22238)),
        (ConvertFrom-CodePoints @(29702, 36130)),
        (ConvertFrom-CodePoints @(25105, 30340)),
        (ConvertFrom-CodePoints @(24037, 20316, 21488)),
        (ConvertFrom-CodePoints @(36229, 32423, 25830, 20142)),
        (ConvertFrom-CodePoints @(31435, 21363, 21435, 25830, 20142)),
        (ConvertFrom-CodePoints @(36817, 55, 26085)),
        (ConvertFrom-CodePoints @(20170, 26085))
    )
    $normalizedText = if ($Text) { $Text.Normalize([System.Text.NormalizationForm]::FormKC).Trim() } else { "" }
    $temporaryRelaxed = [bool]($config.Xiaowei -and $config.Xiaowei.TemporaryRelaxedNamedCommands -eq $true)
    if (!$temporaryRelaxed -and $safeLabels -notcontains $normalizedText.ToLowerInvariant()) {
        throw "TapText is limited to the local-safe navigation allowlist"
    }
    $postconditionCount = @(@($ExpectText, $ExpectPackage, $ExpectResourceId) | Where-Object { ![string]::IsNullOrWhiteSpace($_) }).Count
    if ($Action -eq "TapOcr") {
        if ([string]::IsNullOrWhiteSpace($ExpectText) -or ![string]::IsNullOrWhiteSpace($ExpectPackage) -or
            ![string]::IsNullOrWhiteSpace($ExpectResourceId)) {
            throw "TapOcr requires exactly one screenshot ExpectText postcondition"
        }
    } elseif ($postconditionCount -ne 1) { throw "TapText requires exactly one postcondition" }
    if (!$ConfirmAction -or ([string]$ConfirmationReason).Trim().Length -lt 3 -or ([string]$RollbackInfo).Trim().Length -lt 3) {
        throw "$Action requires explicit confirmation reason and rollback information"
    }
} elseif ($Action -eq "NodeActivate") {
    if ([string]::IsNullOrWhiteSpace($ExpectText) -or $ExpectText.Length -gt 256 -or
        ![string]::IsNullOrWhiteSpace($Text) -or ![string]::IsNullOrWhiteSpace($ExpectPackage) -or
        ![string]::IsNullOrWhiteSpace($ExpectResourceId)) {
        throw "NodeActivate requires exactly one text postcondition"
    }
    if (!$ConfirmAction -or ([string]$ConfirmationReason).Trim().Length -lt 3 -or ([string]$RollbackInfo).Trim().Length -lt 3) {
        throw "NodeActivate requires explicit confirmation reason and rollback information"
    }
} elseif (![string]::IsNullOrWhiteSpace($Text) -or ![string]::IsNullOrWhiteSpace($ExpectText) -or
    ![string]::IsNullOrWhiteSpace($ExpectPackage) -or ![string]::IsNullOrWhiteSpace($ExpectResourceId) -or $ConfirmAction) {
    throw "Tap parameters are accepted only for TapText or TapOcr"
}
$selector = $null
if ($Action -in @("NodeResolve", "NodeActivate")) {
    if ([string]::IsNullOrWhiteSpace($SelectorBase64) -or $SelectorBase64.Length -gt 16384 -or
        $SelectorBase64 -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
        throw "$Action requires a bounded SelectorBase64"
    }
    try {
        $selectorJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($SelectorBase64))
        $selector = $selectorJson | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "$Action SelectorBase64 is invalid" }
    if ($null -eq $selector -or $selector -is [string] -or $selector -is [System.Array]) {
        throw "$Action selector must be an object"
    }
} elseif (![string]::IsNullOrWhiteSpace($SelectorBase64)) {
    throw "SelectorBase64 is accepted only for NodeResolve or NodeActivate"
}
if ($Action -eq "XhsOpenVisible") {
    if ($Ordinal -lt 1 -or $Ordinal -gt 20) { throw "XhsOpenVisible requires Ordinal from 1 through 20" }
} elseif ($Ordinal -ne 0) { throw "Ordinal is accepted only for XhsOpenVisible" }

if ($MachineNumbersCsv) {
    if ($MachineNumber) { throw "Use MachineNumber or MachineNumbersCsv, not both" }
    $MachineNumber = @($MachineNumbersCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
if ($DeviceAliasesCsv) {
    if ($DeviceAlias) { throw "Use DeviceAlias or DeviceAliasesCsv, not both" }
    $DeviceAlias = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$selectionModes = @([bool]$MachineNumber, [bool]$MachineName, [bool]$DeviceAlias, [bool]$Group) | Where-Object { $_ }
if ($Action -eq "List") {
    if ($selectionModes.Count -ne 0) { throw "List does not accept a machine selector" }
} elseif ($selectionModes.Count -ne 1) {
    throw "Select exactly one machine selector or group"
}
if ($Action -in @("TapText", "TapOcr", "NodeResolve", "NodeActivate")) {
    $tapTargetCount = if ($MachineNumber) { @($MachineNumber).Count } elseif ($MachineName) { 1 } elseif ($DeviceAlias) { @($DeviceAlias).Count } else { 0 }
    if ($Group -or $tapTargetCount -ne 1) { throw "$Action is single-device only and does not accept groups" }
}

$serials = @()
if ($Action -eq "List") {
    $serials = @($config.Devices.Keys | ForEach-Object { [string]$_ })
} elseif ($Group) {
    if (!$config.Groups -or !$config.Groups.ContainsKey($Group)) { throw "Unknown group" }
    $serials = @($config.Groups[$Group] | ForEach-Object { [string]$_ })
} elseif ($MachineNumber) {
    foreach ($number in $MachineNumber) {
        $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber ([string]$number)
        $matches = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
        if ($matches.Count -ne 1) { throw "Machine identity is not uniquely bound" }
        $serials += [string]$matches[0]
    }
} elseif ($MachineName) {
    $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineName $MachineName
    $serials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
} else {
    foreach ($alias in $DeviceAlias) {
        if ([string]$alias -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "DeviceAlias is invalid" }
        $matches = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq [string]$alias })
        if ($matches.Count -ne 1) { throw "DeviceAlias is not uniquely bound" }
        $serials += [string]$matches[0]
    }
}
$serials = @($serials | Select-Object -Unique)
if (!$serials.Count) { throw "No devices were selected" }
if ($Action -eq "Size" -and $serials.Count -ne 1) { throw "Size requires exactly one machine" }
if ($Action -eq "WeChatWalletBalance" -and $serials.Count -ne 1) { throw "WeChatWalletBalance requires exactly one machine" }
if ($Action -eq "XhsObserve" -and $serials.Count -ne 1) { throw "XhsObserve requires exactly one machine" }
if ($Action -eq "XhsOpenVisible" -and $serials.Count -ne 1) { throw "XhsOpenVisible requires exactly one machine" }
if ($Action -in @("NodeResolve", "NodeActivate") -and $serials.Count -ne 1) { throw "$Action requires exactly one machine" }

$targets = @()
foreach ($serial in $serials) {
    if (!$config.Devices.ContainsKey($serial)) { throw "Selected device is not configured" }
    $alias = [string]$config.Devices[$serial]
    $identity = Get-MachineIdentityForAlias -Directory $machineDirectory -DeviceAlias $alias
    $acceptedSerial = if ($api.AcceptedDeviceSerialsByAlias -and $api.AcceptedDeviceSerialsByAlias.ContainsKey($alias)) {
        [string]$api.AcceptedDeviceSerialsByAlias[$alias]
    } else { $null }
    if ($Action -ne "List" -and [string]$acceptedSerial -cne [string]$serial) {
        throw "Xiaowei device identity acceptance is missing or stale"
    }
    $targets += [ordered]@{
        machine = $identity.Number
        name = $identity.Name
        alias = $alias
        serial = [string]$serial
        acceptedSerial = $acceptedSerial
    }
}

$runRoot = Join-Path $projectRoot "data\matrix\runs\$((Get-Date).ToString('yyyyMMdd-HHmmss-fff'))-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$requestAction = switch ($Action) {
    "List" { "list" }
    "Size" { "size" }
    "Ui" { "ui" }
    "Screen" { "screen" }
    "OpenApp" { "open-app" }
    "Home" { "home" }
    "TapText" { "tap-text" }
    "TapOcr" { "tap-ocr" }
    "NodeResolve" { "node-resolve" }
    "NodeActivate" { "node-activate" }
    "WeChatWalletBalance" { "wechat-wallet-balance" }
    "XhsObserve" { "xhs-observe" }
    "XhsOpenVisible" { "xhs-open-visible" }
}
$request = [ordered]@{
    action = $requestAction
    outputRoot = $runRoot
    targets = @($targets)
}
if ($Action -in @("List", "Size")) {
    $request["privateEndpoint"] = if ($api.PrivateApiDebuggerEndpoint) { [string]$api.PrivateApiDebuggerEndpoint } else { "http://127.0.0.1:9223" }
} else {
    $request["endpoint"] = if ($config.Xiaowei.ApiEndpoint) { [string]$config.Xiaowei.ApiEndpoint } else { "ws://127.0.0.1:22222/" }
}
if ($Action -in @("OpenApp", "TapOcr", "NodeResolve", "NodeActivate")) { $request["package"] = $PackageName }
if ($Action -in @("TapText", "TapOcr")) {
    $request["text"] = $normalizedText
    if (![string]::IsNullOrWhiteSpace($ExpectText)) {
        $request["postcondition"] = [ordered]@{ kind = "text"; value = $ExpectText }
    } elseif (![string]::IsNullOrWhiteSpace($ExpectPackage)) {
        $request["postcondition"] = [ordered]@{ kind = "package"; value = $ExpectPackage }
    } else {
        $request["postcondition"] = [ordered]@{ kind = "resource-id"; value = $ExpectResourceId }
    }
}
if ($Action -in @("NodeResolve", "NodeActivate")) { $request["selector"] = $selector }
if ($Action -eq "NodeActivate") {
    $request["postcondition"] = [ordered]@{ kind = "text"; value = $ExpectText }
}
if ($Action -eq "XhsOpenVisible") { $request["ordinal"] = $Ordinal }
$requestPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-device-read-{0}.json" -f [guid]::NewGuid().ToString("N"))
$encoding = New-Object System.Text.UTF8Encoding($false)
$lockHandles = @()
$exitCode = 1
try {
    if ($Action -ne "List") {
        $lockHandles = @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases @($targets | ForEach-Object { $_.alias }))
    }
    [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 8 -Compress), $encoding)
    & node (Join-Path $PSScriptRoot "xiaowei-device-read.mjs") --request-file $requestPath
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
    if ($lockHandles.Count) { Exit-DeviceLocks -Handles $lockHandles }
}
if ($exitCode) { exit $exitCode }
