[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Feed", "Batch", "Research")]
    [string]$Kind,
    [string]$LegacySpecPath,
    [string]$TaskId,
    [int]$Count,
    [Nullable[int]]$LikeAt,
    [Nullable[int]]$FavoriteAt,
    [int]$MaxParallel,
    [string]$MachineNumbersCsv,
    [string]$MachineName,
    [string]$DeviceAliasesCsv,
    [string]$Group,
    [string]$CapabilityProfileId = "composite-capability-initial-v1",
    [string]$ConfigPath,
    [string]$OutputRoot,
    [string]$AcceptanceRoot,
    [string]$ConfirmPlanHash,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $PSScriptRoot "Import-Utf8PowerShellDataFile.ps1")
. (Join-Path $PSScriptRoot "Machine-Identity.ps1")

function Get-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Value))
}

function Resolve-CompatibilityMachines {
    param($Config)
    $modes = @(
        ![string]::IsNullOrWhiteSpace($MachineNumbersCsv),
        ![string]::IsNullOrWhiteSpace($MachineName),
        ![string]::IsNullOrWhiteSpace($DeviceAliasesCsv),
        ![string]::IsNullOrWhiteSpace($Group)
    ) | Where-Object { $_ }
    if ($modes.Count -ne 1) { throw "Compatibility conversion requires exactly one machine selector mode" }
    if ($MachineNumbersCsv) {
        $numbers = @($MachineNumbersCsv.Split(',') | ForEach-Object {
            $value = $_.Trim()
            if ($value -notmatch '^[0-9]{2}$') { throw "Machine number must contain exactly two digits" }
            $value
        })
        if (!$numbers.Count -or @($numbers | Select-Object -Unique).Count -ne $numbers.Count) { throw "Selected compatibility machines must be unique" }
        return $numbers
    }
    if (!$Config) { throw "Local config is required to resolve machine names, aliases, or groups" }
    $directory = @(Get-MachineDirectory -Config $Config)
    $identities = @()
    if ($MachineName) {
        $identities += @(Resolve-MachineIdentity -Directory $directory -MachineName $MachineName)
    } elseif ($DeviceAliasesCsv) {
        $aliases = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() })
        foreach ($alias in $aliases) { $identities += @(Resolve-MachineIdentity -Directory $directory -DeviceAlias $alias) }
    } else {
        if (!$Config.Groups -or !$Config.Groups.ContainsKey($Group)) { throw "Unknown group" }
        foreach ($member in @($Config.Groups[$Group])) {
            $alias = if ($Config.Devices -and $Config.Devices.ContainsKey($member)) { [string]$Config.Devices[$member] } else { [string]$member }
            $identities += @(Resolve-MachineIdentity -Directory $directory -DeviceAlias $alias)
        }
    }
    $numbers = @($identities | ForEach-Object { [string]$_.Number })
    if (!$numbers.Count -or @($numbers | Select-Object -Unique).Count -ne $numbers.Count) { throw "Selected compatibility machines must be unique" }
    $numbers
}

if (!$ConfigPath) { $ConfigPath = Join-Path $projectRoot "config\local.psd1" }
if (!$OutputRoot) { $OutputRoot = Join-Path $projectRoot "data\tasks" }
if (!$AcceptanceRoot) { $AcceptanceRoot = Join-Path $projectRoot "data\composite-capability" }
$ConfigPath = Get-AbsolutePath $ConfigPath
$OutputRoot = Get-AbsolutePath $OutputRoot
$AcceptanceRoot = Get-AbsolutePath $AcceptanceRoot

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$tempRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase ("xhs-task-compat-" + [guid]::NewGuid().ToString("N"))))
if (!$tempRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Compatibility temp path escaped the OS temp directory" }
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$legacyInput = $null
$taskSpec = Join-Path $tempRoot "task.json"
$exitCode = 2
try {
    if ($Kind -eq "Feed") {
        if (!$TaskId -or $TaskId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw "TaskId must contain 3-80 safe characters" }
        if ($Count -lt 1 -or $Count -gt 10000) { throw "Count must be 1..10000" }
        $config = $null
        if (!$MachineNumbersCsv) {
            if (!(Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Local config is required to resolve legacy Feed selectors" }
            $config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
        }
        $machines = @(Resolve-CompatibilityMachines -Config $config)
        if ($MaxParallel -eq 0) { $MaxParallel = $machines.Count }
        $request = [ordered]@{
            schemaVersion = "xhs-legacy-feed-compat/v1"
            taskId = $TaskId
            machines = $machines
            maxParallel = $MaxParallel
            count = $Count
        }
        if ($LikeAt.HasValue) { $request.likeAt = [int]$LikeAt.Value }
        if ($FavoriteAt.HasValue) { $request.favoriteAt = [int]$FavoriteAt.Value }
        $legacyInput = Join-Path $tempRoot "legacy-feed.json"
        [System.IO.File]::WriteAllText($legacyInput, ($request | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
    } elseif ($Kind -eq "Batch") {
        if (!$LegacySpecPath) { throw "Batch compatibility requires LegacySpecPath" }
        $legacyInput = Get-AbsolutePath $LegacySpecPath
        if (!(Test-Path -LiteralPath $legacyInput -PathType Leaf)) { throw "Legacy Batch spec not found" }
    } else {
        if (!$LegacySpecPath) { throw "Research compatibility requires LegacySpecPath" }
        $legacyInput = Get-AbsolutePath $LegacySpecPath
        if (!(Test-Path -LiteralPath $legacyInput -PathType Leaf)) { throw "Legacy Research spec not found" }
        $researchTask = Get-Content -LiteralPath $legacyInput -Raw -Encoding UTF8 | ConvertFrom-Json
        $config = $null
        if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
            $config = Import-Utf8PowerShellDataFile -LiteralPath $ConfigPath
        }
        if ($DryRun -and !$config) {
            if ($MachineNumbersCsv -or $MachineName -or $Group) { throw "Dry-run named machine selection requires local configuration" }
            $aliasCount = if ($DeviceAliasesCsv) {
                $aliases = @($DeviceAliasesCsv.Split(',') | ForEach-Object { $_.Trim() })
                if (!$aliases.Count -or @($aliases | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]{1,64}$' }).Count -or @($aliases | Select-Object -Unique).Count -ne $aliases.Count) {
                    throw "Research dry-run aliases must be unique safe values"
                }
                $aliases.Count
            } else { 3 }
            if ($aliasCount -gt 64) { throw "Research dry-run supports at most 64 synthetic machine slots" }
            $machines = @(1..$aliasCount | ForEach-Object { $_.ToString("00") })
        } else {
            if (!$config) { throw "Local config is required to resolve the Research device group" }
            if (!$MachineNumbersCsv -and !$MachineName -and !$DeviceAliasesCsv -and !$Group) {
                $Group = [string]$researchTask.deviceGroup
            }
            $machines = @(Resolve-CompatibilityMachines -Config $config)
        }
        if ($MaxParallel -eq 0) { $MaxParallel = $machines.Count }
    }

    $node = (Get-Command node -ErrorAction Stop).Source
    $converterArgs = @(
        (Join-Path $PSScriptRoot "legacy-task-converter.mjs"),
        "--kind", $Kind.ToLowerInvariant(),
        "--input", $legacyInput,
        "--output", $taskSpec,
        "--capability-profile", $CapabilityProfileId
    )
    if ($Kind -eq "Research") {
        $converterArgs += @("--machines", ($machines -join ","), "--max-parallel", [string]$MaxParallel)
    }
    & $node @converterArgs
    if ($LASTEXITCODE -ne 0) { throw "Legacy task conversion failed" }

    if ($DryRun) {
        $arguments = @((Join-Path $PSScriptRoot "task-runner.mjs"), "--spec", $taskSpec, "--dry-run", "--output", $OutputRoot)
        if ($Json) { $arguments += "--json" }
        & $node @arguments
        $exitCode = $LASTEXITCODE
    } else {
        $arguments = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "Run-TaskWorkflow.ps1"),
            "-SpecPath", $taskSpec,
            "-ConfigPath", $ConfigPath,
            "-OutputRoot", $OutputRoot,
            "-AcceptanceRoot", $AcceptanceRoot
        )
        if ($ConfirmPlanHash) { $arguments += @("-ConfirmPlanHash", $ConfirmPlanHash) }
        if ($Json) { $arguments += "-Json" }
        & powershell.exe @arguments
        $exitCode = $LASTEXITCODE
    }
} finally {
    if (Test-Path -LiteralPath $tempRoot -PathType Container) {
        $resolvedTemp = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $tempRoot).Path)
        if ($resolvedTemp.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTemp) -like 'xhs-task-compat-*') {
            Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
exit $exitCode
