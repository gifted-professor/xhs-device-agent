[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ReviewPath,
    [string]$ConfigPath = "",
    [switch]$ConfirmExternalSync
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$ConfirmExternalSync) { throw "Research review sync requires explicit external-sync confirmation" }
if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Config not found: $ConfigPath" }

. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Lark-InventoryPolicy.ps1")

$config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
if (!$config.Devices -or $config.Devices.Count -eq 0) {
    throw "Research review sync requires the local device-to-alias mapping"
}

$approvedAliases = New-Object System.Collections.Generic.List[string]
$seenAliases = @{}
foreach ($entry in $config.Devices.GetEnumerator()) {
    $serial = ([string]$entry.Key).Trim()
    $alias = Assert-LarkInventoryAlias -Alias $entry.Value -RawSerial $serial
    if ($alias -eq "unmapped") { throw "Research review sync refuses an unmapped device alias" }
    $key = $alias.ToLowerInvariant()
    if ($seenAliases.ContainsKey($key)) { throw "Research review sync requires unique configured aliases" }
    $seenAliases[$key] = $true
    $approvedAliases.Add($alias)
}

$aliasFile = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-review-aliases-{0}.json" -f [guid]::NewGuid().ToString("N"))
$exitCode = 1
try {
    $json = ConvertTo-Json -InputObject ([object[]]$approvedAliases.ToArray()) -Compress
    [System.IO.File]::WriteAllText($aliasFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    & node (Join-Path $PSScriptRoot "sync-research-review.mjs") `
        --review $ReviewPath `
        --approved-aliases-file $aliasFile `
        --confirm-external-sync
    $exitCode = $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $aliasFile -Force -ErrorAction SilentlyContinue
}

if ($exitCode) { exit $exitCode }
