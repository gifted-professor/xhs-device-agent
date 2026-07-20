param(
    [string]$ConfigPath,
    [switch]$SyncLark
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "PowerShell-Runtime.ps1")
$powerShellExecutable = Resolve-XhsPowerShellExecutable
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
$dataDir = Join-Path $projectRoot "data"
$rawDir = Join-Path $dataDir "device_inventory"
$assetCsv = Join-Path $dataDir "phone-assets.csv"
$safeLarkCsv = Join-Path $dataDir "lark_payloads\inventory-safe.csv"

if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "找不到本地配置。请复制 config/devices.example.psd1 为 config/local.psd1 后填写。"
}
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.AdbPath) { throw "配置缺少 AdbPath" }
if (!(Test-Path -LiteralPath $config.AdbPath -PathType Leaf)) { throw "配置的 AdbPath 不存在" }
if (!$config.Devices -or !($config.Devices -is [System.Collections.IDictionary])) {
    throw "资产采集要求所有在线设备先配置安全别名"
}

. (Join-Path $PSScriptRoot "Device-Lock.ps1")
. (Join-Path $PSScriptRoot "Lark-InventoryPolicy.ps1")
$deviceLines = & $config.AdbPath devices 2>$null | Select-Object -Skip 1
if ($LASTEXITCODE -ne 0) { throw "无法清点在线 ADB 设备" }
$onlineSerials = @(
    foreach ($line in $deviceLines) {
        if ($line -match '^([^\s]+)\s+device$') { $matches[1] }
    }
)
if (!$onlineSerials.Count) { throw "没有发现在线 ADB 设备" }

$inventoryAliases = @()
$seenAliases = @{}
foreach ($serial in $onlineSerials) {
    if (!$config.Devices.Contains($serial)) {
        throw "存在未配置安全别名的在线设备；采集尚未开始"
    }
    $alias = Assert-LarkInventoryAlias -Alias $config.Devices[$serial] -RawSerial $serial
    $aliasKey = $alias.ToLowerInvariant()
    if ($seenAliases.ContainsKey($aliasKey)) { throw "在线设备别名必须唯一" }
    $seenAliases[$aliasKey] = $true
    $inventoryAliases += $alias
}

$deviceLockHandles = @()
try {
$deviceLockHandles = @(Enter-DeviceLocks -ProjectRoot $projectRoot -DeviceAliases $inventoryAliases)
$previousLockedSerials = [Environment]::GetEnvironmentVariable("XHS_LOCKED_DEVICE_SERIALS_CSV", "Process")
$previousLockedAliases = [Environment]::GetEnvironmentVariable("XHS_LOCKED_DEVICE_ALIASES_CSV", "Process")
try {
    # Keep raw hardware identifiers out of the long-lived child process command line.
    $env:XHS_LOCKED_DEVICE_SERIALS_CSV = $onlineSerials -join ","
    $env:XHS_LOCKED_DEVICE_ALIASES_CSV = $inventoryAliases -join ","
    & $powerShellExecutable -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Collect-PhoneAssets.ps1") -AdbPath $config.AdbPath -OutputDir $rawDir -OpenXhsProfile
    if ($LASTEXITCODE -ne 0) { throw "手机资产采集失败" }
} finally {
    if ($null -eq $previousLockedSerials) { Remove-Item Env:XHS_LOCKED_DEVICE_SERIALS_CSV -ErrorAction SilentlyContinue } else { $env:XHS_LOCKED_DEVICE_SERIALS_CSV = $previousLockedSerials }
    if ($null -eq $previousLockedAliases) { Remove-Item Env:XHS_LOCKED_DEVICE_ALIASES_CSV -ErrorAction SilentlyContinue } else { $env:XHS_LOCKED_DEVICE_ALIASES_CSV = $previousLockedAliases }
}

$collectedInventory = @(Import-Csv -LiteralPath (Join-Path $rawDir "devices.csv") -Encoding UTF8)
$localAssets = @($collectedInventory | ForEach-Object {
    $deviceNumber = $config.Devices[$_.serial]
    if (!$deviceNumber) { $deviceNumber = $_.serial }
    [pscustomobject][ordered]@{
        "设备编号" = $deviceNumber
        "ADB序列号" = $_.serial
        "手机型号" = $_.model
        "品牌" = $_.brand
        "Android版本" = $_.androidVersion
        "安全补丁" = $_.securityPatch
        "分辨率" = $_.resolution
        "屏幕密度" = $_.density
        "电量" = $_.batteryLevel
        "WLAN地址" = $_.wlanIp
        "小红书版本" = $_.xhsVersion
        "小红书昵称" = $_.xhsNickname
        "小红书号" = $_.xhsPublicId
        "IP属地" = $_.xhsIpRegion
        "关注数" = $_.xhsFollowing
        "粉丝数" = $_.xhsFollowers
        "获赞与收藏" = $_.xhsLikesFavorites
        "公开笔记" = $_.xhsPublicPosts
        "私密笔记" = $_.xhsPrivatePosts
        "合集数" = $_.xhsCollections
        "主页资料" = $_.xhsProfileDetails
        "页面结构已采集" = $_.profileDetected
        "采集时间" = $_.collectedAt
    }
})
$localAssets | Export-Csv -LiteralPath $assetCsv -NoTypeInformation -Encoding UTF8

if ($SyncLark) {
    if (!$config.BaseToken -or !$config.TableId) { throw "同步飞书需要配置 BaseToken 和 TableId" }
    if (!$config.Devices -or !($config.Devices -is [System.Collections.IDictionary])) {
        throw "同步飞书需要为每台已采集设备配置安全别名；本地资产已保留，未发送任何外部请求"
    }

    # Keep the full inventory local. Only this closed, validated projection may
    # cross the Lark boundary. The policy refuses missing, duplicate, raw-serial,
    # network-like, account-like, and credential-like aliases/values.
    $safeInventory = @(ConvertTo-LarkSafeInventory -Inventory $collectedInventory -DeviceAliases $config.Devices)
    $safeLarkDir = Split-Path -Parent $safeLarkCsv
    New-Item -ItemType Directory -Force -Path $safeLarkDir | Out-Null
    $safeInventory | Export-Csv -LiteralPath $safeLarkCsv -NoTypeInformation -Encoding UTF8
    $approvedAliasesCsv = (@($safeInventory | ForEach-Object { $_."设备编号" } | Select-Object -Unique) -join ",")

    # Let the child inherit credentials instead of placing them in its visible
    # command line. Restore the caller's process environment in all outcomes.
    $previousBaseToken = [Environment]::GetEnvironmentVariable("LARK_BASE_TOKEN", "Process")
    $previousTableId = [Environment]::GetEnvironmentVariable("LARK_TABLE_ID", "Process")
    try {
        $env:LARK_BASE_TOKEN = [string]$config.BaseToken
        $env:LARK_TABLE_ID = [string]$config.TableId
        & $powerShellExecutable -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "Sync-LarkBase.ps1") -InventoryCsv $safeLarkCsv -ApprovedAliasesCsv $approvedAliasesCsv
        if ($LASTEXITCODE -ne 0) { throw "飞书同步失败" }
    } finally {
        if ($null -eq $previousBaseToken) { Remove-Item Env:LARK_BASE_TOKEN -ErrorAction SilentlyContinue } else { $env:LARK_BASE_TOKEN = $previousBaseToken }
        if ($null -eq $previousTableId) { Remove-Item Env:LARK_TABLE_ID -ErrorAction SilentlyContinue } else { $env:LARK_TABLE_ID = $previousTableId }
    }
}

Write-Host "完成：数据保存在 $dataDir"
} finally {
    Exit-DeviceLocks -Handles $deviceLockHandles
}
