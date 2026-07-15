[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SpecPath,

    [string]$ConfigPath,

    [string]$OutputRoot,

    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (!(Test-Path -LiteralPath $SpecPath -PathType Leaf)) { throw "Batch spec not found: $SpecPath" }

$node = (Get-Command node -ErrorAction Stop).Source
$runner = Join-Path $PSScriptRoot "feed-batch-runner.mjs"
$arguments = @($runner, "--spec", (Resolve-Path -LiteralPath $SpecPath).Path, "--project-root", $projectRoot)
if ($ConfigPath) { $arguments += @("--config", $ConfigPath) }
if ($OutputRoot) { $arguments += @("--output-root", $OutputRoot) }
if ($DryRun) { $arguments += "--dry-run" }

& $node @arguments
exit $LASTEXITCODE

