[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Status", "Capture", "Refresh", "RestartAdb", "PrivateApiStatus", "EnablePrivateApi", "DisablePrivateApi")]
    [string]$Action,

    [string]$ConfigPath,

    [string]$WindowHandle,

    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Local config was not found" }
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath

function Get-XiaoweiPrivateApiEndpoint {
    if ($config.Xiaowei -and $config.Xiaowei.Api -and $config.Xiaowei.Api.PrivateApiDebuggerEndpoint) {
        return [string]$config.Xiaowei.Api.PrivateApiDebuggerEndpoint
    }
    return "http://127.0.0.1:9223"
}

function Invoke-XiaoweiPrivateApi {
    param([Parameter(Mandatory = $true)][string]$Command)
    $endpoint = Get-XiaoweiPrivateApiEndpoint
    $raw = & node (Join-Path $PSScriptRoot "xiaowei-private-api.mjs") $Command --endpoint $endpoint 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw $raw.Trim() }
    try { return $raw | ConvertFrom-Json } catch { throw "Xiaowei private API returned invalid JSON" }
}

function Invoke-ConfiguredAdb {
    param([Parameter(Mandatory = $true)][string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    try {
        # ADB writes normal daemon lifecycle messages to stderr. Capture those
        # messages and decide success from the native exit code instead of
        # allowing PowerShell 5 to promote stderr to a terminating error.
        $ErrorActionPreference = "Continue"
        $raw = & $config.AdbPath @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    return [pscustomobject]@{ output = $raw; exitCode = $exitCode }
}

function ConvertTo-AdbDeviceSummary {
    param([string]$Raw)
    $records = @()
    foreach ($line in @($Raw -split '\r?\n')) {
        if ($line -notmatch '^([^\s]+)\s+(device|offline|unauthorized)\b') { continue }
        $serial = [string]$Matches[1]
        $status = [string]$Matches[2]
        $alias = $null
        if ($config.Devices -and $config.Devices.ContainsKey($serial)) { $alias = [string]$config.Devices[$serial] }
        $records += [pscustomobject]@{ status = $status; alias = $alias }
    }
    return [pscustomobject][ordered]@{
        onlineCount = @($records | Where-Object { $_.status -eq "device" }).Count
        offlineCount = @($records | Where-Object { $_.status -eq "offline" }).Count
        unauthorizedCount = @($records | Where-Object { $_.status -eq "unauthorized" }).Count
        onlineAliases = @($records | Where-Object { $_.status -eq "device" -and $_.alias } | ForEach-Object { $_.alias } | Sort-Object -Unique)
        unmappedCount = @($records | Where-Object { !$_.alias }).Count
        identifiersRedacted = $true
    }
}

function Get-XiaoweiDeviceRefreshSnapshot {
    $previousApiUrl = $env:XIAOWEI_API_URL
    $apiResultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-host-list-{0}.json" -f [guid]::NewGuid().ToString("N"))
    $raw = $null
    try {
        if ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { $env:XIAOWEI_API_URL = $config.Xiaowei.ApiEndpoint }
        $processOutput = & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") list --internal-gateway --result-file $apiResultPath 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $apiResultPath -PathType Leaf)) {
            $raw = Get-Content -LiteralPath $apiResultPath -Raw -Encoding UTF8
        } else {
            $raw = $processOutput
        }
    } catch {
        $raw = $_.Exception.Message
    } finally {
        $env:XIAOWEI_API_URL = $previousApiUrl
        Remove-Item -LiteralPath $apiResultPath -Force -ErrorAction SilentlyContinue
    }
    try {
        $body = $raw | ConvertFrom-Json
        $records = @($body.data)
        if ($body.code -eq 10000 -and $records.Count -ge 0 -and $null -ne $body.data) {
            $ids = @($records | ForEach-Object {
                if ($_.serial) { [string]$_.serial }
                elseif ($_.onlySerial) { [string]$_.onlySerial }
            } | Where-Object { $_ } | Select-Object -Unique)
            return [pscustomobject][ordered]@{
                available = $true
                code = [int]$body.code
                deviceCount = $ids.Count
                reason = "available"
            }
        }
        return [pscustomobject][ordered]@{
            available = $false
            code = if ($null -ne $body.code) { [int]$body.code } else { $null }
            deviceCount = 0
            reason = "API returned code=$($body.code): $($body.message)"
        }
    } catch {
        return [pscustomobject][ordered]@{
            available = $false
            code = $null
            deviceCount = 0
            reason = ([string]$raw).Trim() -replace '\r?\n', ' '
        }
    }
}

if ($Action -in @("EnablePrivateApi", "DisablePrivateApi")) {
    $mode = if ($Action -eq "EnablePrivateApi") { "Enable" } else { "Disable" }
    & (Join-Path $PSScriptRoot "Set-XiaoweiPrivateApi.ps1") -Mode $mode -ConfigPath $ConfigPath -RestartXiaowei
    return
}

if ($Action -eq "PrivateApiStatus") {
    Invoke-XiaoweiPrivateApi -Command "status"
    return
}

if ($Action -in @("Refresh", "RestartAdb")) {
    if (!$config.AdbPath -or !(Test-Path -LiteralPath $config.AdbPath -PathType Leaf)) {
        throw "The configured ADB executable was not found"
    }
    $backend = if ($Action -eq "Refresh") { "host_adb" } else { $null }
    $privateApi = $null
    $killOutput = $null
    $startOutput = $null
    if ($Action -eq "RestartAdb") {
        $developmentMode = $config.Xiaowei -and $config.Xiaowei.Api -and $config.Xiaowei.Api.DevelopmentMode -eq $true
        if ($developmentMode) {
            try {
                $privateApi = Invoke-XiaoweiPrivateApi -Command "restart-adb"
                $backend = "xiaowei_private_api"
            } catch {
                $privateFailure = $_.Exception.Message
                if ($privateFailure -match "CDP_TIMEOUT|CDP_CLOSED|VENDOR_FAILED|outcome may be unknown") {
                    throw "Xiaowei restart_adb outcome is unknown; host ADB fallback was not attempted: $privateFailure"
                }
                $privateApi = [pscustomobject][ordered]@{
                    available = $false
                    reason = $privateFailure
                    fallback = "host_adb"
                }
            }
        }
        if (!$backend) {
            $killResult = Invoke-ConfiguredAdb -Arguments @("kill-server")
            $killOutput = $killResult.output
            if ($killResult.exitCode -ne 0 -and $killOutput -notmatch "not running|daemon") {
                throw "ADB kill-server failed: $($killOutput.Trim())"
            }
            $startResult = Invoke-ConfiguredAdb -Arguments @("start-server")
            $startOutput = $startResult.output
            if ($startResult.exitCode -ne 0) { throw "ADB start-server failed: $($startOutput.Trim())" }
            $backend = "host_adb_fallback"
        }
    }
    $devicesDeadline = (Get-Date).AddSeconds($(if ($backend -eq "xiaowei_private_api") { 15 } else { 1 }))
    do {
        $devicesResult = Invoke-ConfiguredAdb -Arguments @("devices", "-l")
        $devicesOutput = $devicesResult.output
        if ($devicesResult.exitCode -eq 0) { break }
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $devicesDeadline)
    if ($devicesResult.exitCode -ne 0) { throw "ADB device refresh failed: $($devicesOutput.Trim())" }
    $xiaoweiSnapshot = Get-XiaoweiDeviceRefreshSnapshot
    if ($backend -eq "xiaowei_private_api" -and !$xiaoweiSnapshot.available) {
        $snapshotDeadline = (Get-Date).AddSeconds(8)
        do {
            Start-Sleep -Milliseconds 750
            $xiaoweiSnapshot = Get-XiaoweiDeviceRefreshSnapshot
        } while (!$xiaoweiSnapshot.available -and (Get-Date) -lt $snapshotDeadline)
    }
    [pscustomobject][ordered]@{
        action = $Action.ToLowerInvariant()
        backend = $backend
        adbPath = $config.AdbPath
        privateApi = $privateApi
        killServer = if ($killOutput) { $killOutput.Trim() } else { $null }
        startServer = if ($startOutput) { $startOutput.Trim() } else { $null }
        devices = ConvertTo-AdbDeviceSummary -Raw $devicesOutput
        xiaowei = $xiaoweiSnapshot
        next = ".\xhs.cmd device list"
    }
    return
}

if (!$config.Xiaowei -or !$config.Xiaowei.Executable -or !(Test-Path -LiteralPath $config.Xiaowei.Executable -PathType Leaf)) {
    throw "The configured Xiaowei executable was not found"
}

$executable = (Resolve-Path -LiteralPath $config.Xiaowei.Executable).Path
$version = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
$processName = [System.IO.Path]::GetFileNameWithoutExtension($executable)
$running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
$started = $false
if ($Action -eq "Start" -and !$running.Count) {
    $workingDirectory = Split-Path -Parent $executable
    Start-Process -FilePath $executable -WorkingDirectory $workingDirectory | Out-Null
    $started = $true
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 10000) {
        Start-Sleep -Milliseconds 250
        $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)
        if ($running.Count) { break }
    }
    if (!$running.Count) { throw "Xiaowei did not become observable within 10 seconds" }
}

if ($Action -eq "Capture") {
    if (!$running.Count) { throw "The configured Xiaowei process is not running" }
    $captureArguments = @{}
    if ($WindowHandle) { $captureArguments.WindowHandle = $WindowHandle }
    else { $captureArguments.ProcessName = $processName }
    if ($OutputPath) { $captureArguments.OutputPath = $OutputPath }
    & (Join-Path $PSScriptRoot "Capture-VisibleWindow.ps1") @captureArguments
    return
}

[pscustomobject][ordered]@{
    action = $Action.ToLowerInvariant()
    installed = $true
    version = $version
    processRunning = [bool]$running.Count
    startedByCommand = $started
    next = if ($running.Count) { ".\xhs.cmd doctor" } else { ".\xhs.cmd host start" }
}
