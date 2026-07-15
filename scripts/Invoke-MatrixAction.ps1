param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Inventory", "DumpUi", "Screenshot", "OpenXhs", "OpenProfile", "Home", "Back", "ListApps", "StartApp", "StopApp", "OpenSettings", "TapText", "Like", "Favorite", "Follow", "Comment", "Publish", "Delete", "ScreenOff", "ScreenOn", "PushFile", "InstallApk", "SetResolution", "SetDensity", "ResetDisplay")]
    [string]$Action,
    [string]$ConfigPath,
    [string[]]$Serials,
    [string[]]$MachineNumber,
    [string]$MachineNumbersCsv,
    [string]$MachineName,
    [string[]]$DeviceAlias,
    [string]$DeviceAliasesCsv,
    [string]$Group,
    [string]$Text,
    [string]$ExpectText,
    [string]$LocalPath,
    [string]$RemotePath = "/sdcard/Download/",
    [string]$Value,
    [string]$PackageName,
    [switch]$ConfirmAction,
    [string]$ConfirmationReason,
    [string]$RollbackInfo
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
$runRoot = Join-Path $projectRoot "data\matrix\runs\$((Get-Date).ToString('yyyyMMdd-HHmmss-fff'))-$([guid]::NewGuid().ToString('N').Substring(0,8))"
. (Join-Path $PSScriptRoot "Device-Lock.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")

function ConvertFrom-CodePoints {
    param([int[]]$CodePoints)
    -join @($CodePoints | ForEach-Object { [char]$_ })
}

function Test-ExternalInteractionLabel {
    param([string]$Label)
    if ([string]::IsNullOrWhiteSpace($Label)) { return $false }

    $normalizedSource = $Label.Normalize([System.Text.NormalizationForm]::FormKC) -replace '\p{Cf}', ''
    $normalizedSource = $normalizedSource -creplace '([a-z0-9])([A-Z])', '$1 $2'
    $normalized = $normalizedSource.Trim().ToLowerInvariant()
    $asciiTerms = @(
        "like", "liked", "likes", "heart", "thumb up", "thumbs up", "favorite", "favorites", "favorited", "favourite",
        "favourites", "favourited", "collect", "collected", "save", "saved", "bookmark",
        "bookmarked", "follow", "follows", "followed", "following", "comment", "comments",
        "reply", "replies", "replied", "send", "sending", "message", "messages",
        "messaging", "direct message", "dm", "share", "shared", "publish", "published",
        "post now", "delete", "deleted", "remove", "removed", "pay", "paid", "payment",
        "payments", "checkout", "buy", "purchase", "login", "log in", "sign in", "signin",
        "challenge", "verify", "verified", "verification", "captcha"
    )
    foreach ($term in $asciiTerms) {
        $escaped = [regex]::Escape($term)
        if ($normalized -match "(^|[^a-z0-9])$escaped([^a-z0-9]|$)") { return $true }
    }

    $unicodeTerms = @(
        (ConvertFrom-CodePoints @(36190)),
        (ConvertFrom-CodePoints @(28857, 36190)),
        (ConvertFrom-CodePoints @(24050, 28857, 36190)),
        (ConvertFrom-CodePoints @(21916, 27426)),
        (ConvertFrom-CodePoints @(25910, 34255)),
        (ConvertFrom-CodePoints @(20851, 27880)),
        (ConvertFrom-CodePoints @(35780, 35770)),
        (ConvertFrom-CodePoints @(22238, 22797)),
        (ConvertFrom-CodePoints @(21457, 36865)),
        (ConvertFrom-CodePoints @(31169, 20449)),
        (ConvertFrom-CodePoints @(31169, 32842)),
        (ConvertFrom-CodePoints @(20998, 20139)),
        (ConvertFrom-CodePoints @(36716, 21457)),
        (ConvertFrom-CodePoints @(21457, 24067)),
        (ConvertFrom-CodePoints @(21457, 24086)),
        (ConvertFrom-CodePoints @(21024, 38500)),
        (ConvertFrom-CodePoints @(25903, 20184)),
        (ConvertFrom-CodePoints @(20184, 27454)),
        (ConvertFrom-CodePoints @(36141, 20080)),
        (ConvertFrom-CodePoints @(19979, 21333)),
        (ConvertFrom-CodePoints @(30331, 24405)),
        (ConvertFrom-CodePoints @(30331, 38470)),
        (ConvertFrom-CodePoints @(39564, 35777)),
        (ConvertFrom-CodePoints @(39564, 35777, 30721)),
        (ConvertFrom-CodePoints @(35748, 35777)),
        (ConvertFrom-CodePoints @(23433, 20840, 39564, 35777)),
        (ConvertFrom-CodePoints @(39118, 38505, 39564, 35777))
    )
    $compactUnicode = $normalized -replace '[\s\p{P}\p{S}]', ''
    foreach ($term in $unicodeTerms) {
        if ($compactUnicode.Contains($term)) { return $true }
    }
    return $false
}

function Test-LocalSafeTapLabel {
    param([string]$Label)
    if ([string]::IsNullOrWhiteSpace($Label)) { return $false }
    $normalized = $Label.Normalize([System.Text.NormalizationForm]::FormKC).Trim().ToLowerInvariant()
    if ($normalized -in @("cancel", "close", "not now", "later", "back")) { return $true }
    $safeUnicode = @(
        (ConvertFrom-CodePoints @(21462, 28040)),
        (ConvertFrom-CodePoints @(20851, 38381)),
        (ConvertFrom-CodePoints @(31245, 21518)),
        (ConvertFrom-CodePoints @(20197, 21518)),
        (ConvertFrom-CodePoints @(36820, 22238))
    )
    $safeUnicode -contains $normalized
}

$readOnlyActions = @("OpenXhs", "OpenProfile", "Home", "Back", "DumpUi", "Screenshot", "Inventory", "ListApps", "StartApp")
$deviceLocalActions = @("StopApp", "OpenSettings", "TapText", "ScreenOff", "ScreenOn", "PushFile", "InstallApk", "SetResolution", "SetDensity", "ResetDisplay")
$legacyDirectInteractionActions = @("Like", "Favorite", "Follow", "Comment", "Publish", "Delete")
$actionRiskClass = if ($readOnlyActions -contains $Action) { "read_only_navigation" } elseif ($deviceLocalActions -contains $Action) { "device_local_change" } else { "external_interaction" }

if ($legacyDirectInteractionActions -contains $Action) {
    throw "Direct XHS interaction actions are retired from the legacy Matrix wrapper; use an implemented approved workflow through xhs.cmd"
}

if (![string]::IsNullOrWhiteSpace($DeviceAliasesCsv)) {
    if ($DeviceAlias) { throw "Use DeviceAlias or DeviceAliasesCsv, not both" }
    $parsedAliases = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() })
    if ($parsedAliases.Count -lt 2 -or $parsedAliases.Count -ne @($parsedAliases | Select-Object -Unique).Count -or @($parsedAliases | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]{1,64}$' }).Count) {
        throw "DeviceAliasesCsv requires two or more unique safe device aliases"
    }
    $DeviceAlias = $parsedAliases
}
if (![string]::IsNullOrWhiteSpace($MachineNumbersCsv)) {
    if ($MachineNumber) { throw "Use MachineNumber or MachineNumbersCsv, not both" }
    $parsedMachineNumbers = @($MachineNumbersCsv.Split(',') | ForEach-Object { $_.Trim() })
    if ($parsedMachineNumbers.Count -lt 2) {
        throw "MachineNumbersCsv requires two or more machine numbers"
    }
    $MachineNumber = $parsedMachineNumbers
}

if ($Action -eq "TapText" -and (Test-ExternalInteractionLabel $Text)) {
    $actionRiskClass = "external_interaction"
}
if ($actionRiskClass -eq "external_interaction") {
    throw "Action $Action cannot use a generic external-interaction path; use an implemented approved high-level workflow through xhs.cmd"
}
if ($Action -eq "TapText") {
    $explicitTapTargets = 0
    if ($Serials) { $explicitTapTargets += @($Serials).Count }
    if ($MachineNumber) { $explicitTapTargets += @($MachineNumber).Count }
    if ($MachineName) { $explicitTapTargets++ }
    if ($DeviceAlias) { $explicitTapTargets += @($DeviceAlias).Count }
    if ($Group -or $explicitTapTargets -ne 1) {
        throw "TapText is single-device only. Select exactly one device explicitly; groups and implicit all-device targeting are blocked."
    }
    if (!(Test-LocalSafeTapLabel $Text)) {
        throw "TapText is limited to a local-safe dismiss/navigation allowlist. Use a purpose-built semantic action for any other control."
    }
    if ([string]::IsNullOrWhiteSpace($ExpectText)) {
        throw "TapText requires -ExpectText so the target state can be verified without replay."
    }
}
if ($actionRiskClass -eq "device_local_change" -and (!$ConfirmAction -or ([string]$ConfirmationReason).Trim().Length -lt 3 -or ([string]$RollbackInfo).Trim().Length -lt 3)) {
    throw "Action $Action changes local device state. Pass -ConfirmAction, -ConfirmationReason, and -RollbackInfo after explicit user confirmation."
}

if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Config not found: $ConfigPath" }
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$machineDirectory = @(Get-MachineDirectory -Config $config)
$adb = $config.AdbPath
if (!$adb -or !(Test-Path -LiteralPath $adb)) { throw "Configured AdbPath does not exist" }
if (!$config.Devices -or !$config.Devices.Count) { throw "Device aliases are not configured" }
$configuredAliases = @($config.Devices.Values | ForEach-Object { [string]$_ })
if (@($configuredAliases | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $_ -eq "unmapped" }).Count -or
    @($configuredAliases | Select-Object -Unique).Count -ne $configuredAliases.Count -or
    @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq [string]$_ }).Count) {
    throw "Device aliases must be unique safe public values and must not equal raw ADB identifiers"
}

$online = @(
    & $adb devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)
if (!$online.Count) { throw "No online ADB devices found" }

function Protect-DeviceIdentifiers {
    param([string]$Value)
    $safe = [string]$Value
    foreach ($identifier in @($online | Where-Object { $_ })) {
        $safe = $safe -replace [regex]::Escape([string]$identifier), "[device-id]"
    }
    $safe
}

$selectionModes = 0
if ($Serials) { $selectionModes++ }
if ($MachineNumber) { $selectionModes++ }
if ($MachineName) { $selectionModes++ }
if ($DeviceAlias) { $selectionModes++ }
if ($Group) { $selectionModes++ }
if ($selectionModes -gt 1) { throw "Use only one machine selector or group" }
if ($Group) {
    if (!$config.Groups -or !$config.Groups.ContainsKey($Group)) { throw "Unknown group: $Group" }
    $targets = @($config.Groups[$Group])
} elseif ($MachineNumber) {
    $targets = @()
    $normalizedMachineNumbers = @()
    foreach ($requestedNumber in @($MachineNumber)) {
        $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber ([string]$requestedNumber)
        if ($normalizedMachineNumbers -contains $identity.Number) { throw "Machine numbers must be unique" }
        $normalizedMachineNumbers += $identity.Number
        $matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
        $targets += [string]$matchingSerials[0]
    }
} elseif ($MachineName) {
    $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineName $MachineName
    $matchingSerials = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
    $targets = @([string]$matchingSerials[0])
} elseif ($DeviceAlias) {
    if (!$config.Devices) { throw "Device aliases are not configured" }
    $targets = @()
    foreach ($alias in @($DeviceAlias | Select-Object -Unique)) {
        if ($alias -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "DeviceAlias is invalid" }
        $matches = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -eq [string]$alias })
        if ($matches.Count -ne 1) { throw "Each DeviceAlias must resolve to exactly one local device" }
        $targets += [string]$matches[0]
    }
} elseif ($Serials) {
    $targets = @($Serials)
} else {
    $targets = $online
}
$targets = @($targets | Where-Object { $online -contains $_ } | Select-Object -Unique)
if (!$targets.Count) { throw "None of the selected devices are online" }

$lockAliases = @()
foreach ($targetSerial in $targets) {
    if ($config.Devices -and $config.Devices.ContainsKey($targetSerial) -and [string]$config.Devices[$targetSerial] -match '^[A-Za-z0-9._-]{1,64}$') {
        $lockAliases += [string]$config.Devices[$targetSerial]
    } else {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $digest = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$targetSerial)))).Replace("-", "").ToLowerInvariant()
            $lockAliases += "unmapped-$($digest.Substring(0,16))"
        } finally { $sha.Dispose() }
    }
}
$deviceLockHandles = @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases $lockAliases)
try {

if ($Action -in @("StartApp", "StopApp")) {
    if ([string]::IsNullOrWhiteSpace($PackageName) -or $PackageName.Length -gt 255 -or $PackageName -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$') {
        throw "$Action requires a valid -PackageName"
    }
    $approvedPackages = @()
    if ($config.Xhs -and $config.Xhs.PackageName) { $approvedPackages += [string]$config.Xhs.PackageName }
    if ($config.Xiaowei -and $config.Xiaowei.ApprovedAppPackages) { $approvedPackages += @($config.Xiaowei.ApprovedAppPackages | ForEach-Object { [string]$_ }) }
    if (@($approvedPackages | Select-Object -Unique) -notcontains $PackageName) {
        throw "PackageName is not in the local ApprovedAppPackages allowlist"
    }
}

$xiaoweiApiPolicy = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
$xiaoweiAcceptedActionsByAlias = if ($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedActionsByAlias) { $xiaoweiApiPolicy.AcceptedActionsByAlias } else { $null }
$xiaoweiAcceptedDeviceSerialsByAlias = if ($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedDeviceSerialsByAlias) { $xiaoweiApiPolicy.AcceptedDeviceSerialsByAlias } else { $null }
$xiaoweiAcceptedOperatorActions = @("screen", "pushEvent", "apkList", "startApk", "stopApk", "imeList", "selectIme", "inputText")
$xiaoweiEndpoint = if ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { [string]$config.Xiaowei.ApiEndpoint } else { "ws://127.0.0.1:22222/" }
$xiaoweiVersion = $null
if ($config.Xiaowei -and $config.Xiaowei.Executable -and (Test-Path -LiteralPath $config.Xiaowei.Executable)) {
    $xiaoweiVersion = (Get-Item -LiteralPath $config.Xiaowei.Executable).VersionInfo.ProductVersion
}
$xiaoweiVersionAccepted = [bool]($xiaoweiApiPolicy -and $xiaoweiApiPolicy.AcceptedXiaoweiVersion -and $xiaoweiVersion -and ([string]$xiaoweiApiPolicy.AcceptedXiaoweiVersion -eq [string]$xiaoweiVersion))
$script:XiaoweiProbeAttempted = $false
$script:XiaoweiIdentityAligned = $false

function Test-XiaoweiIdentityAlignment {
    if ($script:XiaoweiProbeAttempted) { return $script:XiaoweiIdentityAligned }
    $script:XiaoweiProbeAttempted = $true
    $previousApiUrl = $env:XIAOWEI_API_URL
    $apiResultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-list-{0}.json" -f [guid]::NewGuid().ToString("N"))
    try {
        $env:XIAOWEI_API_URL = $xiaoweiEndpoint
        $processOutput = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") list --internal-gateway --result-file $apiResultPath 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { return $false }
        if (!(Test-Path -LiteralPath $apiResultPath -PathType Leaf)) { return $false }
        $raw = Get-Content -LiteralPath $apiResultPath -Raw -Encoding UTF8
        $body = $raw | ConvertFrom-Json
        if ($body.code -ne 10000 -or $body.data -isnot [array]) { return $false }
        $apiIds = @($body.data | ForEach-Object { if ($_.serial) { [string]$_.serial } elseif ($_.onlySerial) { [string]$_.onlySerial } } | Where-Object { $_ } | Select-Object -Unique)
        $missingFromApi = @($online | Where-Object { $apiIds -notcontains $_ })
        $missingFromAdb = @($apiIds | Where-Object { $online -notcontains $_ })
        $script:XiaoweiIdentityAligned = !$missingFromApi.Count -and !$missingFromAdb.Count
        return $script:XiaoweiIdentityAligned
    } catch {
        return $false
    } finally {
        $env:XIAOWEI_API_URL = $previousApiUrl
        Remove-Item -LiteralPath $apiResultPath -Force -ErrorAction SilentlyContinue
    }
}

function Test-XiaoweiCapability {
    param([string]$WireAction, [string]$DeviceAliasName, [string]$Serial)
    if (!$xiaoweiApiPolicy -or !$xiaoweiApiPolicy.Enabled -or !$xiaoweiVersionAccepted) { return $false }
    if ($xiaoweiApiPolicy.ContainsKey("AcceptedActions")) { return $false }
    if ($DeviceAliasName -notmatch '^[A-Za-z0-9._-]{1,64}$' -or !$xiaoweiAcceptedActionsByAlias -or !$xiaoweiAcceptedActionsByAlias.ContainsKey($DeviceAliasName)) { return $false }
    if (!$xiaoweiAcceptedDeviceSerialsByAlias -or !$xiaoweiAcceptedDeviceSerialsByAlias.ContainsKey($DeviceAliasName) -or [string]$xiaoweiAcceptedDeviceSerialsByAlias[$DeviceAliasName] -ne $Serial) { return $false }
    $acceptedForAlias = @($xiaoweiAcceptedActionsByAlias[$DeviceAliasName] | ForEach-Object { [string]$_ } | Select-Object -Unique)
    if (@($acceptedForAlias | Where-Object { $xiaoweiAcceptedOperatorActions -notcontains $_ }).Count) { return $false }
    if ($acceptedForAlias -notcontains $WireAction) { return $false }
    Test-XiaoweiIdentityAlignment
}

function Invoke-XiaoweiApi {
    param(
        [string]$WireAction,
        [string]$DeviceAliasName,
        [string]$Serial,
        $Data,
        $Authorization
    )
    if (!(Test-XiaoweiCapability $WireAction $DeviceAliasName $Serial)) {
        throw "Xiaowei capability grant failed the version, identity, alias, physical-binding, or per-action gate"
    }
    $gatewayKey = $null
    try { $gatewayKey = [Convert]::FromBase64String([string]$env:XHS_XIAOWEI_GATEWAY_KEY) } catch {}
    if (!$gatewayKey -or $gatewayKey.Length -ne 32) {
        throw "Xiaowei gateway session is unavailable; use the unified xhs.cmd entry"
    }
    $request = [ordered]@{ action = $WireAction; devices = $Serial }
    if ($null -ne $Data) { $request.data = $Data }
    $requestPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-request-{0}.json" -f [guid]::NewGuid().ToString("N"))
    $grantPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-grant-{0}.json" -f [guid]::NewGuid().ToString("N"))
    $resultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-result-{0}.json" -f [guid]::NewGuid().ToString("N"))
    try {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 10 -Compress), $encoding)
        $requestBytes = [System.IO.File]::ReadAllBytes($requestPath)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $requestSha256 = ([System.BitConverter]::ToString($sha.ComputeHash($requestBytes))).Replace("-", "").ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
        $issuedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $grantPayload = [ordered]@{
            action = $WireAction
            deviceAlias = $DeviceAliasName
            deviceSerial = $Serial
            xiaoweiVersion = $xiaoweiVersion
            endpoint = $xiaoweiEndpoint
            requestSha256 = $requestSha256
            issuedAt = $issuedAt
            expiresAt = $issuedAt + 30000
            authorization = if ($null -ne $Authorization) { $Authorization } else { [ordered]@{} }
        }
        $payloadJson = $grantPayload | ConvertTo-Json -Depth 10 -Compress
        $payloadBase64 = [Convert]::ToBase64String($encoding.GetBytes($payloadJson))
        $hmac = New-Object System.Security.Cryptography.HMACSHA256
        try {
            $hmac.Key = $gatewayKey
            $mac = ([System.BitConverter]::ToString($hmac.ComputeHash($encoding.GetBytes($payloadBase64)))).Replace("-", "").ToLowerInvariant()
        } finally {
            $hmac.Dispose()
        }
        $grantEnvelope = [ordered]@{ schemaVersion = 1; payload = $payloadBase64; mac = $mac }
        [System.IO.File]::WriteAllText($grantPath, ($grantEnvelope | ConvertTo-Json -Depth 5 -Compress), $encoding)
        $processOutput = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") invoke --internal-gateway --request-file $requestPath --grant-file $grantPath --result-file $resultPath 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            $errorBody = $null
            try { $errorBody = $processOutput | ConvertFrom-Json } catch {}
            $message = if ($errorBody -and $errorBody.error -and $errorBody.error.message) { [string]$errorBody.error.message } else { $processOutput.Trim() }
            if (!$message) { $message = "Xiaowei gateway exited without a structured result" }
            $exception = New-Object System.Exception($message)
            $provenPreSendFailure = [bool]($errorBody -and $errorBody.error -and
                [string]$errorBody.error.outcome -eq "failed" -and
                $errorBody.error.sent -is [bool] -and !$errorBody.error.sent)
            if ($provenPreSendFailure) {
                $exception.Data["Outcome"] = "failed"
                $exception.Data["Sent"] = $false
                $exception.Data["Action"] = [string]$WireAction
            } else {
                # Only a structured failed + sent=false envelope proves that
                # the request did not cross the WebSocket boundary.
                $exception.Data["Outcome"] = "unknown"
                $exception.Data["Sent"] = $true
                $exception.Data["Action"] = [string]$WireAction
            }
            throw $exception
        }
        if (!(Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            $exception = New-Object System.Exception("Xiaowei gateway returned no result artifact")
            $exception.Data["Outcome"] = "unknown"
            $exception.Data["Sent"] = $true
            $exception.Data["Action"] = [string]$WireAction
            throw $exception
        }
        try {
            $raw = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8
            $result = $raw | ConvertFrom-Json
        } catch {
            $exception = New-Object System.Exception("Xiaowei gateway result could not be parsed after the worker completed")
            $exception.Data["Outcome"] = "unknown"
            $exception.Data["Sent"] = $true
            $exception.Data["Action"] = [string]$WireAction
            throw $exception
        }
        if (!$result.ok -or $result.outcome -ne "accepted_unverified") {
            $exception = New-Object System.Exception("Xiaowei API did not return an accepted acknowledgement")
            $exception.Data["Outcome"] = "unknown"
            $exception.Data["Sent"] = $true
            $exception.Data["Action"] = [string]$WireAction
            throw $exception
        }
        $result
    } finally {
        if ($gatewayKey) { [Array]::Clear($gatewayKey, 0, $gatewayKey.Length) }
        Remove-Item -LiteralPath $requestPath, $grantPath, $resultPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Adb {
    param([string]$Serial, [string[]]$Arguments)
    $output = & $adb -s $Serial @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $output.Trim() }
    $output.Trim()
}

function Test-PackageProcessRunning {
    param([string]$Serial, [string]$Package)
    $output = & $adb -s $Serial shell pidof $Package 2>&1 | Out-String
    $exitCode = $LASTEXITCODE
    if ($exitCode -eq 0) { return ![string]::IsNullOrWhiteSpace($output) }
    if (![string]::IsNullOrWhiteSpace($output)) { throw $output.Trim() }
    $state = Invoke-Adb $Serial @("get-state")
    if ($state -ne "device") { throw "ADB device state was not verified after pidof returned no process" }
    return $false
}

function Test-XiaoweiUnknownOutcome {
    param($ErrorRecord)
    if (!$ErrorRecord) { return $false }
    $exception = if ($ErrorRecord.Exception) { $ErrorRecord.Exception } elseif ($ErrorRecord -is [System.Exception]) { $ErrorRecord } else { $null }
    $exception -and ([string]$exception.Data["Outcome"] -eq "unknown")
}

function Throw-XiaoweiVerificationFailure {
    param(
        $ApiError,
        [bool]$ApiAcknowledged,
        [string]$WireAction,
        $VerificationError
    )
    if ($ApiError) { throw $ApiError }
    if ($ApiAcknowledged) {
        $detail = if ($VerificationError -and $VerificationError.Exception) { [string]$VerificationError.Exception.Message } else { "postcondition was not verified" }
        $exception = New-Object System.Exception("Xiaowei $WireAction was accepted but independent verification was inconclusive: $detail")
        $exception.Data["Outcome"] = "unknown"
        $exception.Data["Sent"] = $true
        $exception.Data["Action"] = [string]$WireAction
        throw $exception
    }
    throw $VerificationError
}

function Get-DefaultHomePackage {
    param([string]$Serial)
    $raw = Invoke-Adb $Serial @("shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME")
    $matches = @([regex]::Matches($raw, '([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/') | ForEach-Object { $_.Groups[1].Value })
    if (!$matches.Count) { throw "Unable to resolve the default launcher package" }
    [string]$matches[-1]
}

function Save-AdbScreenshot {
    param([string]$Serial, [string]$LocalPath, [string]$RemoteName)
    Remove-Item -LiteralPath $LocalPath -Force -ErrorAction SilentlyContinue
    if ($Serial -notmatch '^[A-Za-z0-9._:-]+$') { throw "ADB screenshot rejected an invalid device identifier" }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $adb
    $startInfo.Arguments = "-s `"$Serial`" exec-out screencap -p"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $stream = $null
    try {
        if (!$process.Start()) { throw "ADB screenshot process did not start" }
        $errorTask = $process.StandardError.ReadToEndAsync()
        $stream = [System.IO.File]::Open($LocalPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $process.StandardOutput.BaseStream.CopyTo($stream)
        $stream.Dispose()
        $stream = $null
        $process.WaitForExit()
        $errorText = $errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw $errorText.Trim() }
        if (!(Test-Path -LiteralPath $LocalPath -PathType Leaf) -or (Get-Item -LiteralPath $LocalPath).Length -le 0) {
            throw "ADB screenshot postcondition failed"
        }
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($process) { $process.Dispose() }
    }
}

function Get-ImageDimensions {
    param([string]$Path)
    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($Path)
    try { [pscustomobject]@{ width = $image.Width; height = $image.Height } } finally { $image.Dispose() }
}

function Save-ImageAsPng {
    param([string]$SourcePath, [string]$DestinationPath)
    Add-Type -AssemblyName System.Drawing
    $image = [System.Drawing.Image]::FromFile($SourcePath)
    try {
        $image.Save($DestinationPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $image.Dispose()
    }
    if (!(Test-Path -LiteralPath $DestinationPath -PathType Leaf) -or (Get-Item -LiteralPath $DestinationPath).Length -le 0) {
        throw "Image normalization did not create a PNG artifact"
    }
}

function Get-ImageDifferenceScore {
    param([string]$FirstPath, [string]$SecondPath, [int]$SampleSize = 32)
    if ($SampleSize -lt 8 -or $SampleSize -gt 128) { throw "Image comparison sample size is out of range" }

    Add-Type -AssemblyName System.Drawing
    $firstImage = [System.Drawing.Image]::FromFile($FirstPath)
    $secondImage = [System.Drawing.Image]::FromFile($SecondPath)
    $firstBitmap = New-Object System.Drawing.Bitmap($SampleSize, $SampleSize, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $secondBitmap = New-Object System.Drawing.Bitmap($SampleSize, $SampleSize, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $firstGraphics = [System.Drawing.Graphics]::FromImage($firstBitmap)
    $secondGraphics = [System.Drawing.Graphics]::FromImage($secondBitmap)
    try {
        $firstGraphics.DrawImage($firstImage, 0, 0, $SampleSize, $SampleSize)
        $secondGraphics.DrawImage($secondImage, 0, 0, $SampleSize, $SampleSize)
        $difference = 0.0
        for ($y = 0; $y -lt $SampleSize; $y++) {
            for ($x = 0; $x -lt $SampleSize; $x++) {
                $first = $firstBitmap.GetPixel($x, $y)
                $second = $secondBitmap.GetPixel($x, $y)
                $difference += (
                    [Math]::Abs([int]$first.R - [int]$second.R) +
                    [Math]::Abs([int]$first.G - [int]$second.G) +
                    [Math]::Abs([int]$first.B - [int]$second.B)
                ) / (255.0 * 3.0)
            }
        }
        [Math]::Round($difference / ($SampleSize * $SampleSize), 6)
    } finally {
        $firstGraphics.Dispose()
        $secondGraphics.Dispose()
        $firstBitmap.Dispose()
        $secondBitmap.Dispose()
        $firstImage.Dispose()
        $secondImage.Dispose()
    }
}

function Get-ImageDirectorySnapshot {
    param([string]$Directory)
    $snapshot = @{}
    foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue | Where-Object Extension -in @(".png", ".jpg", ".jpeg"))) {
        $snapshot[$file.FullName] = "$($file.Length):$($file.LastWriteTimeUtc.Ticks)"
    }
    $snapshot
}

function Wait-XiaoweiScreenshotArtifact {
    param(
        [string]$Directory,
        [hashtable]$BeforeSnapshot,
        [DateTime]$NotBeforeUtc,
        [int]$TimeoutMilliseconds = 5000
    )
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        $candidates = @(
            Get-ChildItem -LiteralPath $Directory -File -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Extension -in @(".png", ".jpg", ".jpeg") -and
                    $_.LastWriteTimeUtc -ge $NotBeforeUtc.AddSeconds(-1) -and
                    (!$BeforeSnapshot.ContainsKey($_.FullName) -or $BeforeSnapshot[$_.FullName] -ne "$($_.Length):$($_.LastWriteTimeUtc.Ticks)")
                } |
                Sort-Object LastWriteTimeUtc -Descending
        )
        foreach ($candidate in $candidates) {
            try {
                if ($candidate.Length -le 0) { continue }
                $initialLength = $candidate.Length
                $initialWriteTicks = $candidate.LastWriteTimeUtc.Ticks
                $dimensions = Get-ImageDimensions $candidate.FullName
                if ($dimensions.width -le 0 -or $dimensions.height -le 0) { continue }
                Start-Sleep -Milliseconds 150
                $stable = Get-Item -LiteralPath $candidate.FullName -ErrorAction Stop
                if ($stable.Length -eq $initialLength -and $stable.LastWriteTimeUtc.Ticks -eq $initialWriteTicks) {
                    return $stable
                }
            } catch {
                # The vendor may still be writing the file. Continue waiting
                # without resending the screen request.
            }
        }
        Start-Sleep -Milliseconds 100
    }
    $null
}

function Save-Ui {
    param([string]$Serial, [string]$Path)
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    $directOutput = & $adb -s $Serial exec-out uiautomator dump /dev/tty 2>&1 | Out-String
    $start = $directOutput.IndexOf("<?xml", [System.StringComparison]::Ordinal)
    if ($start -lt 0) { $start = $directOutput.IndexOf("<hierarchy", [System.StringComparison]::Ordinal) }
    $closingTag = "</hierarchy>"
    $end = $directOutput.LastIndexOf($closingTag, [System.StringComparison]::Ordinal)
    if ($start -ge 0 -and $end -ge $start) {
        $xml = $directOutput.Substring($start, ($end - $start) + $closingTag.Length)
        [System.IO.File]::WriteAllText($Path, $xml, (New-Object System.Text.UTF8Encoding($false)))
        return Test-Path -LiteralPath $Path -PathType Leaf
    }

    # Older Android builds may not emit XML through /dev/tty. Fall back to a
    # device-local file only when the direct read produced no complete tree.
    $remote = "/sdcard/xhs_matrix_window.xml"
    try {
        Invoke-Adb $Serial @("shell", "rm", "-f", $remote) | Out-Null
        Invoke-Adb $Serial @("shell", "uiautomator", "dump", $remote) | Out-Null
        Invoke-Adb $Serial @("pull", $remote, $Path) | Out-Null
        Test-Path -LiteralPath $Path
    } finally {
        try { Invoke-Adb $Serial @("shell", "rm", "-f", $remote) | Out-Null } catch {}
    }
}

function Normalize-UiFingerprintText {
    param([string]$Value)
    if ($null -eq $Value) { return "" }
    $normalized = ($Value -replace '\s+', ' ').Trim()
    $normalized = $normalized -replace '(?i)\b(?:just now|today|yesterday|\d+\s*(?:sec(?:ond)?s?|min(?:ute)?s?|hours?|days?|weeks?|months?|years?)\s+ago)\b', '<relative-time>'
    $normalized = $normalized -replace '(?:\u521A\u521A|\u6628\u5929|\u524D\u5929|\u4ECA\u5929|\d+\s*(?:\u79D2|\u5206\u949F|\u5C0F\u65F6|\u5929|\u5468|\u6708|\u5E74)\u524D)', '<relative-time>'
    $normalized = $normalized -replace '(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)', '<clock>'
    $normalized = $normalized -replace '\d+(?:[.,]\d+)?', '<number>'
    $normalized
}

function Get-UiFingerprint {
    param([string]$XmlPath)
    if (!(Test-Path -LiteralPath $XmlPath -PathType Leaf)) { throw "UI hierarchy file was not created: $XmlPath" }

    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    $builder = New-Object System.Text.StringBuilder
    $attributeNames = @("class", "resource-id", "text", "content-desc", "clickable", "enabled", "checked", "selected", "scrollable")
    foreach ($node in $doc.SelectNodes("//node")) {
        foreach ($name in $attributeNames) {
            $value = ([string]$node.GetAttribute($name) -replace '\s+', ' ').Trim()
            if ($name -in @("text", "content-desc")) { $value = Normalize-UiFingerprintText $value }
            [void]$builder.Append($name).Append("=").Append($value).Append([char]31)
        }
        [void]$builder.Append([char]30)
    }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Wait-UiStable {
    param(
        [string]$Serial,
        [string]$DeviceDir,
        [string]$Prefix,
        [int]$TimeoutMilliseconds = 8000
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $previousFingerprint = $null
    $sample = 0
    while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        $sample++
        $path = Join-Path $DeviceDir "$Prefix-$sample.xml"
        if (!(Save-Ui $Serial $path)) { throw "Unable to save UI hierarchy while waiting for a stable page" }
        $fingerprint = Get-UiFingerprint $path
        if ($timer.ElapsedMilliseconds -ge $TimeoutMilliseconds) { break }
        if ($null -ne $previousFingerprint -and $fingerprint -eq $previousFingerprint) {
            return [pscustomobject]@{ path = $path; fingerprint = $fingerprint; samples = $sample }
        }
        $previousFingerprint = $fingerprint
        if (($timer.ElapsedMilliseconds + 500) -ge $TimeoutMilliseconds) { break }
        Start-Sleep -Milliseconds 500
    }
    throw "UI did not produce two identical normalized hierarchy fingerprints 500ms apart within 8 seconds"
}

function Get-TapPoint {
    param([string]$XmlPath, [string]$Label)
    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    $node = @($doc.SelectNodes("//node") | Where-Object { $_.text -eq $Label -or $_.'content-desc' -eq $Label } | Sort-Object { if ($_.'clickable' -eq 'true') { 0 } else { 1 } } | Select-Object -First 1)
    if (!$node.Count -or [string]$node[0].bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { return $null }
    [pscustomobject]@{ x = [math]::Round(([int]$matches[1] + [int]$matches[3]) / 2); y = [math]::Round(([int]$matches[2] + [int]$matches[4]) / 2) }
}

function Find-SemanticPoint {
    param([string]$Serial, [string]$Label, [string]$DeviceDir)
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $xml = Join-Path $DeviceDir "before-$attempt.xml"
        Save-Ui $Serial $xml | Out-Null
        $point = Get-TapPoint $xml $Label
        if ($point) { return $point }
        if ($attempt -eq 1) { Start-Sleep -Milliseconds 500 }
    }
    return $null
}

function Test-XmlText {
    param([string]$XmlPath, [string]$Label)
    if (!(Test-Path -LiteralPath $XmlPath)) { return $false }
    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    [bool]@($doc.SelectNodes("//node") | Where-Object {
        ([string]$_.text).IndexOf($Label, [System.StringComparison]::Ordinal) -ge 0 -or
        ([string]$_.'content-desc').IndexOf($Label, [System.StringComparison]::Ordinal) -ge 0
    } | Select-Object -First 1).Count
}

function Get-XhsSemanticMatch {
    param([string]$XmlPath, [string]$Target)
    if (!(Test-Path -LiteralPath $XmlPath -PathType Leaf)) { return $null }
    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    $nodes = @($doc.SelectNodes("//node"))
    $candidates = @($nodes | Where-Object {
        $id = ([string]$_.GetAttribute("resource-id")).ToLowerInvariant()
        $textValue = ([string]$_.GetAttribute("text")).Normalize([System.Text.NormalizationForm]::FormKC).Trim()
        $description = ([string]$_.GetAttribute("content-desc")).Normalize([System.Text.NormalizationForm]::FormKC).Trim()
        $className = [string]$_.GetAttribute("class")
        switch ($Target) {
            "Like" { return $id -match '(?:^|[/_])(like|liked|heart|praise)(?:$|[/_])' -or $textValue -match '^(?:\u70B9\u8D5E|\u5DF2\u70B9\u8D5E|\u53D6\u6D88\u70B9\u8D5E|Like|Liked)(?:\s*\d.*)?$' -or $description -match '^(?:\u70B9\u8D5E|\u5DF2\u70B9\u8D5E|\u53D6\u6D88\u70B9\u8D5E|Like|Liked)(?:\s*\d.*)?$' }
            "Favorite" { return $id -match '(?:^|[/_])(favorite|favourite|collect|bookmark|save)(?:$|[/_])' -or $textValue -match '^(?:\u6536\u85CF|\u5DF2\u6536\u85CF|\u53D6\u6D88\u6536\u85CF|Favorite|Favorited|Collect|Collected|Save|Saved)$' -or $description -match '^(?:\u6536\u85CF|\u5DF2\u6536\u85CF|\u53D6\u6D88\u6536\u85CF|Favorite|Favorited|Collect|Collected|Save|Saved)$' }
            "Follow" { return $id -match '(?:^|[/_])(follow|subscribe)(?:$|[/_])' -or $textValue -match '^(?:\u5173\u6CE8|\u5DF2\u5173\u6CE8|\u4E92\u76F8\u5173\u6CE8|Follow|Following)$' -or $description -match '^(?:\u5173\u6CE8|\u5DF2\u5173\u6CE8|\u4E92\u76F8\u5173\u6CE8|Follow|Following)$' }
            "CommentEntry" { return $id -match 'comment[_-]?(?:entry|count|button)' -or $textValue -match '^(?:\u8BC4\u8BBA|Comments?)(?:\s*\d.*)?$' -or $description -match '^(?:\u8BC4\u8BBA|\u67E5\u770B\u8BC4\u8BBA|Comments?)(?:\s*\d.*)?$' }
            "CommentEditor" { return $className -match '(?:^|\.)EditText$' -and ($id -match 'comment|reply|input|editor' -or $textValue -match '\u8BF4\u70B9\u4EC0\u4E48|\u5199\u8BC4\u8BBA|Add a comment' -or $description -match '\u8BF4\u70B9\u4EC0\u4E48|\u5199\u8BC4\u8BBA|Add a comment') }
            "CommentSend" { return $id -match 'comment[_-]?send|send[_-]?comment' -or $textValue -match '^(?:\u53D1\u9001|Send)$' -or $description -match '^(?:\u53D1\u9001|Send)$' }
            "CreateEntry" { return $id -match 'create[_-]?note|publish[_-]?entry|post[_-]?entry|bottom[_-]?plus' -or $textValue -match '^(?:\u53D1\u5E03|\u521B\u4F5C|Publish|Create)$' -or $description -match '^(?:\u53D1\u5E03|\u521B\u4F5C|Publish|Create)$' }
            "PublishEditor" { return $className -match '(?:^|\.)EditText$' -and ($id -match 'title|content|desc|caption|editor|input' -or $textValue -match '\u6807\u9898|\u6B63\u6587|\u63CF\u8FF0|\u8BF4\u70B9\u4EC0\u4E48|Title|Content|Caption' -or $description -match '\u6807\u9898|\u6B63\u6587|\u63CF\u8FF0|\u8BF4\u70B9\u4EC0\u4E48|Title|Content|Caption') }
            "PublishSubmit" { return $id -match 'publish[_-]?(?:submit|button)|post[_-]?submit|send[_-]?note' -or $textValue -match '^(?:\u53D1\u5E03|\u7ACB\u5373\u53D1\u5E03|Publish|Post)$' -or $description -match '^(?:\u53D1\u5E03|\u7ACB\u5373\u53D1\u5E03|Publish|Post)$' }
            "MoreMenu" { return $id -match '(?:^|[/_])(more|menu|overflow)(?:$|[/_])' -or $textValue -match '^(?:\u66F4\u591A|More)$' -or $description -match '^(?:\u66F4\u591A|More options|More)$' }
            "Delete" { return $id -match '(?:^|[/_])(delete|remove)(?:$|[/_])' -or $textValue -match '^(?:\u5220\u9664|Delete|Remove)$' -or $description -match '^(?:\u5220\u9664|Delete|Remove)$' }
            "DeleteConfirm" { return $id -match 'confirm[_-]?(?:delete|remove)|delete[_-]?confirm' -or $textValue -match '^(?:\u786E\u8BA4\u5220\u9664|\u5220\u9664|Delete|Confirm)$' -or $description -match '^(?:\u786E\u8BA4\u5220\u9664|\u5220\u9664|Delete|Confirm)$' }
            default { return $false }
        }
    })
    foreach ($candidate in $candidates) {
        $control = $candidate
        if ($Target -notin @("CommentEditor", "PublishEditor")) {
            for ($depth = 0; $depth -lt 4 -and $control -and $control.Name -eq "node"; $depth++) {
                if ($control.GetAttribute("clickable") -eq "true" -and $control.GetAttribute("enabled") -ne "false") { break }
                $control = $control.ParentNode
            }
        }
        if (!$control -or $control.Name -ne "node" -or [string]$control.GetAttribute("bounds") -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { continue }
        $left = [int]$matches[1]
        $top = [int]$matches[2]
        $right = [int]$matches[3]
        $bottom = [int]$matches[4]
        if ($right -le $left -or $bottom -le $top) { continue }
        $stateText = "$([string]$candidate.GetAttribute('text')) $([string]$candidate.GetAttribute('content-desc'))"
        return [pscustomobject]@{
            x = [math]::Floor(($left + $right) / 2)
            y = [math]::Floor(($top + $bottom) / 2)
            left = $left
            top = $top
            right = $right
            bottom = $bottom
            active = [bool]($candidate.GetAttribute("checked") -eq "true" -or $candidate.GetAttribute("selected") -eq "true" -or $stateText -match '\u5DF2\u70B9\u8D5E|\u53D6\u6D88\u70B9\u8D5E|Liked|\u5DF2\u6536\u85CF|\u53D6\u6D88\u6536\u85CF|Favorited|Collected|Saved|\u5DF2\u5173\u6CE8|\u4E92\u76F8\u5173\u6CE8|Following')
            focused = [bool]($candidate.GetAttribute("focused") -eq "true")
            text = [string]$candidate.GetAttribute("text")
            description = [string]$candidate.GetAttribute("content-desc")
            xmlPath = $XmlPath
        }
    }
    $null
}

function Find-XhsSemanticMatch {
    param([string]$Serial, [string]$Target, [string]$DeviceDir, [string]$Prefix = "semantic")
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $xml = Join-Path $DeviceDir "$Prefix-$attempt.xml"
        Save-Ui $Serial $xml | Out-Null
        $match = Get-XhsSemanticMatch $xml $Target
        if ($match) { return $match }
        if ($attempt -eq 1) { Start-Sleep -Milliseconds 500 }
    }
    $null
}

function Invoke-XhsSemanticTap {
    param([string]$Serial, $Match)
    if (!$Match) { throw "Required XHS semantic control was not found" }
    Invoke-Adb $Serial @("shell", "input", "tap", [string]$Match.x, [string]$Match.y) | Out-Null
}

function Test-XmlExactText {
    param([string]$XmlPath, [string]$ExpectedText)
    if (!(Test-Path -LiteralPath $XmlPath -PathType Leaf)) { return $false }
    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    [bool]@($doc.SelectNodes("//node") | Where-Object {
        ([string]$_.GetAttribute("text")).Normalize([System.Text.NormalizationForm]::FormKC).Trim() -ceq $ExpectedText.Normalize([System.Text.NormalizationForm]::FormKC).Trim() -or
        ([string]$_.GetAttribute("content-desc")).Normalize([System.Text.NormalizationForm]::FormKC).Trim() -ceq $ExpectedText.Normalize([System.Text.NormalizationForm]::FormKC).Trim()
    } | Select-Object -First 1).Count
}

function Wait-XhsDefaultIme {
    param([string]$Serial, [string]$ExpectedIme, [int]$TimeoutMilliseconds = 5000)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        $current = (Invoke-Adb $Serial @("shell", "settings", "get", "secure", "default_input_method")).Trim()
        if ($current -eq $ExpectedIme) { return $true }
        Start-Sleep -Milliseconds 200
    }
    $false
}

function Get-XhsExpectedTextHash {
    param([string]$Value)
    $normalized = $Value.Normalize([System.Text.NormalizationForm]::FormKC)
    $normalized = [regex]::Replace($normalized, '\s+', ' ').Trim()
    $han = '[\u2E80-\u2FFF\u3007\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]'
    $letterOrNumber = '[\p{L}\p{N}]'
    $normalized = [regex]::Replace($normalized, "($han)\s+(?=$letterOrNumber)", '$1')
    $normalized = [regex]::Replace($normalized, "($letterOrNumber)\s+(?=$han)", '$1')
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($normalized)) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha.Dispose()
    }
}

function Invoke-XhsApprovedTextInput {
    param([string]$Serial, [string]$DeviceAliasName, [string]$Value, [string]$DeviceDir, [string]$EditorTarget)
    $settings = if ($config.Xiaowei -and $config.Xiaowei.TextInput) { $config.Xiaowei.TextInput } else { $null }
    if (!$settings -or !$settings.Enabled -or !$settings.HumanApproved -or @($settings.ApprovedAliases) -notcontains $DeviceAliasName -or !$settings.PerDevice -or !$settings.PerDevice.ContainsKey($DeviceAliasName)) {
        throw "XHS text action requires an enabled per-device Xiaowei text-input profile"
    }
    foreach ($capability in @("imeList", "selectIme", "inputText")) {
        if (!(Test-XiaoweiCapability $capability $DeviceAliasName $Serial)) { throw "XHS text action requires accepted imeList/selectIme/inputText capabilities" }
    }
    $profile = $settings.PerDevice[$DeviceAliasName]
    $bridgeIme = [string]$profile.PreferredImeService
    if ($bridgeIme -notmatch '^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$') { throw "Configured Xiaowei bridge IME is invalid" }
    $priorIme = (Invoke-Adb $Serial @("shell", "settings", "get", "secure", "default_input_method")).Trim()
    if ($priorIme -notmatch '^[A-Za-z0-9._]+/[A-Za-z0-9._$]+$') { throw "Current default IME could not be verified" }

    $inventory = Invoke-XiaoweiApi "imeList" $DeviceAliasName $Serial $null ([ordered]@{ mode = "xhs_text_input" })
    $deviceProperty = $inventory.data.PSObject.Properties[$Serial]
    $installed = if ($deviceProperty) { @($deviceProperty.Value | ForEach-Object { [string]$_ }) } else { @() }
    if ($installed -notcontains $bridgeIme) { throw "Approved Xiaowei bridge IME is not installed on the selected device" }
    $enabledBefore = @((Invoke-Adb $Serial @("shell", "ime", "list", "-s")) -split '\r?\n' | ForEach-Object { $_.Trim() })
    $enabledTemporarily = $false
    $restored = $false
    try {
        if ($enabledBefore -notcontains $bridgeIme) {
            if (!$profile.AllowTemporaryEnable) { throw "Approved Xiaowei bridge IME is disabled and temporary enablement is not authorized" }
            Invoke-Adb $Serial @("shell", "ime", "enable", $bridgeIme) | Out-Null
            $enabledTemporarily = $true
        }
        Invoke-XiaoweiApi "selectIme" $DeviceAliasName $Serial ([ordered]@{ ime = $bridgeIme }) ([ordered]@{ mode = "xhs_text_input"; capability = "selectIme" }) | Out-Null
        if (!(Wait-XhsDefaultIme $Serial $bridgeIme)) { throw "Xiaowei bridge IME selection could not be verified" }

        $focusedPath = Join-Path $DeviceDir "text-focused.xml"
        Save-Ui $Serial $focusedPath | Out-Null
        $editor = Get-XhsSemanticMatch $focusedPath $EditorTarget
        if (!$editor -or !$editor.focused) { throw "XHS text editor focus could not be verified" }
        $deleteBackward = @("shell", "input", "keyevent", "KEYCODE_MOVE_END") + @(1..128 | ForEach-Object { "KEYCODE_DEL" })
        $deleteForward = @("shell", "input", "keyevent", "KEYCODE_MOVE_HOME") + @(1..128 | ForEach-Object { "KEYCODE_FORWARD_DEL" })
        Invoke-Adb $Serial $deleteBackward | Out-Null
        Invoke-Adb $Serial $deleteForward | Out-Null
        Invoke-XiaoweiApi "inputText" $DeviceAliasName $Serial ([ordered]@{ content = $Value }) ([ordered]@{ mode = "xhs_text_input"; capability = "inputText" }) | Out-Null
        Start-Sleep -Milliseconds 300

        $echoPath = Join-Path $DeviceDir "text-echo.xml"
        Save-Ui $Serial $echoPath | Out-Null
        $echoVerified = Test-XmlExactText $echoPath $Value
        if (!$echoVerified -and [string]$profile.EchoVerification -eq "local_ocr") {
            $echoEditor = Get-XhsSemanticMatch $echoPath $EditorTarget
            if ($echoEditor) {
                $imagePath = Join-Path $DeviceDir "text-echo.png"
                Save-AdbScreenshot $Serial $imagePath "xhs_interaction_text_echo.png"
                $ocrRaw = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "windows-ocr.ps1") -ImagePath $imagePath -CropX $echoEditor.left -CropY $echoEditor.top -CropWidth ($echoEditor.right - $echoEditor.left) -CropHeight ($echoEditor.bottom - $echoEditor.top) -ExpectedTextHash (Get-XhsExpectedTextHash $Value) 2>$null | Out-String
                try {
                    $ocr = $ocrRaw.Trim() | ConvertFrom-Json
                    $echoVerified = [bool]($ocr.exactTextMatch -eq $true -and $ocr.safeForCloud -eq $false)
                } catch { $echoVerified = $false }
            }
        }
        if (!$echoVerified) { throw "XHS text input was accepted but exact editor echo was not verified" }
        return $echoPath
    } finally {
        try {
            Invoke-XiaoweiApi "selectIme" $DeviceAliasName $Serial ([ordered]@{ ime = $priorIme }) ([ordered]@{ mode = "xhs_text_restore"; capability = "selectIme" }) | Out-Null
            if (!(Wait-XhsDefaultIme $Serial $priorIme)) { throw "Prior IME restoration could not be verified" }
            if ($enabledTemporarily) { Invoke-Adb $Serial @("shell", "ime", "disable", $bridgeIme) | Out-Null }
            $restored = $true
        } finally {
            if (!$restored) { throw "XHS text action stopped because the prior input method could not be restored" }
        }
    }
}

function Get-CurrentFocus {
    param([string]$Serial)
    $raw = Invoke-Adb $Serial @("shell", "dumpsys", "window", "windows")
    (@($raw -split '\r?\n' | Where-Object { $_ -match 'mCurrentFocus|mFocusedApp' }) -join " ").Trim()
}

function Assert-FocusedPackage {
    param([string]$Serial, [string]$PackageName, [string]$Description)
    $focus = Get-CurrentFocus $Serial
    if ($focus -notmatch [regex]::Escape($PackageName)) {
        throw "$Description verification failed; focused window was: $focus"
    }
}

function Test-ScreenState {
    param([string]$Serial, [bool]$ExpectedOn)
    $raw = Invoke-Adb $Serial @("shell", "dumpsys", "power")
    if ($ExpectedOn) {
        return ($raw -match 'mWakefulness=Awake' -or $raw -match 'Display Power: state=ON')
    }
    return ($raw -match 'mWakefulness=Asleep' -or $raw -match 'Display Power: state=OFF')
}

function Wait-ScreenState {
    param([string]$Serial, [bool]$ExpectedOn, [int]$TimeoutMilliseconds = 8000)
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (Test-ScreenState $Serial $ExpectedOn) { return }
        Start-Sleep -Milliseconds 200
    }
    $expected = if ($ExpectedOn) { "on" } else { "off" }
    throw "Screen state verification failed; expected $expected within 8 seconds"
}

function Get-ScreenSize {
    param([string]$Serial)
    $raw = Invoke-Adb $Serial @("shell", "wm", "size")
    if ($raw -notmatch '(\d+)x(\d+)') { throw "Unable to read screen size" }
    [pscustomobject]@{ width = [int]$matches[1]; height = [int]$matches[2] }
}

function Save-FailureDiagnostics {
    param([string]$Serial, [string]$DeviceDir)
    $hierarchyPath = $null
    $screenshotPath = $null

    try {
        $candidate = Join-Path $DeviceDir "failure.xml"
        if (Save-Ui $Serial $candidate) { $hierarchyPath = $candidate }
    } catch {
        $latest = Get-ChildItem -LiteralPath $DeviceDir -Filter "*.xml" -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($latest) { $hierarchyPath = $latest.FullName }
    }

    try {
        $candidate = Join-Path $DeviceDir "failure.png"
        Save-AdbScreenshot $Serial $candidate "xhs_matrix_failure.png"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $screenshotPath = $candidate }
    } catch {
    }

    [pscustomobject]@{ hierarchyPath = $hierarchyPath; screenshotPath = $screenshotPath }
}

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$deviceIndex = 0
$results = foreach ($serial in $targets) {
    $deviceIndex++
    $number = if ($config.Devices -and $config.Devices.ContainsKey($serial)) { $config.Devices[$serial] } else { "unmapped" }
    $machineIdentity = Get-MachineIdentityForAlias -Directory $machineDirectory -DeviceAlias ([string]$number)
    $safeDirectoryName = if ([string]$number -match '^[A-Za-z0-9._-]{1,64}$' -and $number -ne "unmapped") { [string]$number } else { "unmapped-$deviceIndex" }
    $deviceDir = Join-Path $runRoot $safeDirectoryName
    New-Item -ItemType Directory -Force -Path $deviceDir | Out-Null
    $entry = [ordered]@{ machine = $machineIdentity.Number; name = $machineIdentity.Name; action = $Action; riskClass = $actionRiskClass; transport = "adb"; executionChannel = "adb"; executionOutcome = "started"; verificationChannel = "adb-state"; verificationOutcome = "not_recorded"; status = "success"; detail = $null; model = $null; android = $null; apps = $null; apiPackageCount = $null; adbPackageCount = $null; missingFromApiCount = $null; missingFromAdbCount = $null; hierarchyPath = $null; screenshotPath = $null; apiScreenshotPath = $null; verificationBeforePath = $null; verificationPath = $null; imageDifference = $null }
    try {
        switch ($Action) {
            "Inventory" {
                $entry.model = Invoke-Adb $serial @("shell", "getprop", "ro.product.model")
                $entry.android = Invoke-Adb $serial @("shell", "getprop", "ro.build.version.release")
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "observed"
            }
            "DumpUi" {
                $path = Join-Path $deviceDir "window.xml"
                Save-Ui $serial $path | Out-Null
                $entry.detail = $path
                $entry.hierarchyPath = $path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_artifact"
            }
            "Screenshot" {
                $path = Join-Path $deviceDir "screen.png"
                $apiPath = Join-Path $deviceDir "screen-xiaowei.png"
                $apiTempPath = Join-Path $deviceDir "screen-xiaowei.tmp.png"
                $beforePath = Join-Path $deviceDir "screen-verify-before-adb.png"
                $afterPath = Join-Path $deviceDir "screen-verify-after-adb.png"
                foreach ($generatedPath in @($path, $apiPath, $apiTempPath, $beforePath, $afterPath)) {
                    Remove-Item -LiteralPath $generatedPath -Force -ErrorAction SilentlyContinue
                }

                if (!(Test-XiaoweiCapability "screen" $number $serial)) {
                    Save-AdbScreenshot $serial $path "xhs_matrix_screen.png"
                    $entry.executionChannel = "adb"
                    $entry.transport = "adb"
                    $entry.executionOutcome = "completed"
                    $entry.verificationChannel = "adb-artifact"
                    $entry.verificationOutcome = "verified"
                } else {
                    # A Xiaowei screen response is accepted as authoritative only when it
                    # visually matches at least one ADB capture bracketing the single API
                    # request. The request is never replayed while waiting for its file.
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    $entry.verificationChannel = "adb-temporal-image-correlation"
                    Save-AdbScreenshot $serial $beforePath "xhs_matrix_screen_verify_before.png"
                    $entry.verificationBeforePath = $beforePath
                    $beforeSnapshot = Get-ImageDirectorySnapshot $deviceDir
                    $notBeforeUtc = [DateTime]::UtcNow
                    $apiReadError = $null
                    $apiScreenshot = $false

                    try {
                        Invoke-XiaoweiApi "screen" $number $serial ([ordered]@{ savePath = $deviceDir }) ([ordered]@{ mode = "verified_read"; approvedSaveRoot = $runRoot }) | Out-Null
                        $candidate = Wait-XiaoweiScreenshotArtifact $deviceDir $beforeSnapshot $notBeforeUtc
                        if (!$candidate) {
                            $exception = New-Object System.Exception("Xiaowei accepted screen but no stable decodable image artifact appeared within 5 seconds")
                            $exception.Data["Outcome"] = "unknown"
                            $exception.Data["Sent"] = $true
                            throw $exception
                        }
                        Save-ImageAsPng $candidate.FullName $apiTempPath
                        Move-Item -LiteralPath $apiTempPath -Destination $apiPath -Force
                        $entry.apiScreenshotPath = $apiPath
                        $apiScreenshot = $true
                    } catch {
                        $apiReadError = $_
                    }

                    # Always retain a trusted ADB artifact for diagnosis, even when the
                    # Xiaowei attempt is inconclusive. This fallback is not reported as a
                    # successful Xiaowei canary.
                    Save-AdbScreenshot $serial $afterPath "xhs_matrix_screen_verify_after.png"
                    Copy-Item -LiteralPath $afterPath -Destination $path -Force
                    $entry.verificationPath = $afterPath

                    if ($apiScreenshot) {
                        try {
                            $apiDimensions = Get-ImageDimensions $apiPath
                            $beforeDimensions = Get-ImageDimensions $beforePath
                            $afterDimensions = Get-ImageDimensions $afterPath
                            $matchesBefore = $apiDimensions.width -eq $beforeDimensions.width -and $apiDimensions.height -eq $beforeDimensions.height
                            $matchesAfter = $apiDimensions.width -eq $afterDimensions.width -and $apiDimensions.height -eq $afterDimensions.height
                            if (!$matchesBefore -and !$matchesAfter) {
                                throw "Xiaowei screenshot dimensions match neither bracketing ADB capture"
                            }

                            $differenceScores = @()
                            if ($matchesBefore) { $differenceScores += Get-ImageDifferenceScore $apiPath $beforePath }
                            if ($matchesAfter) { $differenceScores += Get-ImageDifferenceScore $apiPath $afterPath }
                            $minimumDifference = [double](($differenceScores | Measure-Object -Minimum).Minimum)
                            $entry.imageDifference = $minimumDifference
                            if ($minimumDifference -gt 0.20) {
                                throw "Xiaowei screenshot did not visually correlate with either bracketing ADB capture"
                            }

                            Copy-Item -LiteralPath $apiPath -Destination $path -Force
                            $entry.transport = "xiaowei-api+adb-temporal-image-verify"
                            $entry.executionOutcome = "accepted_and_verified"
                            $entry.verificationOutcome = "verified_temporal_image_match"
                        } catch {
                            $exception = New-Object System.Exception("Xiaowei screen artifact verification was inconclusive: $($_.Exception.Message)")
                            $exception.Data["Outcome"] = "unknown"
                            $exception.Data["Sent"] = $true
                            $apiReadError = $exception
                        }
                    }

                    if ($apiReadError) {
                        $entry.status = if (Test-XiaoweiUnknownOutcome $apiReadError) { "unknown" } else { "failed" }
                        $entry.executionOutcome = if ($entry.status -eq "unknown") { "api_unknown_with_verified_adb_read" } else { "api_failed_with_verified_adb_read" }
                        $entry.transport = "xiaowei-api->adb-safe-read"
                        $entry.verificationOutcome = "api_inconclusive_adb_artifact_verified"
                        $apiMessage = if ($apiReadError.Exception) { $apiReadError.Exception.Message } else { $apiReadError.Message }
                        $entry.detail = "$(Protect-DeviceIdentifiers $apiMessage); trusted ADB screenshot retained at $path"
                    }
                }
                if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Screenshot postcondition failed; local file was not created" }
                if (!$entry.detail) { $entry.detail = $path }
                $entry.screenshotPath = $path
            }
            "OpenXhs" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "startApk" $number $serial) {
                    $authorization = [ordered]@{ mode = "verified_navigation"; singleDevice = $true; expectedPostcondition = "focused package matches the configured XHS package"; approvedPackage = $xhsPackage }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "startApk" $number $serial ([ordered]@{ apk = $xhsPackage }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "monkey", "-p", $xhsPackage, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    $stable = Wait-UiStable $serial $deviceDir "xhs-open"
                    Assert-FocusedPackage $serial $xhsPackage "OpenXhs"
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "startApk" $_
                }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-ui-verify" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
                $entry.detail = $stable.path
            }
            "OpenProfile" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "startApk" $number $serial) {
                    $authorization = [ordered]@{ mode = "verified_navigation"; singleDevice = $true; expectedPostcondition = "focused package matches the configured XHS package"; approvedPackage = $xhsPackage }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "startApk" $number $serial ([ordered]@{ apk = $xhsPackage }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "monkey", "-p", $xhsPackage, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    Wait-UiStable $serial $deviceDir "profile-entry" | Out-Null
                    Assert-FocusedPackage $serial $xhsPackage "OpenProfile precondition"
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "startApk" $_
                }
                if ($apiError) {
                    $entry.executionOutcome = "verified_after_unknown"
                    $apiError = $null
                }
                $profileLabel = -join @([char]25105)
                $point = Find-SemanticPoint $serial $profileLabel $deviceDir
                if (!$point) { throw "Profile navigation target was not found after two hierarchy reads; device stopped" }
                Invoke-Adb $serial @("shell", "input", "tap", "$($point.x)", "$($point.y)") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "profile-after"
                $after = $stable.path
                $publicIdLabel = -join @(23567, 32418, 20070, 21495 | ForEach-Object { [char]$_ })
                $followerLabel = -join @(31881, 19997 | ForEach-Object { [char]$_ })
                $followingLabel = -join @(20851, 27880 | ForEach-Object { [char]$_ })
                $engagementLabel = -join @(33719, 36190, 19982, 25910, 34255 | ForEach-Object { [char]$_ })
                $hasId = Test-XmlText $after $publicIdLabel
                $hasMetric = (Test-XmlText $after $followerLabel) -or (Test-XmlText $after $followingLabel) -or (Test-XmlText $after $engagementLabel)
                if (!$hasId -or !$hasMetric) { throw "Profile verification failed: public ID and profile metrics were not both present; device stopped" }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-semantic-navigation" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
                $entry.detail = $after
            }
            "Home" {
                $before = Wait-UiStable $serial $deviceDir "home-before"
                $launcherPackage = Get-DefaultHomePackage $serial
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "pushEvent" $number $serial) {
                    $authorization = [ordered]@{ mode = "verified_navigation"; singleDevice = $true; expectedPostcondition = "the launcher is focused after HOME" }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "pushEvent" $number $serial ([ordered]@{ type = "2" }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "input", "keyevent", "3") | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    $stable = Wait-UiStable $serial $deviceDir "home-after"
                    $focus = Get-CurrentFocus $serial
                    if ($focus -notmatch [regex]::Escape($launcherPackage)) {
                        throw "Home verification failed; the resolved launcher is not focused"
                    }
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "pushEvent" $_
                }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-launcher-verify" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
                $entry.detail = $stable.path
            }
            "Back" {
                $before = Wait-UiStable $serial $deviceDir "back-before"
                $beforeFocus = Get-CurrentFocus $serial
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "pushEvent" $number $serial) {
                    $authorization = [ordered]@{ mode = "verified_navigation"; singleDevice = $true; expectedPostcondition = "the focused window or normalized UI state changes after BACK" }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "pushEvent" $number $serial ([ordered]@{ type = "3" }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "input", "keyevent", "4") | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    $stable = Wait-UiStable $serial $deviceDir "back-after"
                    $afterFocus = Get-CurrentFocus $serial
                    if ($stable.fingerprint -eq $before.fingerprint -and $afterFocus -eq $beforeFocus) {
                        throw "Back verification failed; neither the focused window nor normalized UI state changed"
                    }
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "pushEvent" $_
                }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-state-change-verify" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
                $entry.detail = $stable.path
            }
            "ListApps" {
                $apiApps = @()
                $apiReadError = $null
                if (Test-XiaoweiCapability "apkList" $number $serial) {
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        $apiResult = Invoke-XiaoweiApi "apkList" $number $serial $null ([ordered]@{})
                        $deviceProperty = $apiResult.data.PSObject.Properties[$serial]
                        $deviceApps = if ($deviceProperty) { $deviceProperty.Value } else { @() }
                        $apiApps = @($deviceApps | ForEach-Object { if ($_ -is [string]) { [string]$_ } elseif ($_.packageName) { [string]$_.packageName } elseif ($_.apk) { [string]$_.apk } } | Where-Object { $_ -match '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$' } | Sort-Object -Unique)
                        $entry.apiPackageCount = $apiApps.Count
                        if ($apiApps.Count) {
                            $entry.executionOutcome = "accepted_unverified"
                        } else {
                            $apiReadError = New-Object System.Exception("Xiaowei accepted apkList but returned no valid package inventory")
                            $apiReadError.Data["Outcome"] = "unknown"
                            $apiReadError.Data["Sent"] = $true
                        }
                    } catch { $apiReadError = $_ }
                }
                $rawApps = Invoke-Adb $serial @("shell", "pm", "list", "packages")
                $apps = @($rawApps -split '\r?\n' | ForEach-Object { ($_ -replace '^package:', '').Trim() } | Where-Object { $_ -match '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$' } | Sort-Object -Unique)
                if (!$apps.Count) { throw "ADB package inventory was empty" }
                $entry.adbPackageCount = $apps.Count
                if ($apiApps.Count) {
                    $missingFromApi = @($apps | Where-Object { $apiApps -notcontains $_ })
                    $missingFromAdb = @($apiApps | Where-Object { $apps -notcontains $_ })
                    $entry.missingFromApiCount = $missingFromApi.Count
                    $entry.missingFromAdbCount = $missingFromAdb.Count
                    if (!$missingFromApi.Count -and !$missingFromAdb.Count) {
                        $entry.transport = "xiaowei-api+adb-package-verify"
                        $entry.verificationOutcome = "verified"
                    } else {
                        $entry.transport = "xiaowei-api->adb-read-fallback"
                        $entry.executionOutcome = "api_data_mismatch_then_safe_read_fallback"
                        $entry.verificationOutcome = "verified_from_adb"
                    }
                } else {
                    $entry.executionChannel = "adb"
                    $entry.transport = if ($apiReadError) { "xiaowei-api->adb-read-fallback" } else { "adb" }
                    $entry.executionOutcome = if ($apiReadError) { if (Test-XiaoweiUnknownOutcome $apiReadError) { "api_unknown_then_safe_read_fallback" } else { "api_failed_then_safe_read_fallback" } } else { "completed" }
                    $entry.verificationOutcome = "verified_from_adb"
                }
                $entry.apps = $apps
                $entry.detail = "$($apps.Count) installed packages"
            }
            "StartApp" {
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "startApk" $number $serial) {
                    $authorization = [ordered]@{ mode = "verified_navigation"; singleDevice = $true; expectedPostcondition = "focused package matches the approved package"; approvedPackage = $PackageName }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "startApk" $number $serial ([ordered]@{ apk = $PackageName }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "monkey", "-p", $PackageName, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    $stable = Wait-UiStable $serial $deviceDir "app-start-after"
                    Assert-FocusedPackage $serial $PackageName "StartApp"
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "startApk" $_
                }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-ui-verify" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
                $entry.detail = $stable.path
            }
            "StopApp" {
                $apiError = $null
                $apiAcknowledged = $false
                if (Test-XiaoweiCapability "stopApk" $number $serial) {
                    $authorization = [ordered]@{ mode = "session_confirmation"; confirmed = $true; reason = $ConfirmationReason; rollback = $RollbackInfo; approvedPackage = $PackageName }
                    $entry.executionChannel = "xiaowei-api"
                    $entry.transport = "xiaowei-api-attempted"
                    try {
                        Invoke-XiaoweiApi "stopApk" $number $serial ([ordered]@{ apk = $PackageName }) $authorization | Out-Null
                        $apiAcknowledged = $true
                        $entry.executionOutcome = "accepted_unverified"
                    } catch {
                        if (!(Test-XiaoweiUnknownOutcome $_)) { throw }
                        $apiError = $_
                        $entry.executionOutcome = "unknown_after_send"
                    }
                } else {
                    Invoke-Adb $serial @("shell", "am", "force-stop", $PackageName) | Out-Null
                    $entry.executionOutcome = "completed"
                }
                try {
                    Start-Sleep -Milliseconds 300
                    $focus = Get-CurrentFocus $serial
                    $isRunning = Test-PackageProcessRunning $serial $PackageName
                    if ($focus -match [regex]::Escape($PackageName) -or $isRunning) {
                        throw "StopApp verification failed; the package is still focused or running"
                    }
                } catch {
                    Throw-XiaoweiVerificationFailure $apiError $apiAcknowledged "stopApk" $_
                }
                $entry.transport = if ($entry.executionChannel -eq "xiaowei-api") { "xiaowei-api+adb-state-verify" } else { "adb" }
                $entry.executionOutcome = if ($apiError) { "verified_after_unknown" } else { $entry.executionOutcome }
                $entry.verificationOutcome = "verified"
            }
            "OpenSettings" {
                Invoke-Adb $serial @("shell", "am", "start", "-a", "android.settings.SETTINGS") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "settings-after"
                Assert-FocusedPackage $serial "com.android.settings" "OpenSettings"
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "TapText" {
                if ([string]::IsNullOrWhiteSpace($Text)) { throw "TapText requires -Text" }
                $point = Find-SemanticPoint $serial $Text $deviceDir
                if (!$point) { throw "Control '$Text' was not found after two hierarchy reads; device stopped" }
                Invoke-Adb $serial @("shell", "input", "tap", "$($point.x)", "$($point.y)") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "tap-after"
                $entry.detail = $stable.path
                if ($ExpectText) {
                    $after = $stable.path
                    if (!(Test-XmlText $after $ExpectText)) { throw "Action ran once but expected text '$ExpectText' was not verified; the tap will not be replayed" }
                }
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "Like" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Like"
                $like = Find-XhsSemanticMatch $serial "Like" $deviceDir "like-before"
                if (!$like) { throw "Like control was not found on the current XHS page" }
                if ($like.active) {
                    $entry.detail = "already_active"
                    $entry.executionOutcome = "idempotent_noop"
                    $entry.verificationOutcome = "verified"
                    break
                }
                Invoke-XhsSemanticTap $serial $like
                $stable = Wait-UiStable $serial $deviceDir "like-after"
                $after = Get-XhsSemanticMatch $stable.path "Like"
                if (!$after -or !$after.active) { throw "Like ran once but the active state was not verified" }
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_active"
            }
            "Favorite" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Favorite"
                $favorite = Find-XhsSemanticMatch $serial "Favorite" $deviceDir "favorite-before"
                if (!$favorite) { throw "Favorite control was not found on the current XHS page" }
                if ($favorite.active) {
                    $entry.detail = "already_active"
                    $entry.executionOutcome = "idempotent_noop"
                    $entry.verificationOutcome = "verified"
                    break
                }
                Invoke-XhsSemanticTap $serial $favorite
                $stable = Wait-UiStable $serial $deviceDir "favorite-after"
                $after = Get-XhsSemanticMatch $stable.path "Favorite"
                if (!$after -or !$after.active) { throw "Favorite ran once but the active state was not verified" }
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_active"
            }
            "Follow" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Follow"
                $follow = Find-XhsSemanticMatch $serial "Follow" $deviceDir "follow-before"
                if (!$follow) { throw "Follow control was not found on the current XHS page" }
                if ($follow.active) {
                    $entry.detail = "already_active"
                    $entry.executionOutcome = "idempotent_noop"
                    $entry.verificationOutcome = "verified"
                    break
                }
                Invoke-XhsSemanticTap $serial $follow
                $stable = Wait-UiStable $serial $deviceDir "follow-after"
                $after = Get-XhsSemanticMatch $stable.path "Follow"
                if ((!$after -or !$after.active) -and !(Test-XmlText $stable.path (ConvertFrom-CodePoints @(24050, 20851, 27880))) -and !(Test-XmlText $stable.path "Following")) {
                    throw "Follow ran once but the active state was not verified"
                }
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_active"
            }
            "Comment" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Comment"
                $editor = Find-XhsSemanticMatch $serial "CommentEditor" $deviceDir "comment-editor"
                if (!$editor) {
                    $entryPoint = Find-XhsSemanticMatch $serial "CommentEntry" $deviceDir "comment-entry"
                    if (!$entryPoint) { throw "Comment entry was not found on the current XHS note" }
                    Invoke-XhsSemanticTap $serial $entryPoint
                    Wait-UiStable $serial $deviceDir "comment-panel" | Out-Null
                    $editor = Find-XhsSemanticMatch $serial "CommentEditor" $deviceDir "comment-editor-open"
                }
                if (!$editor) { throw "Comment editor was not found after opening comments" }
                Invoke-XhsSemanticTap $serial $editor
                Start-Sleep -Milliseconds 300
                $echoPath = Invoke-XhsApprovedTextInput $serial $number $Text $deviceDir "CommentEditor"
                $send = Find-XhsSemanticMatch $serial "CommentSend" $deviceDir "comment-send"
                if (!$send) { throw "Comment send control was not found after exact text entry" }
                Invoke-XhsSemanticTap $serial $send
                $stable = Wait-UiStable $serial $deviceDir "comment-after"
                if (!(Test-XmlExactText $stable.path $Text)) { throw "Comment was sent once but its exact public echo was not verified" }
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_public_echo"
            }
            "Publish" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Publish"
                $editor = Find-XhsSemanticMatch $serial "PublishEditor" $deviceDir "publish-editor"
                if (!$editor) {
                    $create = Find-XhsSemanticMatch $serial "CreateEntry" $deviceDir "publish-entry"
                    if (!$create) { throw "Publish entry or composer was not found on the current XHS page" }
                    Invoke-XhsSemanticTap $serial $create
                    Wait-UiStable $serial $deviceDir "publish-composer" | Out-Null
                    $editor = Find-XhsSemanticMatch $serial "PublishEditor" $deviceDir "publish-editor-open"
                }
                if (!$editor) { throw "Publish composer text editor was not found" }
                Invoke-XhsSemanticTap $serial $editor
                Start-Sleep -Milliseconds 300
                $beforeFingerprint = Get-UiFingerprint $editor.xmlPath
                Invoke-XhsApprovedTextInput $serial $number $Text $deviceDir "PublishEditor" | Out-Null
                $submit = Find-XhsSemanticMatch $serial "PublishSubmit" $deviceDir "publish-submit"
                if (!$submit) { throw "Publish submit control was not found after exact text entry" }
                Invoke-XhsSemanticTap $serial $submit
                $stable = Wait-UiStable $serial $deviceDir "publish-after"
                Assert-FocusedPackage $serial $xhsPackage "Publish"
                if ($stable.fingerprint -eq $beforeFingerprint) { throw "Publish ran once but the composer did not transition" }
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_transition"
            }
            "Delete" {
                $xhsPackage = if ($config.Xhs -and $config.Xhs.PackageName) { [string]$config.Xhs.PackageName } else { "com.xingin.xhs" }
                Assert-FocusedPackage $serial $xhsPackage "Delete"
                $before = Wait-UiStable $serial $deviceDir "delete-before"
                $delete = Get-XhsSemanticMatch $before.path "Delete"
                if (!$delete) {
                    $more = Get-XhsSemanticMatch $before.path "MoreMenu"
                    if (!$more) { throw "Delete control and more menu were not found on the current XHS page" }
                    Invoke-XhsSemanticTap $serial $more
                    $menu = Wait-UiStable $serial $deviceDir "delete-menu"
                    $delete = Get-XhsSemanticMatch $menu.path "Delete"
                }
                if (!$delete) { throw "Delete control was not found after opening the item menu" }
                Invoke-XhsSemanticTap $serial $delete
                $confirmationPage = Wait-UiStable $serial $deviceDir "delete-confirm"
                $confirm = Get-XhsSemanticMatch $confirmationPage.path "DeleteConfirm"
                if ($confirm) {
                    Invoke-XhsSemanticTap $serial $confirm
                    $after = Wait-UiStable $serial $deviceDir "delete-after"
                } else {
                    $after = $confirmationPage
                }
                if ($after.fingerprint -eq $before.fingerprint -or (Test-XmlText $after.path (ConvertFrom-CodePoints @(30830, 35748, 21024, 38500)))) {
                    throw "Delete ran once but completion was not verified"
                }
                $entry.detail = $after.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified_removed"
            }
            "ScreenOff" {
                Invoke-Adb $serial @("shell", "input", "keyevent", "223") | Out-Null
                Wait-ScreenState $serial $false
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "ScreenOn" {
                Invoke-Adb $serial @("shell", "input", "keyevent", "224") | Out-Null
                Wait-ScreenState $serial $true
                $stable = Wait-UiStable $serial $deviceDir "screen-on-after"
                $entry.detail = $stable.path
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "PushFile" {
                if (!$LocalPath -or !(Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "PushFile requires an existing -LocalPath" }
                Invoke-Adb $serial @("push", $LocalPath, $RemotePath) | Out-Null
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "command_acknowledged_only"
            }
            "InstallApk" {
                if (!$LocalPath -or !(Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "InstallApk requires an existing -LocalPath" }
                Invoke-Adb $serial @("install", "-r", $LocalPath) | Out-Null
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "command_acknowledged_only"
            }
            "SetResolution" {
                if ($Value -notmatch '^\d+x\d+$') { throw "SetResolution -Value must look like 1080x2400" }
                Invoke-Adb $serial @("shell", "wm", "size", $Value) | Out-Null
                $actual = Invoke-Adb $serial @("shell", "wm", "size")
                if ($actual -notmatch [regex]::Escape($Value)) { throw "Resolution postcondition failed; expected $Value but read: $actual" }
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "SetDensity" {
                if ($Value -notmatch '^\d+$') { throw "SetDensity -Value must be an integer" }
                Invoke-Adb $serial @("shell", "wm", "density", $Value) | Out-Null
                $actual = Invoke-Adb $serial @("shell", "wm", "density")
                if ($actual -notmatch "(?:Override density:\s*)?$([regex]::Escape($Value))(?:\s|$)") { throw "Density postcondition failed; expected $Value but read: $actual" }
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
            "ResetDisplay" {
                Invoke-Adb $serial @("shell", "wm", "size", "reset") | Out-Null
                Invoke-Adb $serial @("shell", "wm", "density", "reset") | Out-Null
                $actualSize = Invoke-Adb $serial @("shell", "wm", "size")
                $actualDensity = Invoke-Adb $serial @("shell", "wm", "density")
                if ($actualSize -match 'Override size:' -or $actualDensity -match 'Override density:') { throw "ResetDisplay postcondition failed; an override remains active" }
                $entry.executionOutcome = "completed"
                $entry.verificationOutcome = "verified"
            }
        }
    } catch {
        $entry.status = if (Test-XiaoweiUnknownOutcome $_) { "unknown" } else { "failed" }
        $entry.executionOutcome = if ($entry.status -eq "unknown") { "unknown_after_send" } else { "failed" }
        $entry.verificationOutcome = if ($entry.status -eq "unknown") { "inconclusive" } else { "failed" }
        $entry.detail = Protect-DeviceIdentifiers $_.Exception.Message
        $diagnostics = Save-FailureDiagnostics $serial $deviceDir
        $entry.hierarchyPath = $diagnostics.hierarchyPath
        $entry.screenshotPath = $diagnostics.screenshotPath
    }
    [pscustomobject]$entry
}

$results = @($results | Sort-Object machine)
$summary = [ordered]@{
    executedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    action = $Action
    riskClass = $actionRiskClass
    confirmationReason = if ($ConfirmAction) { $ConfirmationReason } else { $null }
    rollbackInfo = if ($ConfirmAction) { $RollbackInfo } else { $null }
    success = @($results | Where-Object status -eq "success").Count
    failed = @($results | Where-Object status -eq "failed").Count
    unknown = @($results | Where-Object status -eq "unknown").Count
    results = @($results)
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRoot "result.json") -Encoding UTF8
if ($Action -eq "Inventory") {
    $results | Format-Table machine,name,status,model,android -AutoSize
} else {
    $results | Format-Table machine,name,action,status,detail -AutoSize
}
$matrixExitCode = if ($summary.failed -or $summary.unknown) { 2 } else { 0 }
} finally {
    Exit-DeviceLocks -Handles $deviceLockHandles
}
if ($matrixExitCode) { exit $matrixExitCode }
