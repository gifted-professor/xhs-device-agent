param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Inventory", "DumpUi", "Screenshot", "OpenXhs", "OpenProfile", "Home", "Back", "OpenSettings", "TapText", "ScreenOff", "ScreenOn", "PushFile", "InstallApk", "SetResolution", "SetDensity", "ResetDisplay")]
    [string]$Action,
    [string]$ConfigPath,
    [string[]]$Serials,
    [string]$Group,
    [string]$Text,
    [string]$ExpectText,
    [string]$LocalPath,
    [string]$RemotePath = "/sdcard/Download/",
    [string]$Value,
    [switch]$ConfirmAction,
    [string]$ConfirmationReason,
    [string]$RollbackInfo
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
$runRoot = Join-Path $projectRoot "data\matrix\runs\$((Get-Date).ToString('yyyyMMdd-HHmmss'))"

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

$readOnlyActions = @("OpenXhs", "OpenProfile", "Home", "Back", "DumpUi", "Screenshot", "Inventory")
$deviceLocalActions = @("OpenSettings", "TapText", "ScreenOff", "ScreenOn", "PushFile", "InstallApk", "SetResolution", "SetDensity", "ResetDisplay")
$actionRiskClass = if ($readOnlyActions -contains $Action) { "read_only_navigation" } elseif ($deviceLocalActions -contains $Action) { "device_local_change" } else { "external_interaction" }

if ($Action -eq "TapText" -and (Test-ExternalInteractionLabel $Text)) {
    $actionRiskClass = "external_interaction"
}
if ($actionRiskClass -eq "external_interaction") {
    throw "Action $Action is permanently blocked because it can create an external interaction. Confirmation cannot override this rule."
}
if ($Action -eq "TapText") {
    if ($Group -or !$Serials -or @($Serials).Count -ne 1) {
        throw "TapText is single-device only. Select exactly one device explicitly; groups and implicit all-device targeting are blocked."
    }
    if (!(Test-LocalSafeTapLabel $Text)) {
        throw "TapText is limited to a local-safe dismiss/navigation allowlist. Use a purpose-built semantic action for any other control."
    }
    if ([string]::IsNullOrWhiteSpace($ExpectText)) {
        throw "TapText requires -ExpectText so the target state can be verified without replay."
    }
}
if ($actionRiskClass -eq "device_local_change" -and (!$ConfirmAction -or [string]::IsNullOrWhiteSpace($ConfirmationReason) -or [string]::IsNullOrWhiteSpace($RollbackInfo))) {
    throw "Action $Action changes local device state. Pass -ConfirmAction, -ConfirmationReason, and -RollbackInfo after explicit user confirmation."
}

if (!(Test-Path -LiteralPath $ConfigPath)) { throw "Config not found: $ConfigPath" }
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
$adb = $config.AdbPath
if (!$adb -or !(Test-Path -LiteralPath $adb)) { throw "Configured AdbPath does not exist" }

$online = @(
    & $adb devices 2>$null | Select-Object -Skip 1 | ForEach-Object {
        if ($_ -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)
if (!$online.Count) { throw "No online ADB devices found" }

if ($Serials -and $Group) { throw "Use either Serials or Group, not both" }
if ($Group) {
    if (!$config.Groups -or !$config.Groups.ContainsKey($Group)) { throw "Unknown group: $Group" }
    $targets = @($config.Groups[$Group])
} elseif ($Serials) {
    $targets = @($Serials)
} else {
    $targets = $online
}
$targets = @($targets | Where-Object { $online -contains $_ } | Select-Object -Unique)
if (!$targets.Count) { throw "None of the selected devices are online" }

function Invoke-Adb {
    param([string]$Serial, [string[]]$Arguments)
    $output = & $adb -s $Serial @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $output.Trim() }
    $output.Trim()
}

function Save-Ui {
    param([string]$Serial, [string]$Path)
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    Invoke-Adb $Serial @("shell", "rm", "-f", "/sdcard/xhs_matrix_window.xml") | Out-Null
    Invoke-Adb $Serial @("shell", "uiautomator", "dump", "/sdcard/xhs_matrix_window.xml") | Out-Null
    Invoke-Adb $Serial @("pull", "/sdcard/xhs_matrix_window.xml", $Path) | Out-Null
    Test-Path -LiteralPath $Path
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
        $remote = "/sdcard/xhs_matrix_failure.png"
        $candidate = Join-Path $DeviceDir "failure.png"
        Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
        Invoke-Adb $Serial @("shell", "rm", "-f", $remote) | Out-Null
        Invoke-Adb $Serial @("shell", "screencap", "-p", $remote) | Out-Null
        Invoke-Adb $Serial @("pull", $remote, $candidate) | Out-Null
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $screenshotPath = $candidate }
    } catch {}

    [pscustomobject]@{ hierarchyPath = $hierarchyPath; screenshotPath = $screenshotPath }
}

New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$results = foreach ($serial in $targets) {
    $number = if ($config.Devices -and $config.Devices.ContainsKey($serial)) { $config.Devices[$serial] } else { "unmapped" }
    $deviceDir = Join-Path $runRoot $serial
    New-Item -ItemType Directory -Force -Path $deviceDir | Out-Null
    $entry = [ordered]@{ number = $number; serial = $serial; action = $Action; riskClass = $actionRiskClass; status = "success"; detail = $null; model = $null; android = $null; hierarchyPath = $null; screenshotPath = $null }
    try {
        switch ($Action) {
            "Inventory" {
                $entry.model = Invoke-Adb $serial @("shell", "getprop", "ro.product.model")
                $entry.android = Invoke-Adb $serial @("shell", "getprop", "ro.build.version.release")
            }
            "DumpUi" {
                $path = Join-Path $deviceDir "window.xml"
                Save-Ui $serial $path | Out-Null
                $entry.detail = $path
                $entry.hierarchyPath = $path
            }
            "Screenshot" {
                $path = Join-Path $deviceDir "screen.png"
                Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
                Invoke-Adb $serial @("shell", "rm", "-f", "/sdcard/xhs_matrix_screen.png") | Out-Null
                Invoke-Adb $serial @("shell", "screencap", "-p", "/sdcard/xhs_matrix_screen.png") | Out-Null
                Invoke-Adb $serial @("pull", "/sdcard/xhs_matrix_screen.png", $path) | Out-Null
                if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Screenshot postcondition failed; local file was not created" }
                $entry.detail = $path
                $entry.screenshotPath = $path
            }
            "OpenXhs" {
                Invoke-Adb $serial @("shell", "am", "start", "-n", "com.xingin.xhs/.index.v2.IndexActivityV2") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "xhs-open"
                Assert-FocusedPackage $serial "com.xingin.xhs" "OpenXhs"
                $entry.detail = $stable.path
            }
            "OpenProfile" {
                Invoke-Adb $serial @("shell", "am", "start", "-n", "com.xingin.xhs/.index.v2.IndexActivityV2") | Out-Null
                Wait-UiStable $serial $deviceDir "profile-entry" | Out-Null
                Assert-FocusedPackage $serial "com.xingin.xhs" "OpenProfile precondition"
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
                $entry.detail = $after
            }
            "Home" {
                Wait-UiStable $serial $deviceDir "home-before" | Out-Null
                Invoke-Adb $serial @("shell", "input", "keyevent", "3") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "home-after"
                $focus = Get-CurrentFocus $serial
                if ($focus -match 'com\.xingin\.xhs') { throw "Home verification failed; XHS remained focused" }
                $entry.detail = $stable.path
            }
            "Back" {
                Wait-UiStable $serial $deviceDir "back-before" | Out-Null
                Invoke-Adb $serial @("shell", "input", "keyevent", "4") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "back-after"
                $entry.detail = $stable.path
            }
            "OpenSettings" {
                Invoke-Adb $serial @("shell", "am", "start", "-a", "android.settings.SETTINGS") | Out-Null
                $stable = Wait-UiStable $serial $deviceDir "settings-after"
                Assert-FocusedPackage $serial "com.android.settings" "OpenSettings"
                $entry.detail = $stable.path
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
            }
            "ScreenOff" {
                Invoke-Adb $serial @("shell", "input", "keyevent", "223") | Out-Null
                Wait-ScreenState $serial $false
            }
            "ScreenOn" {
                Invoke-Adb $serial @("shell", "input", "keyevent", "224") | Out-Null
                Wait-ScreenState $serial $true
                $stable = Wait-UiStable $serial $deviceDir "screen-on-after"
                $entry.detail = $stable.path
            }
            "PushFile" {
                if (!$LocalPath -or !(Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "PushFile requires an existing -LocalPath" }
                Invoke-Adb $serial @("push", $LocalPath, $RemotePath) | Out-Null
            }
            "InstallApk" {
                if (!$LocalPath -or !(Test-Path -LiteralPath $LocalPath -PathType Leaf)) { throw "InstallApk requires an existing -LocalPath" }
                Invoke-Adb $serial @("install", "-r", $LocalPath) | Out-Null
            }
            "SetResolution" {
                if ($Value -notmatch '^\d+x\d+$') { throw "SetResolution -Value must look like 1080x2400" }
                Invoke-Adb $serial @("shell", "wm", "size", $Value) | Out-Null
                $actual = Invoke-Adb $serial @("shell", "wm", "size")
                if ($actual -notmatch [regex]::Escape($Value)) { throw "Resolution postcondition failed; expected $Value but read: $actual" }
            }
            "SetDensity" {
                if ($Value -notmatch '^\d+$') { throw "SetDensity -Value must be an integer" }
                Invoke-Adb $serial @("shell", "wm", "density", $Value) | Out-Null
                $actual = Invoke-Adb $serial @("shell", "wm", "density")
                if ($actual -notmatch "(?:Override density:\s*)?$([regex]::Escape($Value))(?:\s|$)") { throw "Density postcondition failed; expected $Value but read: $actual" }
            }
            "ResetDisplay" {
                Invoke-Adb $serial @("shell", "wm", "size", "reset") | Out-Null
                Invoke-Adb $serial @("shell", "wm", "density", "reset") | Out-Null
                $actualSize = Invoke-Adb $serial @("shell", "wm", "size")
                $actualDensity = Invoke-Adb $serial @("shell", "wm", "density")
                if ($actualSize -match 'Override size:' -or $actualDensity -match 'Override density:') { throw "ResetDisplay postcondition failed; an override remains active" }
            }
        }
    } catch {
        $entry.status = "failed"
        $entry.detail = $_.Exception.Message
        $diagnostics = Save-FailureDiagnostics $serial $deviceDir
        $entry.hierarchyPath = $diagnostics.hierarchyPath
        $entry.screenshotPath = $diagnostics.screenshotPath
    }
    [pscustomobject]$entry
}

$summary = [ordered]@{
    executedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    action = $Action
    riskClass = $actionRiskClass
    confirmationReason = if ($ConfirmAction) { $ConfirmationReason } else { $null }
    rollbackInfo = if ($ConfirmAction) { $RollbackInfo } else { $null }
    success = @($results | Where-Object status -eq "success").Count
    failed = @($results | Where-Object status -eq "failed").Count
    results = @($results)
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runRoot "result.json") -Encoding UTF8
$results | Format-Table number,action,status,detail -AutoSize
if ($summary.failed) { exit 2 }
