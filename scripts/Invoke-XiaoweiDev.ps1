[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Action,

    [string]$ConfigPath,
    [string]$MachineNumber,
    [string]$MachineNumbersCsv,
    [string]$MachineName,
    [string]$DeviceAlias,
    [string]$DeviceAliasesCsv,
    [string]$Group,
    [string]$DevicesCsv,
    [string]$DataFile,
    [string]$DataJson,
    [string]$Endpoint,
    [switch]$All
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Config not found: $ConfigPath" }
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$apiPolicy = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
if (!$apiPolicy -or $apiPolicy.DevelopmentMode -ne $true) {
    throw "Xiaowei development mode is disabled in config. Set Xiaowei.Api.DevelopmentMode = `$true for local acceptance testing."
}
if ($DataFile -and $DataJson) { throw "Use DataFile or DataJson, not both" }
if ($All -and ($MachineNumber -or $MachineNumbersCsv -or $MachineName -or $DeviceAlias -or $DeviceAliasesCsv -or $Group -or $DevicesCsv)) {
    throw "All-device targeting cannot be combined with another device selector"
}

$request = [ordered]@{ action = $Action }

if ($All) {
    $request.devices = "all"
} elseif ($DevicesCsv) {
    $rawDevices = @($DevicesCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if (!$rawDevices.Count -or @($rawDevices | Select-Object -Unique).Count -ne $rawDevices.Count) {
        throw "DevicesCsv must contain one or more unique device selectors"
    }
    $request.devices = $rawDevices -join ","
} else {
    $machineDirectory = @(Get-MachineDirectory -Config $config)
    $selectionModes = @(
        [bool]$MachineNumber,
        [bool]$MachineNumbersCsv,
        [bool]$MachineName,
        [bool]$DeviceAlias,
        [bool]$DeviceAliasesCsv,
        [bool]$Group
    ) | Where-Object { $_ }
    if ($selectionModes.Count -gt 1) { throw "Use only one machine selector or group" }

    $targets = @()
    if ($MachineNumbersCsv) {
        $numbers = @($MachineNumbersCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($number in $numbers) {
            $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber $number
            $matching = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
            if ($matching.Count -ne 1) { throw "Machine $number does not resolve to exactly one local ADB device" }
            $targets += [string]$matching[0]
        }
    } elseif ($MachineNumber) {
        $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineNumber $MachineNumber
        $matching = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
        if ($matching.Count -ne 1) { throw "Machine $MachineNumber does not resolve to exactly one local ADB device" }
        $targets = @([string]$matching[0])
    } elseif ($MachineName) {
        $identity = Resolve-MachineIdentity -Directory $machineDirectory -MachineName $MachineName
        $matching = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $identity.DeviceAlias })
        if ($matching.Count -ne 1) { throw "Machine $MachineName does not resolve to exactly one local ADB device" }
        $targets = @([string]$matching[0])
    } elseif ($DeviceAliasesCsv) {
        $aliases = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        foreach ($alias in $aliases) {
            $matching = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $alias })
            if ($matching.Count -ne 1) { throw "Device alias $alias does not resolve to exactly one local ADB device" }
            $targets += [string]$matching[0]
        }
    } elseif ($DeviceAlias) {
        $matching = @($config.Devices.Keys | Where-Object { [string]$config.Devices[$_] -ceq $DeviceAlias })
        if ($matching.Count -ne 1) { throw "Device alias $DeviceAlias does not resolve to exactly one local ADB device" }
        $targets = @([string]$matching[0])
    } elseif ($Group) {
        if (!$config.Groups -or !$config.Groups.ContainsKey($Group)) { throw "Unknown device group: $Group" }
        $targets = @($config.Groups[$Group] | ForEach-Object { [string]$_ })
    }
    if ($targets.Count) { $request.devices = @($targets | Select-Object -Unique) -join "," }
}

if ($DataFile) {
    if (!(Test-Path -LiteralPath $DataFile -PathType Leaf)) { throw "Data file not found: $DataFile" }
    $DataJson = Get-Content -LiteralPath $DataFile -Raw -Encoding UTF8
}
if ($DataJson) {
    try { $request.data = $DataJson | ConvertFrom-Json } catch { throw "DataJson is not valid JSON: $($_.Exception.Message)" }
}

$requestPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-dev-request-{0}.json" -f [guid]::NewGuid().ToString("N"))
$encoding = New-Object System.Text.UTF8Encoding($false)
try {
    [System.IO.File]::WriteAllText($requestPath, ($request | ConvertTo-Json -Depth 32 -Compress), $encoding)
    $effectiveEndpoint = if ($Endpoint) { $Endpoint } elseif ($config.Xiaowei -and $config.Xiaowei.ApiEndpoint) { [string]$config.Xiaowei.ApiEndpoint } else { "ws://127.0.0.1:22222/" }
    & node (Join-Path $PSScriptRoot "xiaowei-api.mjs") dev-invoke `
        --development-mode `
        --request-file $requestPath `
        --endpoint $effectiveEndpoint
    if ($LASTEXITCODE -ne 0) { throw "Xiaowei development action failed with exit code $LASTEXITCODE" }
} finally {
    Remove-Item -LiteralPath $requestPath -Force -ErrorAction SilentlyContinue
}
