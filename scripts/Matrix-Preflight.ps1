param(
    [string]$ConfigPath,
    [switch]$ProbeApi
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }

if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "Config not found: $ConfigPath. Copy config/matrix.example.psd1 to config/local.psd1 first."
}
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$machineDirectory = @()
$machineDirectoryError = $null
try {
    $machineDirectory = @(Get-MachineDirectory -Config $config)
} catch {
    $machineDirectoryError = $_.Exception.Message
}
if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath)) {
    throw "Configured AdbPath does not exist"
}

$windowsCapture = & (Join-Path $PSScriptRoot "Get-WindowsCaptureCompatibility.ps1")

$software = [ordered]@{
    configured = [bool]$config.Xiaowei
    executableExists = $false
    version = $null
    processRunning = $false
}
if ($config.Xiaowei -and $config.Xiaowei.Executable) {
    $software.executableExists = Test-Path -LiteralPath $config.Xiaowei.Executable
    if ($software.executableExists) {
        $software.version = (Get-Item -LiteralPath $config.Xiaowei.Executable).VersionInfo.ProductVersion
    }
}
$software.processRunning = [bool](Get-Process -Name touping,xiaowei -ErrorAction SilentlyContinue | Select-Object -First 1)

$online = @(
    & $config.AdbPath devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)
$devices = foreach ($serial in $online) {
    $deviceAlias = if ($config.Devices -and $config.Devices.ContainsKey($serial)) { [string]$config.Devices[$serial] } else { "unmapped" }
    $identity = @($machineDirectory | Where-Object { $_.DeviceAlias -ceq $deviceAlias }) | Select-Object -First 1
    [ordered]@{
        machine = if ($identity) { $identity.Number } else { "unmapped" }
        name = if ($identity) { $identity.Name } else { "unmapped" }
        model = (& $config.AdbPath -s $serial shell getprop ro.product.model 2>$null | Out-String).Trim()
        android = (& $config.AdbPath -s $serial shell getprop ro.build.version.release 2>$null | Out-String).Trim()
    }
}

$api = [ordered]@{
    endpoint = if ($config.Xiaowei) { $config.Xiaowei.ApiEndpoint } else { $null }
    probed = [bool]$ProbeApi
    available = $false
    identityAligned = $false
    apiDeviceCount = 0
    acceptedActions = @()
    acceptedActionsByAlias = [ordered]@{}
    invalidAcceptedActions = @()
    blockedAcceptedActions = @()
    catalogOnlyAcceptedActions = @()
    nonAliasAcceptedActions = @()
    deviceBindingMismatches = @()
    unknownAcceptedAliases = @()
    legacyGlobalAcceptedActions = @()
    versionAccepted = $false
    routingEnabled = $false
    reason = "not probed"
}
$apiPolicy = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
$configuredAcceptedActionsByAlias = if ($apiPolicy -and $apiPolicy.AcceptedActionsByAlias) { $apiPolicy.AcceptedActionsByAlias } else { $null }
$configuredAcceptedDeviceSerialsByAlias = if ($apiPolicy -and $apiPolicy.AcceptedDeviceSerialsByAlias) { $apiPolicy.AcceptedDeviceSerialsByAlias } else { $null }
if ($apiPolicy -and $apiPolicy.AcceptedActions) { $api.legacyGlobalAcceptedActions = @($apiPolicy.AcceptedActions | ForEach-Object { [string]$_ } | Select-Object -Unique) }
$catalogRaw = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") catalog 2>&1 | Out-String
try {
    $catalog = $catalogRaw | ConvertFrom-Json
    $knownActions = @($catalog.actions | ForEach-Object { [string]$_.action })
    $ordinaryActions = @($catalog.actions | Where-Object { !$_.blockedByDefault -and $_.risk -notin @("privileged", "opaque_automation_blocked") } | ForEach-Object { [string]$_.action })
    $nonAliasActions = @($catalog.actions | Where-Object { $_.devices -eq "forbidden" } | ForEach-Object { [string]$_.action })
    # list is the unconditional read-only identity probe and has no per-device
    # acceptance meaning. Every accepted alias action must target that alias.
    $routableActions = @($catalog.actions | Where-Object { $_.action -ne "list" -and $_.operator.status -in @("routable", "partial", "profile_only") } | ForEach-Object { [string]$_.action })
    if ($configuredAcceptedActionsByAlias) {
        foreach ($aliasKey in $configuredAcceptedActionsByAlias.Keys) {
            $alias = [string]$aliasKey
            $actions = @($configuredAcceptedActionsByAlias[$aliasKey] | ForEach-Object { [string]$_ } | Select-Object -Unique)
            $valid = @($actions | Where-Object { $routableActions -contains $_ })
            $api.acceptedActionsByAlias[$alias] = $valid
            $api.acceptedActions += $valid
            $api.invalidAcceptedActions += @($actions | Where-Object { $knownActions -notcontains $_ })
            $api.blockedAcceptedActions += @($actions | Where-Object { $knownActions -contains $_ -and $ordinaryActions -notcontains $_ })
            $api.nonAliasAcceptedActions += @($actions | Where-Object { $nonAliasActions -contains $_ })
            $api.catalogOnlyAcceptedActions += @($actions | Where-Object { $ordinaryActions -contains $_ -and $nonAliasActions -notcontains $_ -and $routableActions -notcontains $_ })
        }
    }
    $api.acceptedActions = @($api.acceptedActions | Select-Object -Unique)
    $api.invalidAcceptedActions = @($api.invalidAcceptedActions | Select-Object -Unique)
    $api.blockedAcceptedActions = @($api.blockedAcceptedActions | Select-Object -Unique)
    $api.catalogOnlyAcceptedActions = @($api.catalogOnlyAcceptedActions | Select-Object -Unique)
    $api.nonAliasAcceptedActions = @($api.nonAliasAcceptedActions | Select-Object -Unique)
} catch {
    $api.invalidAcceptedActions = @("catalog-unavailable")
}
if ($ProbeApi) {
    $previousApiUrl = $env:XIAOWEI_API_URL
    $apiResultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-list-{0}.json" -f [guid]::NewGuid().ToString("N"))
    try {
        if ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { $env:XIAOWEI_API_URL = $config.Xiaowei.ApiEndpoint }
        $processOutput = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") list --internal-gateway --result-file $apiResultPath 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $apiResultPath -PathType Leaf)) {
            $raw = Get-Content -LiteralPath $apiResultPath -Raw -Encoding UTF8
        } else {
            $raw = $processOutput
        }
    } finally {
        $env:XIAOWEI_API_URL = $previousApiUrl
        Remove-Item -LiteralPath $apiResultPath -Force -ErrorAction SilentlyContinue
    }
    try {
        $body = $raw | ConvertFrom-Json
        if ($body.code -eq 10000 -and $body.data -is [array]) {
            $api.available = $true
            $apiIds = @($body.data | ForEach-Object { if ($_.serial) { [string]$_.serial } elseif ($_.onlySerial) { [string]$_.onlySerial } } | Where-Object { $_ } | Select-Object -Unique)
            $api.apiDeviceCount = $apiIds.Count
            $missingFromApi = @($online | Where-Object { $apiIds -notcontains $_ })
            $missingFromAdb = @($apiIds | Where-Object { $online -notcontains $_ })
            $api.identityAligned = !$missingFromApi.Count -and !$missingFromAdb.Count
            $api.reason = if ($api.identityAligned) { "available and aligned with ADB" } else { "available, but API and ADB device identities differ" }
        } else {
            $api.reason = "API returned code=$($body.code): $($body.message)"
        }
    } catch {
        $api.reason = ($raw.Trim() -replace '\r?\n', ' ')
    }
}

$configurationBlockers = New-Object System.Collections.Generic.List[string]
if (!$online.Count) { $configurationBlockers.Add("no online ADB devices") }
if ($machineDirectoryError) { $configurationBlockers.Add("machine directory: $machineDirectoryError") }
$mappedAliases = @()
if (!$config.Devices -or !$config.Devices.Count) {
    $configurationBlockers.Add("no local device aliases are configured")
} else {
    $mappedAliases = @($config.Devices.Values | ForEach-Object { [string]$_ })
    if (@($mappedAliases | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $_ -eq "unmapped" }).Count) {
        $configurationBlockers.Add("one or more device aliases are unsafe or unmapped")
    }
    if (@($mappedAliases | Select-Object -Unique).Count -ne $mappedAliases.Count) {
        $configurationBlockers.Add("device aliases are not unique")
    }
    if (@($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq [string]$_ }).Count) {
        $configurationBlockers.Add("a public device alias equals its raw ADB identifier")
    }
    if ($configuredAcceptedActionsByAlias) {
        $api.unknownAcceptedAliases = @($configuredAcceptedActionsByAlias.Keys | ForEach-Object { [string]$_ } | Where-Object { $mappedAliases -notcontains $_ } | Select-Object -Unique)
        foreach ($aliasKey in $configuredAcceptedActionsByAlias.Keys) {
            $alias = [string]$aliasKey
            $actions = @($configuredAcceptedActionsByAlias[$aliasKey])
            if (!$actions.Count) { continue }
            $matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq $alias })
            $bindingMatches = [bool]($matchingSerials.Count -eq 1 -and
                $configuredAcceptedDeviceSerialsByAlias -and
                $configuredAcceptedDeviceSerialsByAlias.ContainsKey($alias) -and
                [string]$configuredAcceptedDeviceSerialsByAlias[$alias] -eq [string]$matchingSerials[0])
            if (!$bindingMatches) { $api.deviceBindingMismatches += $alias }
        }
        $api.deviceBindingMismatches = @($api.deviceBindingMismatches | Select-Object -Unique)
    }
}
if (@($online | Where-Object { !$config.Devices -or !$config.Devices.ContainsKey($_) }).Count) {
    $configurationBlockers.Add("one or more online devices have no local alias")
}
$xhsInteractionActions = @("like", "favorite", "follow", "comment", "publish", "delete")
$xhsAllowedActionsByAlias = if ($config.Xhs -and $config.Xhs.Interactions -and $config.Xhs.Interactions.AllowedActionsByAlias) { $config.Xhs.Interactions.AllowedActionsByAlias } else { $null }
if ($xhsAllowedActionsByAlias) {
    foreach ($aliasKey in $xhsAllowedActionsByAlias.Keys) {
        $alias = [string]$aliasKey
        $actions = @($xhsAllowedActionsByAlias[$aliasKey] | ForEach-Object { [string]$_ } | Select-Object -Unique)
        if ($mappedAliases -notcontains $alias) {
            $configurationBlockers.Add("XHS interaction authorization references an unknown device alias")
        }
        if (@($actions | Where-Object { $xhsInteractionActions -notcontains $_ }).Count) {
            $configurationBlockers.Add("XHS interaction authorization contains an unknown semantic action")
        }
    }
}
if (!$config.Groups -or !$config.Groups.Count) {
    $configurationBlockers.Add("no explicit device groups are configured")
} else {
    foreach ($groupName in $config.Groups.Keys) {
        $members = @($config.Groups[$groupName])
        if (!$members.Count) { $configurationBlockers.Add("one or more device groups are empty") }
        if (@($members | Where-Object { !$config.Devices -or !$config.Devices.ContainsKey($_) }).Count) {
            $configurationBlockers.Add("one or more device groups contain an unmapped member")
        }
    }
    foreach ($serial in $online) {
        $memberships = @($config.Groups.Keys | Where-Object { @($config.Groups[$_]) -contains $serial })
        if (!$memberships.Count) { $configurationBlockers.Add("one or more online devices have no explicit group") }
    }
}
$xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
if ($xhsPackage -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$') {
    $configurationBlockers.Add("the configured XHS package name is invalid")
}
$approvedPackages = if ($config.Xiaowei -and $config.Xiaowei.ApprovedAppPackages) { @($config.Xiaowei.ApprovedAppPackages | ForEach-Object { [string]$_ }) } else { @() }
if (@($approvedPackages | Where-Object { $_ -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$' }).Count) {
    $configurationBlockers.Add("one or more approved app package names are invalid")
}
$xiaoweiText = if ($config.Xiaowei -and $config.Xiaowei.TextInput) { $config.Xiaowei.TextInput } else { $null }
if ($xiaoweiText -and $xiaoweiText.Enabled) {
    if (!$xiaoweiText.HumanApproved -or !$xiaoweiText.ApprovedAliases -or !$xiaoweiText.PreferredImeServices) {
        $configurationBlockers.Add("enabled Xiaowei text input lacks human approval, aliases, or bridge services")
    } elseif (@($xiaoweiText.ApprovedAliases | Where-Object { $mappedAliases -notcontains [string]$_ }).Count) {
        $configurationBlockers.Add("Xiaowei text input references an unknown device alias")
    }
    $bridgeServices = @($xiaoweiText.PreferredImeServices | ForEach-Object { [string]$_ } | Select-Object -Unique)
    if (@($bridgeServices | Where-Object { $_ -notmatch '^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$' -or $_ -notmatch '^(?:com\.xiaowei\.assistant/.+|com\.android\.xwkeyboard/.+|com\.xueren/.+|com\.truedian\.dragon/.+)$' }).Count) {
        $configurationBlockers.Add("Xiaowei text input contains an unapproved bridge service format")
    }
    foreach ($aliasValue in @($xiaoweiText.ApprovedAliases)) {
        $alias = [string]$aliasValue
        if (!$xiaoweiText.PerDevice -or !$xiaoweiText.PerDevice.ContainsKey($alias) -or $bridgeServices -notcontains [string]$xiaoweiText.PerDevice[$alias].PreferredImeService) {
            $configurationBlockers.Add("Xiaowei text input lacks a valid per-alias bridge profile")
        } elseif (!$xiaoweiText.PerDevice[$alias].ContainsKey("AllowTemporaryEnable") -or $xiaoweiText.PerDevice[$alias].AllowTemporaryEnable -isnot [bool]) {
            $configurationBlockers.Add("Xiaowei per-device AllowTemporaryEnable must be boolean")
        } elseif (!$xiaoweiText.PerDevice[$alias].ContainsKey("EchoVerification") -or (
            [string]$xiaoweiText.PerDevice[$alias].EchoVerification -cne "ui_text" -and
            [string]$xiaoweiText.PerDevice[$alias].EchoVerification -cne "local_ocr"
        )) {
            $configurationBlockers.Add("Xiaowei per-device EchoVerification must be ui_text or local_ocr")
        }
    }
}
$unicodeIme = if ($config.TextInput -and $config.TextInput.UnicodeIme) { $config.TextInput.UnicodeIme } else { $null }
if ($unicodeIme -and $unicodeIme.Enabled -and (!$unicodeIme.HumanApproved -or !$unicodeIme.ApprovedAliases)) {
    $configurationBlockers.Add("enabled Unicode input lacks human approval or aliases")
}
if ($unicodeIme -and $unicodeIme.Enabled -and @($unicodeIme.ApprovedAliases | Where-Object { $mappedAliases -notcontains [string]$_ }).Count) {
    $configurationBlockers.Add("Unicode input references an unknown device alias")
}
$nativeIme = if ($config.TextInput -and $config.TextInput.NativeIme) { $config.TextInput.NativeIme } else { $null }
if ($nativeIme -and $nativeIme.Enabled -and (!$nativeIme.HumanApproved -or !$nativeIme.ApprovedAliases)) {
    $configurationBlockers.Add("enabled native input lacks human approval or aliases")
}
if ($nativeIme -and $nativeIme.Enabled -and @($nativeIme.ApprovedAliases | Where-Object { $mappedAliases -notcontains [string]$_ }).Count) {
    $configurationBlockers.Add("native input references an unknown device alias")
}
$versionAccepted = [bool]($apiPolicy -and $apiPolicy.AcceptedXiaoweiVersion -and $software.version -and ([string]$apiPolicy.AcceptedXiaoweiVersion -eq [string]$software.version))
$api.versionAccepted = $versionAccepted
$api.routingEnabled = [bool]($apiPolicy -and $apiPolicy.Enabled -and $api.available -and $api.identityAligned -and $versionAccepted -and $api.acceptedActions.Count -and !$api.invalidAcceptedActions.Count -and !$api.blockedAcceptedActions.Count -and !$api.catalogOnlyAcceptedActions.Count -and !$api.nonAliasAcceptedActions.Count -and !$api.deviceBindingMismatches.Count -and !$api.unknownAcceptedAliases.Count -and !$api.legacyGlobalAcceptedActions.Count)
$apiBlockers = New-Object System.Collections.Generic.List[string]
if (!$apiPolicy -or !$apiPolicy.Enabled) { $apiBlockers.Add("API routing is disabled") }
if (!$ProbeApi) { $apiBlockers.Add("API was not probed") }
elseif (!$api.available) { $apiBlockers.Add("API is unavailable") }
elseif (!$api.identityAligned) { $apiBlockers.Add("API and ADB device identities differ") }
if (!$versionAccepted) { $apiBlockers.Add("the installed Xiaowei version has no exact acceptance match") }
if (!$api.acceptedActions.Count) { $apiBlockers.Add("no ordinary action is accepted") }
if ($api.invalidAcceptedActions.Count) { $apiBlockers.Add("the accepted action list contains unknown actions") }
if ($api.blockedAcceptedActions.Count) { $apiBlockers.Add("the accepted action list contains privileged or opaque actions") }
if ($api.catalogOnlyAcceptedActions.Count) { $apiBlockers.Add("the accepted action list contains actions without an operator route") }
if ($api.nonAliasAcceptedActions.Count) { $apiBlockers.Add("the per-alias acceptance map contains non-target actions") }
if ($api.deviceBindingMismatches.Count) { $apiBlockers.Add("one or more accepted aliases are not bound to the currently mapped physical device") }
if ($api.unknownAcceptedAliases.Count) { $apiBlockers.Add("the acceptance map contains an unknown device alias") }
if ($api.legacyGlobalAcceptedActions.Count) { $apiBlockers.Add("the deprecated global AcceptedActions list is ignored") }
$api.blockers = @($apiBlockers | Select-Object -Unique)
if ($xiaoweiText -and $xiaoweiText.Enabled) {
    $textProfileAccepted = $true
    foreach ($aliasValue in @($xiaoweiText.ApprovedAliases)) {
        $acceptedForAlias = @($api.acceptedActionsByAlias[[string]$aliasValue])
        if (@("imeList", "selectIme", "inputText" | Where-Object { $acceptedForAlias -notcontains $_ }).Count) { $textProfileAccepted = $false }
    }
    if (!$ProbeApi) {
        $configurationBlockers.Add("enabled Xiaowei text input requires a live API identity probe")
    } elseif (!$api.available) {
        $configurationBlockers.Add("enabled Xiaowei text input requires an available Xiaowei API")
    }
    if (!$apiPolicy -or !$apiPolicy.Enabled -or !$versionAccepted -or !$textProfileAccepted -or $api.deviceBindingMismatches.Count) {
        $configurationBlockers.Add("enabled Xiaowei text input is outside its version/action acceptance gate")
    }
}
$configurationBlockers = @($configurationBlockers | Select-Object -Unique)

$result = [ordered]@{
    checkedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    transport = "capability-gateway"
    defaultExecutionChannel = "adb"
    verificationChannel = "adb-ui"
    windowsCapture = $windowsCapture
    software = $software
    api = $api
    readyForDeviceWork = !$configurationBlockers.Count
    blockers = $configurationBlockers
    onlineDeviceCount = $online.Count
    devices = @($devices)
}

$outputDir = Join-Path $projectRoot "data\matrix"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDir "preflight.json") -Encoding UTF8

Write-Host "Xiaowei matrix preflight: version $($software.version), online devices $($online.Count), routing $($result.transport)"
if ($ProbeApi) { Write-Host "API: $($api.reason)" }
if ($config.Xiaowei -and $config.Xiaowei.ContainsKey("PreferApi")) {
    Write-Warning "Xiaowei.PreferApi is deprecated and ignored. Configure Xiaowei.Api.AcceptedActionsByAlias per device capability."
}
if ($apiPolicy -and $apiPolicy.ContainsKey("AcceptedActions")) { Write-Warning "Xiaowei.Api.AcceptedActions is deprecated and ignored; acceptance must be per alias." }
if (!$windowsCapture.computerUseWindowScreenshotCompatible) {
    Write-Warning "Computer Use window screenshots require Windows build 20348 or newer. This host is build $($windowsCapture.windowsBuild); use ADB screenshots and UI hierarchy for phone content. For Xiaowei's visible desktop window, use .\xhs.cmd host capture only while that window is foreground and unobscured."
}
$publicDevices = @($devices | ForEach-Object {
    [ordered]@{ machine = $_.machine; name = $_.name; model = $_.model; android = $_.android }
})
$publicApi = [ordered]@{
    endpoint = $api.endpoint
    probed = $api.probed
    available = $api.available
    identityAligned = $api.identityAligned
    apiDeviceCount = $api.apiDeviceCount
    versionAccepted = $api.versionAccepted
    routingEnabled = $api.routingEnabled
    reason = $api.reason
    blockers = $api.blockers
}
[ordered]@{
    checkedAt = $result.checkedAt
    transport = $result.transport
    defaultExecutionChannel = $result.defaultExecutionChannel
    verificationChannel = $result.verificationChannel
    windowsCapture = $result.windowsCapture
    software = $result.software
    api = $publicApi
    readyForDeviceWork = $result.readyForDeviceWork
    blockers = $result.blockers
    onlineDeviceCount = $result.onlineDeviceCount
    devices = $publicDevices
}
if (!$result.readyForDeviceWork) { exit 2 }
