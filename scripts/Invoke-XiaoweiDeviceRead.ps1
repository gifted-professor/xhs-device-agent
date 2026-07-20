#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("List", "Size", "AppList", "Ui", "Screen", "OpenApp", "Home", "Recent", "Back", "TapText", "TapCoords", "TapOcr", "Input", "NodeResolve", "NodeActivate", "Scroll", "WeChatWalletBalance", "XhsObserve", "XhsFindVideo", "XhsOpenVisible", "XhsCommentOpen", "XhsCommentInput", "XhsCommentReplyInput", "XhsCommentSend", "XhsCommentEmoji", "XhsDmSend")]
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
    [ValidateSet("exact", "suffix")]
    [string]$TextMatch,
    [string]$ExpectText,
    [string]$ExpectPackage,
    [string]$ExpectResourceId,
    [string]$SelectorBase64,
    [int]$Ordinal,
    [double]$X,
    [double]$Y,
    [string]$Direction,
    [int]$Steps,
    [int]$MaxScrolls,
    [int]$MaxDurationMs,
    [string]$Emoji,
    [string]$ExpectedDraft,
    [int]$ExpectedBeforeCount,
    [string]$ExpectedTargetBase64,
    [string]$ExpectedEditorStateHash,
    [string]$ExpectedEmptyEditorStateHash,
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

if ($Action -in @("OpenApp", "TapCoords", "TapOcr", "Input", "NodeResolve", "NodeActivate")) {
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
} elseif ($Action -in @("Scroll", "TapText")) {
    if (![string]::IsNullOrWhiteSpace($PackageName) -and
        ($PackageName.Length -gt 255 -or $PackageName -notmatch '^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$')) {
        throw "$Action PackageName is invalid"
    }
} elseif (![string]::IsNullOrWhiteSpace($PackageName)) {
    throw "PackageName is accepted only for OpenApp, TapText, TapCoords, TapOcr, Input, NodeResolve, NodeActivate, or Scroll"
}

if ($Action -in @("Input", "XhsCommentInput", "XhsCommentReplyInput")) {
    if ([string]::IsNullOrWhiteSpace($Text) -or $Text.Length -gt 256 -or $Text -match '[\x00\r\n]' -or
        ![string]::IsNullOrWhiteSpace($ExpectText) -or ![string]::IsNullOrWhiteSpace($ExpectPackage) -or
        ![string]::IsNullOrWhiteSpace($ExpectResourceId) -or ![string]::IsNullOrWhiteSpace($ExpectedDraft) -or
        ($Action -eq "XhsCommentInput" -and $ExpectedEditorStateHash -notmatch '^[a-f0-9]{64}$') -or
        ($Action -eq "XhsCommentReplyInput" -and (![string]::IsNullOrWhiteSpace($ExpectedEditorStateHash) -or
            !$PSBoundParameters.ContainsKey("Ordinal") -or $Ordinal -lt 1 -or $Ordinal -gt 50)) -or
        ($Action -eq "Input" -and ![string]::IsNullOrWhiteSpace($ExpectedEditorStateHash)) -or $ConfirmAction) {
        throw "$Action requires one bounded single-line Text value"
    }
} elseif ($Action -eq "XhsCommentSend") {
    if ([string]::IsNullOrWhiteSpace($ExpectedDraft) -or $ExpectedDraft.Length -gt 256 -or $ExpectedDraft -match '[\x00\r\n]' -or
        !$PSBoundParameters.ContainsKey("ExpectedBeforeCount") -or $ExpectedBeforeCount -lt 0 -or $ExpectedBeforeCount -gt 999999999 -or
        [string]::IsNullOrWhiteSpace($ExpectedTargetBase64) -or $ExpectedTargetBase64.Length -gt 4096 -or
        $ExpectedEmptyEditorStateHash -notmatch '^[a-f0-9]{64}$' -or ![string]::IsNullOrWhiteSpace($ExpectedEditorStateHash) -or
        ![string]::IsNullOrWhiteSpace($Text) -or ![string]::IsNullOrWhiteSpace($ExpectText) -or
        ![string]::IsNullOrWhiteSpace($ExpectPackage) -or ![string]::IsNullOrWhiteSpace($ExpectResourceId) -or $ConfirmAction) {
        throw "XhsCommentSend requires one bounded single-line ExpectedDraft value"
    }
} elseif ($Action -eq "XhsDmSend") {
    if ([string]::IsNullOrWhiteSpace($ExpectedDraft) -or $ExpectedDraft.Length -gt 256 -or $ExpectedDraft -match '[\x00\r\n]' -or
        ![string]::IsNullOrWhiteSpace($Text) -or ![string]::IsNullOrWhiteSpace($ExpectText) -or
        ![string]::IsNullOrWhiteSpace($ExpectPackage) -or ![string]::IsNullOrWhiteSpace($ExpectResourceId) -or
        ![string]::IsNullOrWhiteSpace($ExpectedTargetBase64) -or ![string]::IsNullOrWhiteSpace($ExpectedEditorStateHash) -or
        ![string]::IsNullOrWhiteSpace($ExpectedEmptyEditorStateHash) -or $PSBoundParameters.ContainsKey("ExpectedBeforeCount") -or $ConfirmAction) {
        throw "XhsDmSend requires one bounded single-line ExpectedDraft value"
    }
} elseif ($Action -eq "TapCoords") {
    $postconditionCount = @(@($ExpectText, $ExpectPackage, $ExpectResourceId) | Where-Object { ![string]::IsNullOrWhiteSpace($_) }).Count
    if (!$PSBoundParameters.ContainsKey("X") -or !$PSBoundParameters.ContainsKey("Y") -or
        [double]::IsNaN($X) -or [double]::IsInfinity($X) -or [double]::IsNaN($Y) -or [double]::IsInfinity($Y) -or
        $X -lt 0 -or $X -gt 100 -or $Y -lt 0 -or $Y -gt 100 -or $postconditionCount -ne 1 -or
        ![string]::IsNullOrWhiteSpace($Text) -or $ConfirmAction) {
        throw "TapCoords requires X and Y percentages from 0 through 100 plus exactly one postcondition"
    }
} elseif ($Action -in @("TapText", "TapOcr")) {
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
    if ($Action -eq "TapText") {
        if (![string]::IsNullOrWhiteSpace($TextMatch) -and $TextMatch -notin @("exact", "suffix")) {
            throw "TapText TextMatch is invalid"
        }
        if ($TextMatch -eq "suffix" -and (!$PSBoundParameters.ContainsKey("Ordinal") -or $Ordinal -lt 1 -or $Ordinal -gt 50)) {
            throw "TapText suffix matching requires Ordinal from 1 through 50"
        }
    }
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
} elseif (![string]::IsNullOrWhiteSpace($Text) -or ![string]::IsNullOrWhiteSpace($TextMatch) -or ![string]::IsNullOrWhiteSpace($ExpectedDraft) -or $PSBoundParameters.ContainsKey("ExpectedBeforeCount") -or
    ![string]::IsNullOrWhiteSpace($ExpectedTargetBase64) -or ![string]::IsNullOrWhiteSpace($ExpectedEditorStateHash) -or
    ![string]::IsNullOrWhiteSpace($ExpectedEmptyEditorStateHash) -or ![string]::IsNullOrWhiteSpace($ExpectText) -or
    ![string]::IsNullOrWhiteSpace($ExpectPackage) -or ![string]::IsNullOrWhiteSpace($ExpectResourceId) -or $ConfirmAction) {
    throw "Text and tap parameters are accepted only for Input, TapText, TapCoords, or TapOcr"
}
if ($Action -ne "TapCoords" -and ($PSBoundParameters.ContainsKey("X") -or $PSBoundParameters.ContainsKey("Y"))) {
    throw "X and Y are accepted only for TapCoords"
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
} elseif ($Action -eq "XhsCommentReplyInput") {
    if ($Ordinal -lt 1 -or $Ordinal -gt 50) { throw "XhsCommentReplyInput requires Ordinal from 1 through 50" }
} elseif ($Action -eq "TapText") {
    if ($PSBoundParameters.ContainsKey("Ordinal") -and ($Ordinal -lt 1 -or $Ordinal -gt 50)) {
        throw "TapText Ordinal must be from 1 through 50"
    }
} elseif ($Ordinal -ne 0) { throw "Ordinal is accepted only for XhsOpenVisible, XhsCommentReplyInput, or TapText" }
if ($Action -eq "XhsCommentEmoji") {
    if ([string]::IsNullOrWhiteSpace($Emoji) -or $Emoji.Length -gt 64 -or $Emoji -match '[\x00-\x1f\x7f]') {
        throw "XhsCommentEmoji requires one bounded Emoji label"
    }
    $Emoji = $Emoji.Normalize([System.Text.NormalizationForm]::FormKC).Trim()
} elseif (![string]::IsNullOrWhiteSpace($Emoji)) { throw "Emoji is accepted only for XhsCommentEmoji" }
$expectedTarget = $null
if ($Action -eq "XhsCommentSend") {
    try {
        $expectedTargetJson = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedTargetBase64))
        $expectedTarget = $expectedTargetJson | ConvertFrom-Json -ErrorAction Stop
    } catch { throw "XhsCommentSend ExpectedTargetBase64 is invalid" }
    if ($null -eq $expectedTarget -or $expectedTarget -is [string] -or $expectedTarget -is [System.Array]) {
        throw "XhsCommentSend expected target must be an object"
    }
}
if ($Action -eq "Scroll") {
    if ($Direction -notin @("down", "up", "left", "right")) { throw "Scroll requires Direction down, up, left, or right" }
    if ($Steps -eq 0) { $Steps = 1 }
    if ($Steps -lt 1 -or $Steps -gt 5) { throw "Scroll Steps must be from 1 through 5" }
} elseif (![string]::IsNullOrWhiteSpace($Direction) -or $Steps -ne 0) {
    throw "Direction and Steps are accepted only for Scroll"
}
if ($Action -eq "XhsFindVideo") {
    if (!$PSBoundParameters.ContainsKey("MaxScrolls")) { $MaxScrolls = 3 }
    if (!$PSBoundParameters.ContainsKey("MaxDurationMs")) { $MaxDurationMs = 28000 }
    if ($MaxScrolls -lt 0 -or $MaxScrolls -gt 10) { throw "XhsFindVideo MaxScrolls must be from 0 through 10" }
    if ($MaxDurationMs -lt 5000 -or $MaxDurationMs -gt 60000) { throw "XhsFindVideo MaxDurationMs must be from 5000 through 60000" }
} elseif ($PSBoundParameters.ContainsKey("MaxScrolls") -or $PSBoundParameters.ContainsKey("MaxDurationMs")) {
    throw "MaxScrolls and MaxDurationMs are accepted only for XhsFindVideo"
}

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
if ($Action -in @("AppList", "Recent", "TapText", "TapCoords", "TapOcr", "Input", "NodeResolve", "NodeActivate", "Scroll")) {
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
if ($Action -eq "AppList" -and $serials.Count -ne 1) { throw "AppList requires exactly one machine" }
if ($Action -eq "WeChatWalletBalance" -and $serials.Count -ne 1) { throw "WeChatWalletBalance requires exactly one machine" }
if ($Action -eq "XhsObserve" -and $serials.Count -ne 1) { throw "XhsObserve requires exactly one machine" }
if ($Action -eq "XhsFindVideo" -and $serials.Count -ne 1) { throw "XhsFindVideo requires exactly one machine" }
if ($Action -eq "XhsOpenVisible" -and $serials.Count -ne 1) { throw "XhsOpenVisible requires exactly one machine" }
if ($Action -eq "XhsCommentEmoji" -and $serials.Count -ne 1) { throw "XhsCommentEmoji requires exactly one machine" }
if ($Action -eq "Back" -and $serials.Count -ne 1) { throw "Back requires exactly one machine" }
if ($Action -in @("XhsCommentOpen", "XhsCommentInput", "XhsCommentReplyInput", "XhsCommentSend") -and $serials.Count -ne 1) { throw "$Action requires exactly one machine" }
if ($Action -eq "Scroll" -and $serials.Count -ne 1) { throw "Scroll requires exactly one machine" }
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
    "AppList" { "app-list" }
    "Ui" { "ui" }
    "Screen" { "screen" }
    "OpenApp" { "open-app" }
    "Home" { "home" }
    "Recent" { "recent" }
    "Back" { "back" }
    "TapText" { "tap-text" }
    "TapCoords" { "tap-coords" }
    "TapOcr" { "tap-ocr" }
    "Input" { "input" }
    "NodeResolve" { "node-resolve" }
    "NodeActivate" { "node-activate" }
    "Scroll" { "scroll" }
    "WeChatWalletBalance" { "wechat-wallet-balance" }
    "XhsObserve" { "xhs-observe" }
    "XhsFindVideo" { "xhs-find-video" }
    "XhsOpenVisible" { "xhs-open-visible" }
    "XhsCommentOpen" { "xhs-comment-open" }
    "XhsCommentInput" { "xhs-comment-input" }
    "XhsCommentReplyInput" { "xhs-comment-reply-input" }
    "XhsCommentSend" { "xhs-comment-send" }
    "XhsCommentEmoji" { "xhs-comment-emoji" }
    "XhsDmSend" { "xhs-dm-send" }
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
if ($Action -in @("OpenApp", "TapCoords", "TapOcr", "Input", "NodeResolve", "NodeActivate")) { $request["package"] = $PackageName }
if ($Action -eq "TapText" -and ![string]::IsNullOrWhiteSpace($PackageName)) { $request["package"] = $PackageName }
if ($Action -eq "Scroll") {
    $request["direction"] = $Direction
    $request["steps"] = $Steps
    if (![string]::IsNullOrWhiteSpace($PackageName)) { $request["package"] = $PackageName }
}
if ($Action -in @("Input", "XhsCommentInput", "XhsCommentReplyInput")) {
    $targetAlias = [string]$targets[0].alias
    $textInput = $config.Xiaowei.TextInput
    $profile = if ($textInput -and $textInput.PerDevice -and $textInput.PerDevice.ContainsKey($targetAlias)) { $textInput.PerDevice[$targetAlias] } else { $null }
    $acceptedActions = if ($api.AcceptedActionsByAlias -and $api.AcceptedActionsByAlias.ContainsKey($targetAlias)) { @($api.AcceptedActionsByAlias[$targetAlias]) } else { @() }
    $requiredActions = @("imeList", "selectIme", "inputText")
    if (!$textInput -or $textInput.Enabled -ne $true -or $textInput.HumanApproved -ne $true -or
        @($textInput.ApprovedAliases) -notcontains $targetAlias -or !$profile -or
        @($requiredActions | Where-Object { $acceptedActions -notcontains $_ }).Count) {
        throw "Input is not enabled and accepted for the selected machine"
    }
    $imeService = [string]$profile.PreferredImeService
    if ($imeService -notmatch '^[A-Za-z0-9._]+\/[A-Za-z0-9._$]+$' -or
        @($textInput.PreferredImeServices) -notcontains $imeService -or
        @("ui_text", "local_ocr") -notcontains [string]$profile.EchoVerification) {
        throw "Input profile is incomplete for the selected machine"
    }
    $request["text"] = $Text
    $request["imeService"] = $imeService
    $request["allowTemporaryEnable"] = [bool]$profile.AllowTemporaryEnable
    $request["echoVerification"] = [string]$profile.EchoVerification
    if ($Action -eq "XhsCommentInput") { $request["expectedEditorStateHash"] = $ExpectedEditorStateHash }
    if ($Action -eq "XhsCommentReplyInput") { $request["replyOrdinal"] = $Ordinal }
}
if ($Action -in @("TapText", "TapCoords", "TapOcr")) {
    if ($Action -eq "TapCoords") {
        $request["x"] = $X
        $request["y"] = $Y
    }
    if ($Action -ne "TapCoords") {
    $request["text"] = $normalizedText
    if ($Action -eq "TapText" -and ![string]::IsNullOrWhiteSpace($TextMatch)) { $request["match"] = $TextMatch }
    if ($Action -eq "TapText" -and $PSBoundParameters.ContainsKey("Ordinal")) { $request["ordinal"] = $Ordinal }
    }
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
if ($Action -eq "XhsFindVideo") {
    $request["maxScrolls"] = $MaxScrolls
    $request["maxDurationMs"] = $MaxDurationMs
}
if ($Action -eq "XhsCommentSend") {
    $request["expectedDraft"] = $ExpectedDraft.Normalize([System.Text.NormalizationForm]::FormKC)
    $request["expectedBeforeCount"] = $ExpectedBeforeCount
    $request["expectedTarget"] = $expectedTarget
    $request["expectedEmptyEditorStateHash"] = $ExpectedEmptyEditorStateHash
}
if ($Action -eq "XhsDmSend") { $request["expectedDraft"] = $ExpectedDraft.Normalize([System.Text.NormalizationForm]::FormKC) }
if ($Action -eq "XhsCommentEmoji") { $request["emoji"] = $Emoji }
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
