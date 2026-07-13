$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$powerShellFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.ps1"
foreach ($file in $powerShellFiles) {
    [void][scriptblock]::Create((Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8))
    Write-Host "PowerShell syntax OK: $($file.Name)"
}

$configFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot "config") -Filter "*.psd1"
foreach ($file in $configFiles) {
    Import-PowerShellDataFile -LiteralPath $file.FullName | Out-Null
    Write-Host "PowerShell data file OK: $($file.Name)"
}

$jsonFiles = Get-ChildItem -LiteralPath (Join-Path $projectRoot "config") -Filter "*.json"
foreach ($file in $jsonFiles) {
    Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
    Write-Host "JSON config OK: $($file.Name)"
}

Push-Location $projectRoot
try {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    & $npm run check
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed" }
    & $npm test
    if ($LASTEXITCODE -ne 0) { throw "Automated tests failed" }
} finally {
    Pop-Location
}

Write-Host "Project checks passed"
