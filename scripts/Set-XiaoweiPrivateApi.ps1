[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Enable", "Disable", "Status")]
    [string]$Mode,

    [string]$ConfigPath,

    [switch]$RestartXiaowei,

    [switch]$ElevatedChild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "PowerShell-Runtime.ps1")
$powerShellExecutable = Resolve-XhsPowerShellExecutable
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Local config was not found" }
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$api = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
if ($Mode -eq "Enable" -and (!$api -or $api.DevelopmentMode -ne $true)) {
    throw "Xiaowei private API can be enabled only while Xiaowei.Api.DevelopmentMode is true"
}

$principal = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
$isAdministrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Mode -in @("Enable", "Disable") -and !$isAdministrator -and !$ElevatedChild) {
    $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    $argumentList = @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'),
        "-Mode", $Mode, "-ConfigPath", ('"' + $resolvedConfig + '"'), "-ElevatedChild"
    )
    if ($RestartXiaowei) { $argumentList += "-RestartXiaowei" }
    try {
        $elevated = Start-Process -FilePath $powerShellExecutable -Verb RunAs -WindowStyle Hidden -ArgumentList $argumentList -Wait -PassThru
    } catch {
        throw "Administrator approval for the Xiaowei private API was cancelled or failed"
    }
    if ($elevated.ExitCode -ne 0) { throw "The elevated Xiaowei private API setup failed with exit code $($elevated.ExitCode)" }
    return [pscustomobject][ordered]@{
        mode = $Mode.ToLowerInvariant()
        administratorApproved = $true
        restartRequested = [bool]$RestartXiaowei
        next = if ($Mode -eq "Enable") { ".\xhs.cmd host private-api-status" } else { ".\xhs.cmd host status" }
    }
}

$endpointText = if ($api -and $api.PrivateApiDebuggerEndpoint) { [string]$api.PrivateApiDebuggerEndpoint } else { "http://127.0.0.1:9223" }
try { $endpoint = [uri]$endpointText } catch { throw "Xiaowei private API debugger endpoint is invalid" }
if ($endpoint.Scheme -ne "http" -or $endpoint.Host -notin @("127.0.0.1", "localhost", "::1") -or $endpoint.Port -lt 1 -or $endpoint.AbsolutePath -ne "/" -or $endpoint.Query -or $endpoint.Fragment) {
    throw "Xiaowei private API debugger endpoint must be a local HTTP URL"
}
$port = $endpoint.Port
$managedValue = "--remote-debugging-port=$port"
$registryPath = "HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
$startAppIds = @(Get-StartApps | Where-Object { $_.AppID -match '\\xiaowei_android\\xiaowei\.exe$' } | ForEach-Object { [string]$_.AppID })
$valueNames = @(@("xiaowei.exe") + $startAppIds | Select-Object -Unique)
$currentValues = @{}
foreach ($valueName in $valueNames) {
    if (Test-Path -LiteralPath $registryPath) {
        try { $currentValues[$valueName] = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name $valueName -ErrorAction Stop) } catch {}
    }
}

try {
    if ($Mode -eq "Enable") {
        foreach ($valueName in $valueNames) {
            if ($currentValues[$valueName] -and $currentValues[$valueName] -ne $managedValue) {
                throw "A different Xiaowei WebView2 browser-argument policy already exists for $valueName; it was not overwritten"
            }
        }
        New-Item -Path $registryPath -Force | Out-Null
        foreach ($valueName in $valueNames) {
            Set-ItemProperty -LiteralPath $registryPath -Name $valueName -Value $managedValue -Type String
            $currentValues[$valueName] = $managedValue
        }
    } elseif ($Mode -eq "Disable") {
        foreach ($valueName in $valueNames) {
            if (!$currentValues[$valueName]) { continue }
            if ($currentValues[$valueName] -ne $managedValue) {
                throw "The existing Xiaowei WebView2 browser-argument policy for $valueName is not managed by this project; it was not removed"
            }
            Remove-ItemProperty -LiteralPath $registryPath -Name $valueName
            $currentValues.Remove($valueName)
        }
    }
} catch [System.UnauthorizedAccessException] {
    throw "Administrator approval is required to change the Xiaowei WebView2 private-API setting"
}

$restartPerformed = $false
$wasRunning = [bool](Get-Process -Name "xiaowei" -ErrorAction SilentlyContinue)
if ($RestartXiaowei -and ($wasRunning -or $Mode -eq "Enable") -and $Mode -in @("Enable", "Disable")) {
    if (!$config.Xiaowei -or !$config.Xiaowei.Executable -or !(Test-Path -LiteralPath $config.Xiaowei.Executable -PathType Leaf)) {
        throw "The configured Xiaowei executable was not found"
    }
    if ($wasRunning) {
        Get-Process -Name "xiaowei" -ErrorAction SilentlyContinue | Stop-Process -Force
        $deadline = (Get-Date).AddSeconds(10)
        do { Start-Sleep -Milliseconds 200 } while ((Get-Process -Name "xiaowei" -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline)
        if (Get-Process -Name "xiaowei" -ErrorAction SilentlyContinue) { throw "Xiaowei did not exit within 10 seconds" }
    }
    $previousBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    try {
        if ($Mode -eq "Enable") { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $managedValue }
        else { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
        $launchArguments = if ($Mode -eq "Enable") { @("--edge-webview-switches=--remote-debugging-port=$port") } else { @() }
        if ($wasRunning -or $Mode -eq "Enable") {
            Start-Process -FilePath $config.Xiaowei.Executable -ArgumentList $launchArguments -WorkingDirectory (Split-Path -Parent $config.Xiaowei.Executable) -WindowStyle Normal | Out-Null
        }
    } finally {
        if ($null -eq $previousBrowserArguments) { Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }
        else { $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousBrowserArguments }
    }
    $restartPerformed = $true
}

$running = [bool](Get-Process -Name "xiaowei" -ErrorAction SilentlyContinue)
[pscustomobject][ordered]@{
    mode = $Mode.ToLowerInvariant()
    enabled = @($valueNames | Where-Object { $currentValues[$_] -eq $managedValue }).Count -eq $valueNames.Count
    applicationIds = $valueNames
    debuggerEndpoint = $endpointText
    processRunning = $running
    restartPerformed = $restartPerformed
    restartRequired = $running -and !$restartPerformed -and $Mode -in @("Enable", "Disable")
    next = if ($running -and $Mode -eq "Enable") { "Exit Xiaowei completely, reopen it, then run .\xhs.cmd host private-api-status" }
        elseif ($Mode -eq "Enable") { ".\xhs.cmd host start" }
        else { $null }
}
