[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Start", "Status", "Capture")]
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
