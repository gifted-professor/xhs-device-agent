function Get-FeedBatchControlPaths {
    param(
        [Parameter(Mandatory = $true)][string]$BatchRoot,
        [Parameter(Mandatory = $true)][string]$AttemptId
    )
    if ($AttemptId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$') { throw "BatchAttemptId is invalid" }
    $attempt = Join-Path (Join-Path $BatchRoot "attempts") $AttemptId
    @{
        Attempt = $attempt
        Lease = Join-Path $attempt "lease.json"
        Fuse = Join-Path $attempt "fuse.json"
        PreflightGo = Join-Path $attempt "preflight-go.json"
        Start = Join-Path $attempt "start.json"
        LockReady = Join-Path $attempt "ready-lock"
        PreflightReady = Join-Path $attempt "ready-preflight"
    }
}

function Write-FeedBatchJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = "$Path.$PID.tmp"
    try {
        $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Write-FeedBatchReady {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Paths,
        [Parameter(Mandatory = $true)][ValidateSet("lock", "preflight")][string]$Stage,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)][string]$MachineNumber,
        [hashtable]$Capabilities
    )
    $directory = if ($Stage -eq "lock") { $Paths.LockReady } else { $Paths.PreflightReady }
    $value = [ordered]@{
        schemaVersion = 1
        stage = $Stage
        taskId = $TaskId
        machine = $MachineNumber
        at = [DateTime]::UtcNow.ToString("o")
    }
    if ($Capabilities) { $value.capabilities = $Capabilities }
    Write-FeedBatchJsonAtomic -Path (Join-Path $directory "$TaskId.json") -Value $value
}

function Assert-FeedBatchParentActive {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Paths,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [int]$StaleAfterSeconds = 15
    )
    if (Test-Path -LiteralPath $Paths.Fuse -PathType Leaf) {
        $fuse = Get-Content -LiteralPath $Paths.Fuse -Raw | ConvertFrom-Json
        throw "BATCH_FUSED:$([string]$fuse.code)"
    }
    if (!(Test-Path -LiteralPath $Paths.Lease -PathType Leaf)) { throw "BATCH_PARENT_LOST:lease_missing" }
    try { $lease = Get-Content -LiteralPath $Paths.Lease -Raw | ConvertFrom-Json } catch { throw "BATCH_PARENT_LOST:lease_invalid" }
    if ([string]$lease.attemptId -ne $AttemptId) { throw "BATCH_PARENT_LOST:attempt_mismatch" }
    try { $updated = [DateTimeOffset]::Parse([string]$lease.updatedAt).UtcDateTime } catch { throw "BATCH_PARENT_LOST:lease_time_invalid" }
    if (([DateTime]::UtcNow - $updated).TotalSeconds -gt $StaleAfterSeconds) { throw "BATCH_PARENT_LOST:lease_stale" }
}

function Wait-FeedBatchBarrier {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Paths,
        [Parameter(Mandatory = $true)][string]$AttemptId,
        [Parameter(Mandatory = $true)][ValidateSet("preflight", "start")][string]$Stage,
        [int]$TimeoutSeconds = 30
    )
    $barrier = if ($Stage -eq "preflight") { $Paths.PreflightGo } else { $Paths.Start }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -le $deadline) {
        Assert-FeedBatchParentActive -Paths $Paths -AttemptId $AttemptId
        if (Test-Path -LiteralPath $barrier -PathType Leaf) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "BATCH_START_TIMEOUT:$Stage"
}
