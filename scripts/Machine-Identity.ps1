#Requires -Version 5.1

function ConvertTo-MachineNumber {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $trimmed = $Value.Trim()
    if ($trimmed -notmatch '^\d{1,2}$') {
        throw "Machine number must contain one or two digits"
    }
    $number = [int]$trimmed
    if ($number -lt 1 -or $number -gt 99) {
        throw "Machine number must be between 01 and 99"
    }
    return $number.ToString('00')
}

function Get-MachineDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Config
    )

    if (!$Config.Machines -or !$Config.Machines.Count) {
        throw "No human-facing machine directory is configured"
    }
    if (!$Config.Devices -or !$Config.Devices.Count) {
        throw "No internal device bindings are configured"
    }

    $entries = @()
    foreach ($key in @($Config.Machines.Keys | Sort-Object)) {
        $machineNumber = ConvertTo-MachineNumber ([string]$key)
        if ($machineNumber -cne [string]$key) {
            throw "Machine directory keys must use two digits, for example 04"
        }
        $profile = $Config.Machines[$key]
        if (!$profile -or !$profile.ContainsKey('Name') -or !$profile.ContainsKey('DeviceAlias')) {
            throw "Each machine directory entry requires Name and DeviceAlias"
        }
        $name = ([string]$profile.Name).Trim()
        $deviceAlias = ([string]$profile.DeviceAlias).Trim()
        if (!$name -or $name.Length -gt 80 -or $name -match '[\u0000-\u001f\u007f]') {
            throw "Machine names must contain 1-80 printable characters"
        }
        if ($deviceAlias -notmatch '^[A-Za-z0-9._-]{1,64}$' -or $deviceAlias -eq 'unmapped') {
            throw "Machine DeviceAlias is invalid"
        }
        $bindings = @($Config.Devices.Keys | Where-Object { [string]$Config.Devices[$_] -ceq $deviceAlias })
        if ($bindings.Count -ne 1) {
            throw "Each machine must resolve to exactly one internal device binding"
        }
        $entries += [pscustomobject]@{
            Number = $machineNumber
            Name = $name
            DeviceAlias = $deviceAlias
        }
    }

    if (@($entries.DeviceAlias | Select-Object -Unique).Count -ne $entries.Count) {
        throw "A device binding cannot belong to more than one machine number"
    }
    $configuredAliases = @($Config.Devices.Values | ForEach-Object { [string]$_ } | Select-Object -Unique)
    $missingAliases = @($configuredAliases | Where-Object { $entries.DeviceAlias -notcontains $_ })
    if ($missingAliases.Count) {
        throw "Every configured device binding must have a human-facing machine number and name"
    }
    return @($entries)
}

function Resolve-MachineIdentity {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Directory,
        [string]$MachineNumber,
        [string]$MachineName,
        [string]$DeviceAlias
    )

    $modes = 0
    if (![string]::IsNullOrWhiteSpace($MachineNumber)) { $modes++ }
    if (![string]::IsNullOrWhiteSpace($MachineName)) { $modes++ }
    if (![string]::IsNullOrWhiteSpace($DeviceAlias)) { $modes++ }
    if ($modes -ne 1) {
        throw "Select exactly one machine number or machine name"
    }

    if (![string]::IsNullOrWhiteSpace($MachineNumber)) {
        $normalized = ConvertTo-MachineNumber $MachineNumber
        $matches = @($Directory | Where-Object { $_.Number -ceq $normalized })
        if ($matches.Count -ne 1) { throw "Unknown machine number: $normalized" }
        return $matches[0]
    }

    if (![string]::IsNullOrWhiteSpace($MachineName)) {
        $normalizedName = $MachineName.Trim()
        $matches = @($Directory | Where-Object { $_.Name -ceq $normalizedName })
        if (!$matches.Count) { throw "Unknown machine name: $normalizedName" }
        if ($matches.Count -gt 1) { throw "Machine name '$normalizedName' is ambiguous; use its two-digit machine number" }
        return $matches[0]
    }

    $internalMatches = @($Directory | Where-Object { $_.DeviceAlias -ceq $DeviceAlias })
    if ($internalMatches.Count -ne 1) { throw "Internal device binding has no unique machine identity" }
    return $internalMatches[0]
}

function Get-MachineIdentityForAlias {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Directory,
        [Parameter(Mandatory = $true)]
        [string]$DeviceAlias
    )

    $matches = @($Directory | Where-Object { $_.DeviceAlias -ceq $DeviceAlias })
    if ($matches.Count -ne 1) {
        throw "Internal device binding has no unique machine identity"
    }
    return $matches[0]
}
