[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [string]$ArgsJson,
    [string]$ArgsBase64,
    [string]$ConfigPath,
    [string]$Endpoint
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Local config was not found" }
$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
$api = if ($config.Xiaowei -and $config.Xiaowei.Api) { $config.Xiaowei.Api } else { $null }
if (!$api -or $api.DevelopmentMode -ne $true) { throw "Xiaowei private development mode is disabled" }
if (!$config.Xiaowei.Executable -or !(Test-Path -LiteralPath $config.Xiaowei.Executable -PathType Leaf)) {
    throw "The configured Xiaowei executable was not found"
}
$currentVersion = (Get-Item -LiteralPath $config.Xiaowei.Executable).VersionInfo.ProductVersion
if (!$api.AcceptedXiaoweiVersion -or [string]$api.AcceptedXiaoweiVersion -ne [string]$currentVersion) {
    throw "Xiaowei private development calls require the exact accepted application version"
}
if ($ArgsJson -and $ArgsBase64) { throw "Use ArgsJson or ArgsBase64, not both" }
if ($ArgsBase64) {
    try {
        $argsBytes = [Convert]::FromBase64String($ArgsBase64)
        if ([Convert]::ToBase64String($argsBytes) -cne $ArgsBase64) { throw "non-canonical" }
        $ArgsJson = [System.Text.Encoding]::UTF8.GetString($argsBytes)
    } catch {
        throw "ArgsBase64 is not valid canonical base64"
    }
}
if (!$ArgsJson) { $ArgsJson = "{}" }
if ([System.Text.Encoding]::UTF8.GetByteCount($ArgsJson) -gt 32768) { throw "ArgsJson is too large" }
try { $parsedArgs = $ArgsJson | ConvertFrom-Json } catch { throw "ArgsJson is not valid JSON" }
if ($null -eq $parsedArgs -or $parsedArgs -isnot [pscustomobject]) { throw "ArgsJson must contain a JSON object" }
$effectiveEndpoint = if ($Endpoint) { $Endpoint } elseif ($api.PrivateApiDebuggerEndpoint) { [string]$api.PrivateApiDebuggerEndpoint } else { "http://127.0.0.1:9223" }
$argsPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xiaowei-private-args-{0}.json" -f [guid]::NewGuid().ToString("N"))
$encoding = New-Object System.Text.UTF8Encoding($false)
try {
    [System.IO.File]::WriteAllText($argsPath, $ArgsJson, $encoding)
    & node (Join-Path $PSScriptRoot "xiaowei-private-api.mjs") invoke `
        --development-mode `
        --command $Command `
        --args-file $argsPath `
        --endpoint $effectiveEndpoint
    if ($LASTEXITCODE -ne 0) { throw "Xiaowei private development command failed with exit code $LASTEXITCODE" }
} finally {
    if ($argsBytes) { [Array]::Clear($argsBytes, 0, $argsBytes.Length) }
    Remove-Item -LiteralPath $argsPath -Force -ErrorAction SilentlyContinue
}
