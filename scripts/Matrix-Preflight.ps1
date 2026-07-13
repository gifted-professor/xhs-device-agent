param(
    [string]$ConfigPath,
    [switch]$ProbeApi
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }

if (!(Test-Path -LiteralPath $ConfigPath)) {
    throw "Config not found: $ConfigPath. Copy config/matrix.example.psd1 to config/local.psd1 first."
}
$config = Import-PowerShellDataFile -LiteralPath $ConfigPath
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
    $number = if ($config.Devices -and $config.Devices.ContainsKey($serial)) { $config.Devices[$serial] } else { "unmapped" }
    [ordered]@{
        number = $number
        serial = $serial
        model = (& $config.AdbPath -s $serial shell getprop ro.product.model 2>$null | Out-String).Trim()
        android = (& $config.AdbPath -s $serial shell getprop ro.build.version.release 2>$null | Out-String).Trim()
    }
}

$api = [ordered]@{
    endpoint = if ($config.Xiaowei) { $config.Xiaowei.ApiEndpoint } else { $null }
    probed = [bool]$ProbeApi
    available = $false
    reason = "not probed"
}
if ($ProbeApi) {
    $previousApiUrl = $env:XIAOWEI_API_URL
    if ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { $env:XIAOWEI_API_URL = $config.Xiaowei.ApiEndpoint }
    $raw = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") list 2>&1 | Out-String
    $env:XIAOWEI_API_URL = $previousApiUrl
    try {
        $body = $raw | ConvertFrom-Json
        if ($body.code -eq 0 -or $body.code -eq 200) {
            $api.available = $true
            $api.reason = "available"
        } elseif ($body.code -eq 10001) {
            $api.reason = "API is listening, but API membership is not active"
        } else {
            $api.reason = "API returned code=$($body.code): $($body.message)"
        }
    } catch {
        $api.reason = ($raw.Trim() -replace '\r?\n', ' ')
    }
}

$result = [ordered]@{
    checkedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    transport = if ($api.available -and $config.Xiaowei.PreferApi) { "xiaowei-api" } else { "adb" }
    windowsCapture = $windowsCapture
    software = $software
    api = $api
    onlineDeviceCount = $online.Count
    devices = @($devices)
}

$outputDir = Join-Path $projectRoot "data\matrix"
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $outputDir "preflight.json") -Encoding UTF8

Write-Host "Xiaowei matrix preflight: version $($software.version), online devices $($online.Count), transport $($result.transport)"
if ($ProbeApi) { Write-Host "API: $($api.reason)" }
if (!$windowsCapture.computerUseWindowScreenshotCompatible) {
    Write-Warning "Computer Use window screenshots require Windows build 20348 or newer. This host is build $($windowsCapture.windowsBuild); use ADB screenshots and UI hierarchy for phone content. For Xiaowei's visible desktop window, use scripts/Capture-VisibleWindow.ps1 only while that window is foreground and unobscured."
}
$publicDevices = @($devices | ForEach-Object {
    [ordered]@{ number = $_.number; model = $_.model; android = $_.android }
})
[ordered]@{
    checkedAt = $result.checkedAt
    transport = $result.transport
    windowsCapture = $result.windowsCapture
    software = $result.software
    api = $result.api
    onlineDeviceCount = $result.onlineDeviceCount
    devices = $publicDevices
}
