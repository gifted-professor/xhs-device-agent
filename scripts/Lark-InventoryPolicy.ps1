Set-StrictMode -Version Latest

# This is a closed allowlist for inventory data that may leave the workstation.
# Callers may use a subset in the future, but must never add fields dynamically
# from CSV headers or local configuration.
$script:LarkInventoryApprovedFieldNames = [string[]]@(
    "设备编号"
    "手机型号"
    "品牌"
    "Android版本"
    "安全补丁"
    "分辨率"
    "屏幕密度"
    "电量"
    "小红书版本"
    "页面结构已采集"
    "采集时间"
)

function Get-LarkInventoryApprovedFieldNames {
    [CmdletBinding()]
    param()
    @($script:LarkInventoryApprovedFieldNames)
}

function Test-LarkInventoryValueLooksSensitive {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $false }
    $text = ([string]$Value).Trim()
    if (!$text) { return $false }

    # Reject common direct identifiers and credential shapes even inside an
    # otherwise approved column. This is intentionally conservative.
    if ($text -match '(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}') { return $true }
    if ($text -match '(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)') { return $true }
    if ($text -match '(?i)(?<![0-9A-F])(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}(?![0-9A-F])') { return $true }
    if ($text -match '(?<!\d)1[3-9]\d{9}(?!\d)') { return $true }
    if ($text -match '(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*') { return $true }
    if ($text -match '(?i)\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{12,}\b') { return $true }
    if ($text -match '(?i)\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b') { return $true }
    return $false
}

function Assert-LarkInventoryAlias {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object]$Alias,
        [AllowNull()][object]$RawSerial
    )

    $value = ([string]$Alias).Trim()
    if (!$value -or $value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw "Lark inventory sync requires a configured safe alias containing only letters, numbers, dot, underscore, or hyphen"
    }
    if ($RawSerial -and $value.Equals(([string]$RawSerial).Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Lark inventory sync refused an alias that equals the raw ADB serial"
    }
    if ($value -match '^(?i:emulator-\d+)$' -or
        $value -match '^\d{6,}$' -or
        $value -match '^(?i:[0-9a-f]{8,})$' -or
        (Test-LarkInventoryValueLooksSensitive $value)) {
        throw "Lark inventory sync refused an alias that looks like a real device, network, account, or credential identifier"
    }
    $value
}

function Assert-LarkInventoryText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FieldName,
        [AllowNull()][object]$Value,
        [int]$MaximumLength = 80
    )

    if ($null -eq $Value) { return }
    $text = [string]$Value
    if ($text.Length -gt $MaximumLength -or $text -match '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' -or $text -match '[\r\n]') {
        throw "Lark inventory field '$FieldName' is not a bounded single-line value"
    }
    if (Test-LarkInventoryValueLooksSensitive $text) {
        throw "Lark inventory field '$FieldName' contains a value shaped like a direct identifier or credential"
    }
}

function ConvertTo-LarkSafeInventory {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Inventory,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$DeviceAliases
    )

    $seenAliases = @{}
    foreach ($device in $Inventory) {
        $serial = ([string]$device.serial).Trim()
        if (!$serial) { throw "Local inventory contains a row without an ADB serial" }
        if (!$DeviceAliases.Contains($serial)) {
            throw "Lark inventory sync requires every collected device to have a configured safe alias"
        }

        $alias = Assert-LarkInventoryAlias -Alias $DeviceAliases[$serial] -RawSerial $serial
        $aliasKey = $alias.ToLowerInvariant()
        if ($seenAliases.ContainsKey($aliasKey)) {
            throw "Lark inventory sync requires unique configured aliases"
        }
        $seenAliases[$aliasKey] = $true

        # A configured alias must not secretly be an account or network identity
        # already visible in the local-only inventory.
        foreach ($identifierName in @("wlanIp", "xhsNickname", "xhsPublicId")) {
            $identifier = ([string]$device.$identifierName).Trim()
            if ($identifier -and $alias.Equals($identifier, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Lark inventory sync refused an alias that matches a local device or account identifier"
            }
        }

        $model = [string]$device.model
        $brand = [string]$device.brand
        $androidVersion = [string]$device.androidVersion
        $securityPatch = [string]$device.securityPatch
        $resolution = [string]$device.resolution
        $density = [string]$device.density
        $batteryLevel = [string]$device.batteryLevel
        $xhsVersion = [string]$device.xhsVersion
        $collectedAt = [string]$device.collectedAt

        Assert-LarkInventoryText -FieldName "手机型号" -Value $model
        Assert-LarkInventoryText -FieldName "品牌" -Value $brand
        Assert-LarkInventoryText -FieldName "Android版本" -Value $androidVersion -MaximumLength 32
        Assert-LarkInventoryText -FieldName "安全补丁" -Value $securityPatch -MaximumLength 16
        Assert-LarkInventoryText -FieldName "分辨率" -Value $resolution -MaximumLength 24
        Assert-LarkInventoryText -FieldName "屏幕密度" -Value $density -MaximumLength 12
        Assert-LarkInventoryText -FieldName "电量" -Value $batteryLevel -MaximumLength 4
        Assert-LarkInventoryText -FieldName "小红书版本" -Value $xhsVersion -MaximumLength 40
        Assert-LarkInventoryText -FieldName "采集时间" -Value $collectedAt -MaximumLength 32

        if ($securityPatch -and $securityPatch -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "安全补丁 must use yyyy-MM-dd" }
        if ($resolution -and $resolution -notmatch '^\d{2,5}x\d{2,5}$') { throw "分辨率 must use WIDTHxHEIGHT" }
        if ($density -and $density -notmatch '^\d{1,5}$') { throw "屏幕密度 must be an integer" }
        if ($batteryLevel -and ($batteryLevel -notmatch '^\d{1,3}$' -or [int]$batteryLevel -gt 100)) { throw "电量 must be between 0 and 100" }
        if ($xhsVersion -and $xhsVersion -notmatch '^[0-9A-Za-z._+-]{1,40}$') { throw "小红书版本 contains unexpected characters" }

        $profileDetected = $false
        if ($device.profileDetected -is [bool]) {
            $profileDetected = [bool]$device.profileDetected
        } elseif (([string]$device.profileDetected) -match '^(?i:true|false)$') {
            $profileDetected = [System.Convert]::ToBoolean([string]$device.profileDetected)
        } else {
            throw "页面结构已采集 must be a boolean"
        }

        [pscustomobject][ordered]@{
            "设备编号" = $alias
            "手机型号" = $model
            "品牌" = $brand
            "Android版本" = $androidVersion
            "安全补丁" = $securityPatch
            "分辨率" = $resolution
            "屏幕密度" = $density
            "电量" = $batteryLevel
            "小红书版本" = $xhsVersion
            "页面结构已采集" = $profileDetected
            "采集时间" = $collectedAt
        }
    }
}

function Assert-LarkSafeInventoryRows {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][object[]]$Rows,
        [Parameter(Mandatory = $true)][string[]]$ApprovedAliases
    )

    if (!$Rows.Count) { throw "Lark inventory sync requires at least one validated row" }
    if (!$ApprovedAliases.Count) { throw "Lark inventory sync requires configured approved aliases" }

    $approvedNames = @(Get-LarkInventoryApprovedFieldNames)
    $approvedAliasSet = @{}
    foreach ($candidate in $ApprovedAliases) {
        $alias = Assert-LarkInventoryAlias -Alias $candidate
        $key = $alias.ToLowerInvariant()
        if ($approvedAliasSet.ContainsKey($key)) { throw "Approved Lark inventory aliases must be unique" }
        $approvedAliasSet[$key] = $true
    }

    foreach ($row in $Rows) {
        $actualNames = @($row.PSObject.Properties.Name)
        $unexpected = @($actualNames | Where-Object { $_ -notin $approvedNames })
        $missing = @($approvedNames | Where-Object { $_ -notin $actualNames })
        if ($unexpected.Count -or $missing.Count -or $actualNames.Count -ne $approvedNames.Count) {
            throw "Lark inventory CSV must contain exactly the closed approved-field allowlist"
        }

        $alias = Assert-LarkInventoryAlias -Alias $row."设备编号"
        if (!$approvedAliasSet.ContainsKey($alias.ToLowerInvariant())) {
            throw "Lark inventory row uses an alias that was not approved by the local device mapping"
        }

        Assert-LarkInventoryText -FieldName "手机型号" -Value $row."手机型号"
        Assert-LarkInventoryText -FieldName "品牌" -Value $row."品牌"
        Assert-LarkInventoryText -FieldName "Android版本" -Value $row."Android版本" -MaximumLength 32
        Assert-LarkInventoryText -FieldName "安全补丁" -Value $row."安全补丁" -MaximumLength 16
        Assert-LarkInventoryText -FieldName "分辨率" -Value $row."分辨率" -MaximumLength 24
        Assert-LarkInventoryText -FieldName "屏幕密度" -Value $row."屏幕密度" -MaximumLength 12
        Assert-LarkInventoryText -FieldName "电量" -Value $row."电量" -MaximumLength 4
        Assert-LarkInventoryText -FieldName "小红书版本" -Value $row."小红书版本" -MaximumLength 40
        Assert-LarkInventoryText -FieldName "采集时间" -Value $row."采集时间" -MaximumLength 32

        if ($row."安全补丁" -and ([string]$row."安全补丁") -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "安全补丁 must use yyyy-MM-dd" }
        if ($row."分辨率" -and ([string]$row."分辨率") -notmatch '^\d{2,5}x\d{2,5}$') { throw "分辨率 must use WIDTHxHEIGHT" }
        if ($row."屏幕密度" -and ([string]$row."屏幕密度") -notmatch '^\d{1,5}$') { throw "屏幕密度 must be an integer" }
        if ($row."电量" -and (([string]$row."电量") -notmatch '^\d{1,3}$' -or [int]$row."电量" -gt 100)) { throw "电量 must be between 0 and 100" }
        if ($row."小红书版本" -and ([string]$row."小红书版本") -notmatch '^[0-9A-Za-z._+-]{1,40}$') { throw "小红书版本 contains unexpected characters" }
        if (([string]$row."页面结构已采集") -notmatch '^(?i:true|false)$') { throw "页面结构已采集 must be a boolean" }
        $parsedCollectedAt = [datetime]::MinValue
        if (![datetime]::TryParseExact(
            [string]$row."采集时间",
            "yyyy-MM-dd HH:mm:ss",
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$parsedCollectedAt
        )) { throw "采集时间 must use yyyy-MM-dd HH:mm:ss" }
    }
    $true
}
