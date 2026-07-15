function Enter-DeviceLocks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string[]]$DeviceAliases
    )

    Enter-NamedLocks -ProjectRoot $ProjectRoot -Namespace "" -Names $DeviceAliases -Label "Device alias"
}

function Enter-TaskLocks {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string[]]$TaskIds
    )
    Enter-NamedLocks -ProjectRoot $ProjectRoot -Namespace "tasks" -Names $TaskIds -Label "TaskId"
}

function Enter-NamedLocks {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Namespace,
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string]$Label
    )
    $safeNames = @($Names | ForEach-Object { [string]$_ } | Select-Object -Unique)
    if (!$safeNames.Count -or @($safeNames | Where-Object { $_ -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' }).Count) {
        throw "$Label locks require unique safe names"
    }
    if ($Namespace -and $Namespace -notmatch '^[A-Za-z0-9._-]{1,32}$') { throw "Lock namespace is invalid" }
    $lockRoot = Join-Path $ProjectRoot "data\locks"
    if ($Namespace) { $lockRoot = Join-Path $lockRoot $Namespace }
    New-Item -ItemType Directory -Force -Path $lockRoot | Out-Null
    $handles = @()
    try {
        foreach ($name in @($safeNames | Sort-Object)) {
            $path = Join-Path $lockRoot "$name.lock"
            try {
                $handles += [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            } catch {
                throw "$Label '$name' is already controlled by another process"
            }
        }
        ,$handles
    } catch {
        foreach ($handle in $handles) { try { $handle.Dispose() } catch {} }
        throw
    }
}

function Exit-DeviceLocks {
    param($Handles)
    foreach ($handle in @($Handles)) { try { $handle.Dispose() } catch {} }
}
