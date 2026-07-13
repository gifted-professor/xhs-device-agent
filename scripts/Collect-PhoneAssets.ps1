param(
    [string]$AdbPath = "D:\download\lvjian\tools\adb.exe",
    [string]$OutputDir,
    [switch]$OpenXhsProfile
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$OutputDir) { $OutputDir = Join-Path $projectRoot "data\device_inventory" }

function Invoke-Adb {
    param(
        [string]$Serial,
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    $output = & $AdbPath -s $Serial @Arguments 2>$null
    $ErrorActionPreference = $previousPreference
    $output
}

function Get-Prop {
    param([string]$Serial, [string]$Name)
    (Invoke-Adb $Serial shell getprop $Name | Out-String).Trim()
}

function Get-FirstMatch {
    param([string]$Text, [string]$Pattern)
    $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($match.Success) { return $match.Groups[1].Value.Trim() }
    return $null
}

function Get-UiSummary {
    param([string]$XmlPath)
    if (!(Test-Path -LiteralPath $XmlPath)) { return @() }
    try {
        [xml]$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $XmlPath
        $items = foreach ($node in $doc.SelectNodes("//node")) {
            $label = if ($node.text) { [string]$node.text } elseif ($node.'content-desc') { [string]$node.'content-desc' } else { $null }
            if ($label) {
                [PSCustomObject]@{
                    text      = $label
                    bounds    = [string]$node.bounds
                    clickable = [string]$node.clickable
                    class     = [string]$node.class
                }
            }
        }
        return @($items)
    } catch {
        return @()
    }
}

function Save-UiHierarchy {
    param([string]$Serial, [string]$LocalPath, [string]$RemotePath = "/sdcard/codex_inventory_window.xml")
    Remove-Item -LiteralPath $LocalPath -Force -ErrorAction SilentlyContinue
    Invoke-Adb $Serial shell rm -f $RemotePath | Out-Null
    Invoke-Adb $Serial shell uiautomator dump $RemotePath | Out-Null
    Invoke-Adb $Serial pull $RemotePath $LocalPath | Out-Null
    Test-Path -LiteralPath $LocalPath
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
        if (!(Save-UiHierarchy $Serial $path)) { throw "Unable to save UI hierarchy while waiting for a stable page" }
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

function Get-SemanticTapPoint {
    param([string]$XmlPath, [string]$Label)
    if (!(Test-Path -LiteralPath $XmlPath)) { return $null }
    try {
        [xml]$doc = Get-Content -Raw -Encoding UTF8 -LiteralPath $XmlPath
        $candidates = @($doc.SelectNodes("//node") | Where-Object {
            $_.text -eq $Label -or $_.'content-desc' -eq $Label
        } | Sort-Object { if ($_.'clickable' -eq 'true') { 0 } else { 1 } })
        foreach ($node in $candidates) {
            if ([string]$node.bounds -match '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') {
                return [PSCustomObject]@{
                    x = [math]::Round(([int]$matches[1] + [int]$matches[3]) / 2)
                    y = [math]::Round(([int]$matches[2] + [int]$matches[4]) / 2)
                }
            }
        }
    } catch {}
    return $null
}

function Find-SemanticTapPoint {
    param([string]$Serial, [string]$Label, [string]$DeviceDir)
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $xml = Join-Path $DeviceDir "profile-target-$attempt.xml"
        if (Save-UiHierarchy $Serial $xml) {
            $point = Get-SemanticTapPoint $xml $Label
            if ($point) { return $point }
        }
        if ($attempt -eq 1) { Start-Sleep -Milliseconds 500 }
    }
    return $null
}

function Test-XmlText {
    param([string]$XmlPath, [string]$Label)
    if (!(Test-Path -LiteralPath $XmlPath -PathType Leaf)) { return $false }
    [xml]$doc = Get-Content -LiteralPath $XmlPath -Raw -Encoding UTF8
    [bool]@($doc.SelectNodes("//node") | Where-Object {
        ([string]$_.text).IndexOf($Label, [System.StringComparison]::Ordinal) -ge 0 -or
        ([string]$_.'content-desc').IndexOf($Label, [System.StringComparison]::Ordinal) -ge 0
    } | Select-Object -First 1).Count
}

function Test-FocusedPackage {
    param([string]$Serial, [string]$PackageName)
    $raw = Invoke-Adb $Serial shell dumpsys window windows | Out-String
    $focus = @($raw -split '\r?\n' | Where-Object { $_ -match 'mCurrentFocus|mFocusedApp' }) -join " "
    $focus -match [regex]::Escape($PackageName)
}

function Get-ProfileValue {
    param([string[]]$Texts, [string]$Pattern)
    foreach ($value in $Texts) {
        if ($value -match $Pattern) { return $matches[1] }
    }
    return $null
}

if (!(Test-Path -LiteralPath $AdbPath)) {
    throw "找不到 ADB：$AdbPath"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$deviceLines = & $AdbPath devices | Select-Object -Skip 1
$serials = @(
    foreach ($line in $deviceLines) {
        if ($line -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)

if (!$serials.Count) { throw "没有发现在线 ADB 设备" }

$inventory = foreach ($serial in $serials) {
    Write-Host "采集设备 $serial ..."
    $deviceDir = Join-Path $OutputDir $serial
    New-Item -ItemType Directory -Force -Path $deviceDir | Out-Null

    $wmSizeText = (Invoke-Adb $serial shell wm size | Out-String).Trim()
    $wmDensityText = (Invoke-Adb $serial shell wm density | Out-String).Trim()
    $size = Get-FirstMatch $wmSizeText '(?:Physical|Override) size:\s*(\d+x\d+)'
    if (!$size) { $size = Get-FirstMatch $wmSizeText '(\d+x\d+)' }
    $density = Get-FirstMatch $wmDensityText '(?:Physical|Override) density:\s*(\d+)'
    if (!$density) { $density = Get-FirstMatch $wmDensityText '(\d+)' }

    $batteryText = Invoke-Adb $serial shell dumpsys battery | Out-String
    $ipText = Invoke-Adb $serial shell ip -f inet addr show wlan0 | Out-String
    $storageText = Invoke-Adb $serial shell df /data | Out-String
    $packageText = Invoke-Adb $serial shell dumpsys package com.xingin.xhs | Out-String
    $windowText = Invoke-Adb $serial shell dumpsys window windows | Out-String

    $xhsInstalled = $packageText -match 'Package \[com\.xingin\.xhs\]'
    $xhsVersion = Get-FirstMatch $packageText '^\s*versionName=([^\r\n]+)'
    $profileNavigationStatus = "not_requested"
    $profileNavigationError = $null

    if ($OpenXhsProfile -and !$xhsInstalled) {
        $profileNavigationStatus = "unavailable"
        $profileNavigationError = "XHS is not installed"
    } elseif ($OpenXhsProfile -and $xhsInstalled) {
        $profileNavigationStatus = "pending"
        try {
            Invoke-Adb $serial shell am start -n com.xingin.xhs/.index.v2.IndexActivityV2 | Out-Null
            Wait-UiStable $serial $deviceDir "profile-entry" | Out-Null
            if (!(Test-FocusedPackage $serial "com.xingin.xhs")) { throw "Profile precondition failed: XHS was not focused; device navigation stopped" }

            $profileLabel = -join @([char]25105)
            $tapPoint = Find-SemanticTapPoint $serial $profileLabel $deviceDir
            if (!$tapPoint) { throw "Profile target was not found after two semantic hierarchy reads; device navigation stopped" }

            Invoke-Adb $serial shell input tap $tapPoint.x $tapPoint.y | Out-Null
            $stable = Wait-UiStable $serial $deviceDir "profile-after"
            $publicIdLabel = -join @(23567, 32418, 20070, 21495 | ForEach-Object { [char]$_ })
            $followerLabel = -join @(31881, 19997 | ForEach-Object { [char]$_ })
            $followingLabel = -join @(20851, 27880 | ForEach-Object { [char]$_ })
            $engagementLabel = -join @(33719, 36190, 19982, 25910, 34255 | ForEach-Object { [char]$_ })
            $hasId = Test-XmlText $stable.path $publicIdLabel
            $hasMetric = (Test-XmlText $stable.path $followerLabel) -or (Test-XmlText $stable.path $followingLabel) -or (Test-XmlText $stable.path $engagementLabel)
            if (!$hasId -or !$hasMetric) { throw "Profile verification failed: public ID and profile metrics were not both present; device navigation stopped" }
            $profileNavigationStatus = "verified"
        } catch {
            $profileNavigationStatus = "failed"
            $profileNavigationError = $_.Exception.Message
            Write-Warning "Profile navigation failed for one device; see inventory status"
        }
        $windowText = Invoke-Adb $serial shell dumpsys window windows | Out-String
    }

    $remoteXml = "/sdcard/codex_inventory_window.xml"
    $remotePng = "/sdcard/codex_inventory_screen.png"
    $localXml = Join-Path $deviceDir "window.xml"
    $localPng = Join-Path $deviceDir "screen.png"

    $hierarchyCaptured = Save-UiHierarchy $serial $localXml $remoteXml
    # 直接执行二进制截图与拉取，避免 PowerShell 包装函数吞掉文件输出。
    Remove-Item -LiteralPath $localPng -Force -ErrorAction SilentlyContinue
    Invoke-Adb $serial shell rm -f $remotePng | Out-Null
    & $AdbPath -s $serial shell screencap -p $remotePng 2>$null | Out-Null
    & $AdbPath -s $serial pull $remotePng $localPng 2>$null | Out-Null
    $screenshotCaptured = Test-Path -LiteralPath $localPng -PathType Leaf

    $uiItems = Get-UiSummary $localXml
    $uiItems | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "page_structure.csv")
    $visibleTexts = @($uiItems.text | Select-Object -Unique)
    $visibleTexts | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "visible_texts.txt")

    $xhsLabel = -join @(0x5C0F, 0x7EA2, 0x4E66, 0x53F7 | ForEach-Object { [char]$_ })
    $followerMetricLabel = -join @(31881, 19997 | ForEach-Object { [char]$_ })
    $followingMetricLabel = -join @(20851, 27880 | ForEach-Object { [char]$_ })
    $engagementMetricLabel = -join @(33719, 36190, 19982, 25910, 34255 | ForEach-Object { [char]$_ })
    $xhsId = @($visibleTexts | Where-Object { $_.StartsWith($xhsLabel) } | Select-Object -First 1)
    $ipRegion = @($visibleTexts | Where-Object { $_.StartsWith('IP') } | Select-Object -First 1)
    $profileMetricsDetected = [bool]@($visibleTexts | Where-Object {
        $_.Contains($followerMetricLabel) -or $_.Contains($followingMetricLabel) -or $_.Contains($engagementMetricLabel)
    } | Select-Object -First 1).Count
    $profileDetected = [bool]($xhsId.Count -and $profileMetricsDetected)
    if ($OpenXhsProfile -and $profileNavigationStatus -eq "verified" -and !$profileDetected) {
        $profileNavigationStatus = "failed"
        $profileNavigationError = "Final hierarchy did not retain both public ID and profile metrics"
    }
    $nickname = Get-ProfileValue $visibleTexts '^头像,(.+)$'
    $followingCount = Get-ProfileValue $visibleTexts '^(\d+)关注$'
    $followerCount = Get-ProfileValue $visibleTexts '^(\d+)粉丝$'
    $engagementCount = Get-ProfileValue $visibleTexts '^(\d+)获赞与收藏$'
    $publicPostCount = Get-ProfileValue $visibleTexts '^公开\s+(\d+)$'
    $privatePostCount = Get-ProfileValue $visibleTexts '^私密\s+(\d+)$'
    $collectionCount = Get-ProfileValue $visibleTexts '^合集\s+(\d+)$'

    $profileDetails = @()
    $metricEnd = [array]::IndexOf($visibleTexts, '获赞与收藏')
    if ($metricEnd -ge 0) {
        for ($i = $metricEnd + 1; $i -lt $visibleTexts.Count; $i++) {
            if ($visibleTexts[$i] -like '小组件*' -or $visibleTexts[$i] -eq '头图or头视频区容器') { break }
            if ($visibleTexts[$i] -ne '点击这里，填写简介') { $profileDetails += $visibleTexts[$i] }
        }
    }

    $result = [PSCustomObject]@{
        collectedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        serial            = $serial
        manufacturer      = Get-Prop $serial 'ro.product.manufacturer'
        brand             = Get-Prop $serial 'ro.product.brand'
        model             = Get-Prop $serial 'ro.product.model'
        product           = Get-Prop $serial 'ro.product.name'
        device            = Get-Prop $serial 'ro.product.device'
        androidVersion    = Get-Prop $serial 'ro.build.version.release'
        sdk               = Get-Prop $serial 'ro.build.version.sdk'
        securityPatch     = Get-Prop $serial 'ro.build.version.security_patch'
        buildFingerprint  = Get-Prop $serial 'ro.build.fingerprint'
        resolution        = $size
        density           = $density
        batteryLevel      = Get-FirstMatch $batteryText '^\s*level:\s*(\d+)'
        batteryTemperature= Get-FirstMatch $batteryText '^\s*temperature:\s*(\d+)'
        wlanIp            = Get-FirstMatch $ipText 'inet\s+([0-9.]+)'
        dataStorage       = ($storageText.Trim() -replace '\r?\n', ' | ')
        xhsInstalled      = $xhsInstalled
        xhsVersion        = $xhsVersion
        currentFocus      = Get-FirstMatch $windowText 'mCurrentFocus=.*?\s([A-Za-z0-9._]+/[A-Za-z0-9.$_]+)'
        profileDetected   = $profileDetected
        profileNavigationStatus = $profileNavigationStatus
        profileNavigationError  = $profileNavigationError
        xhsNickname       = $nickname
        xhsPublicId       = if ($profileDetected) { $xhsId[0] -replace '^.*?[:\uFF1A]\s*', '' } else { $null }
        xhsIpRegion       = if ($ipRegion.Count) { $ipRegion[0] -replace '^IP[:：]\s*', '' } else { $null }
        xhsFollowing      = $followingCount
        xhsFollowers      = $followerCount
        xhsLikesFavorites = $engagementCount
        xhsPublicPosts    = $publicPostCount
        xhsPrivatePosts   = $privatePostCount
        xhsCollections    = $collectionCount
        xhsProfileDetails = ($profileDetails | Select-Object -Unique) -join '；'
        visibleTextCount  = $visibleTexts.Count
        screenshotPath    = if ($screenshotCaptured) { $localPng } else { $null }
        hierarchyPath     = if ($hierarchyCaptured) { $localXml } else { $null }
    }

    $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $deviceDir "inventory.json")
    $result
}

$inventory | Export-Csv -NoTypeInformation -Encoding UTF8 -LiteralPath (Join-Path $OutputDir "devices.csv")
$inventory | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $OutputDir "devices.json")

$inventory | Format-Table serial,model,androidVersion,resolution,xhsInstalled,xhsVersion,profileDetected,xhsPublicId -AutoSize
Write-Host "采集完成：$OutputDir"
