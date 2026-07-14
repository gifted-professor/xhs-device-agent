function Enter-DeviceLocks {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProjectRoot,
        [Parameter(Mandatory = $true)]
        [string[]]$DeviceAliases
    )

    $safeAliases = @($DeviceAliases | ForEach-Object { [string]$_ } | Select-Object -Unique)
    if (!$safeAliases.Count -or @($safeAliases | Where-Object { $_ -notmatch '^[A-Za-z0-9._-]{1,64}$' }).Count) {
        throw "Device locks require unique safe aliases"
    }
    $lockRoot = Join-Path $ProjectRoot "data\locks"
    New-Item -ItemType Directory -Force -Path $lockRoot | Out-Null
    $handles = @()
    try {
        foreach ($alias in @($safeAliases | Sort-Object)) {
            $path = Join-Path $lockRoot "$alias.lock"
            try {
                $handles += [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            } catch {
                throw "Device alias '$alias' is already controlled by another process"
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
