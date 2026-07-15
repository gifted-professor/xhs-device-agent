function Get-TaskTextInputContext {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][object[]]$RuntimeDevices
    )

    $selectedAliases = @($RuntimeDevices | ForEach-Object { [string]$_.deviceAlias } | Select-Object -Unique)
    $selectedByAlias = @{}
    foreach ($device in $RuntimeDevices) { $selectedByAlias[[string]$device.deviceAlias] = [string]$device.serial }

    $unicode = if ($Config.TextInput -and $Config.TextInput.UnicodeIme) { $Config.TextInput.UnicodeIme } else { $null }
    $unicodeApproved = @()
    if ($unicode -and $unicode.Enabled -and $unicode.HumanApproved) {
        $unicodeApproved = @($unicode.ApprovedAliases | Where-Object { $selectedAliases -contains [string]$_ } | ForEach-Object { [string]$_ } | Select-Object -Unique)
    }

    $native = if ($Config.TextInput -and $Config.TextInput.NativeIme) { $Config.TextInput.NativeIme } elseif ($Config.InputMethod) { $Config.InputMethod } else { $null }
    $nativeApproved = @()
    if ($native -and $native.Enabled -and $native.HumanApproved) {
        $nativeApproved = @($native.ApprovedAliases | Where-Object { $selectedAliases -contains [string]$_ } | ForEach-Object { [string]$_ } | Select-Object -Unique)
    }
    $nativePerDevice = [ordered]@{}
    if ($native -and $native.PerDevice) {
        foreach ($alias in $nativeApproved) {
            if (!$native.PerDevice.ContainsKey($alias)) { continue }
            $profile = $native.PerDevice[$alias]
            $toggle = if ($profile.ChineseModeToggle) { $profile.ChineseModeToggle } else { $null }
            $nativePerDevice[$alias] = [ordered]@{
                preferredService = if ($profile.PreferredService) { [string]$profile.PreferredService } else { "" }
                preferredServices = if ($profile.PreferredServices) { @($profile.PreferredServices | ForEach-Object { [string]$_ } | Select-Object -Unique) } else { @() }
                allowVerifiedFirstCandidate = [bool]$profile.AllowVerifiedFirstCandidate
                chineseModeToggle = if ($toggle) { [ordered]@{
                    humanApproved = [bool]$toggle.HumanApproved
                    imeService = [string]$toggle.ImeService
                    x = [int]$toggle.X
                    y = [int]$toggle.Y
                    displayWidth = [int]$toggle.DisplayWidth
                    displayHeight = [int]$toggle.DisplayHeight
                    densityDpi = [int]$toggle.DensityDpi
                } } else { $null }
            }
        }
    }

    $xiaoweiInput = if ($Config.Xiaowei -and $Config.Xiaowei.TextInput) { $Config.Xiaowei.TextInput } else { $null }
    $xiaoweiApi = if ($Config.Xiaowei -and $Config.Xiaowei.Api) { $Config.Xiaowei.Api } else { $null }
    $acceptedActionsByAlias = [ordered]@{}
    $acceptedSerialsByAlias = [ordered]@{}
    $xiaoweiPerDevice = [ordered]@{}
    $xiaoweiApproved = @()
    $requiredActions = @("imeList", "selectIme", "inputText")
    $currentVersion = ""
    if ($Config.Xiaowei -and $Config.Xiaowei.Executable -and (Test-Path -LiteralPath $Config.Xiaowei.Executable -PathType Leaf)) {
        $currentVersion = [string](Get-Item -LiteralPath $Config.Xiaowei.Executable).VersionInfo.ProductVersion
    }
    $acceptedVersion = if ($xiaoweiApi -and $xiaoweiApi.AcceptedXiaoweiVersion) { [string]$xiaoweiApi.AcceptedXiaoweiVersion } else { "" }
    $baseXiaoweiEnabled = [bool]($xiaoweiInput -and $xiaoweiInput.Enabled -and $xiaoweiInput.HumanApproved -and
        $xiaoweiApi -and $xiaoweiApi.Enabled -and $acceptedVersion -and $currentVersion -and $acceptedVersion -ceq $currentVersion)
    if ($baseXiaoweiEnabled) {
        foreach ($aliasValue in @($xiaoweiInput.ApprovedAliases)) {
            $alias = [string]$aliasValue
            if ($selectedAliases -notcontains $alias) { continue }
            $actions = if ($xiaoweiApi.AcceptedActionsByAlias -and $xiaoweiApi.AcceptedActionsByAlias.ContainsKey($alias)) {
                @($xiaoweiApi.AcceptedActionsByAlias[$alias] | ForEach-Object { [string]$_ } | Select-Object -Unique)
            } else { @() }
            $acceptedSerial = if ($xiaoweiApi.AcceptedDeviceSerialsByAlias -and $xiaoweiApi.AcceptedDeviceSerialsByAlias.ContainsKey($alias)) {
                [string]$xiaoweiApi.AcceptedDeviceSerialsByAlias[$alias]
            } else { "" }
            if (@($requiredActions | Where-Object { $actions -notcontains $_ }).Count -or $acceptedSerial -cne $selectedByAlias[$alias]) { continue }
            if (!$xiaoweiInput.PerDevice -or !$xiaoweiInput.PerDevice.ContainsKey($alias)) { continue }
            $profile = $xiaoweiInput.PerDevice[$alias]
            $echo = if ($profile.ContainsKey("EchoVerification")) { [string]$profile.EchoVerification } else { "" }
            if ($echo -notin @("ui_text", "local_ocr") -or !$profile.ContainsKey("AllowTemporaryEnable")) { continue }
            $acceptedActionsByAlias[$alias] = $actions
            $acceptedSerialsByAlias[$alias] = $acceptedSerial
            $xiaoweiPerDevice[$alias] = [ordered]@{
                preferredImeService = [string]$profile.PreferredImeService
                allowTemporaryEnable = [bool]$profile.AllowTemporaryEnable
                echoVerification = $echo
            }
            $xiaoweiApproved += $alias
        }
    }

    $preferredXiaoweiServices = if ($xiaoweiInput -and $xiaoweiInput.PreferredImeServices) {
        @($xiaoweiInput.PreferredImeServices | ForEach-Object { [string]$_ } | Select-Object -Unique)
    } else { @() }

    return [ordered]@{
        unicodeInput = [ordered]@{
            enabled = [bool]($unicodeApproved.Count -gt 0)
            action = if ($unicode -and $unicode.Action) { [string]$unicode.Action } else { "ADB_INPUT_B64" }
            extraKey = if ($unicode -and $unicode.ExtraKey) { [string]$unicode.ExtraKey } else { "msg" }
            approvedAliases = $unicodeApproved
        }
        nativeIme = [ordered]@{
            enabled = [bool]($nativeApproved.Count -gt 0)
            humanApproved = [bool]($native -and $native.HumanApproved)
            preferredServices = if ($native -and $native.PreferredServices) { @($native.PreferredServices | ForEach-Object { [string]$_ } | Select-Object -Unique) } else { @() }
            approvedAliases = $nativeApproved
            calibrationProbe = if ($native -and $native.CalibrationProbe) { [string]$native.CalibrationProbe } else { "测试" }
            calibrationPinyin = if ($native -and $native.CalibrationPinyin) { [string]$native.CalibrationPinyin } else { "ceshi" }
            perDevice = $nativePerDevice
        }
        xiaowei = [ordered]@{
            endpoint = if ($Config.Xiaowei -and $Config.Xiaowei.ApiEndpoint) { [string]$Config.Xiaowei.ApiEndpoint } else { "ws://127.0.0.1:22222/" }
            api = [ordered]@{
                enabled = [bool]($xiaoweiApproved.Count -gt 0)
                acceptedActions = $requiredActions
                acceptedActionsByAlias = $acceptedActionsByAlias
                acceptedDeviceSerialsByAlias = $acceptedSerialsByAlias
                acceptedXiaoweiVersion = $acceptedVersion
                currentXiaoweiVersion = $currentVersion
            }
            textInput = [ordered]@{
                enabled = [bool]($xiaoweiApproved.Count -gt 0)
                humanApproved = [bool]($xiaoweiInput -and $xiaoweiInput.HumanApproved)
                approvedAliases = @($xiaoweiApproved | Select-Object -Unique)
                preferredImeServices = $preferredXiaoweiServices
                perDevice = $xiaoweiPerDevice
            }
        }
    }
}

function Test-TaskQueryInputCapability {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Query,
        [Parameter(Mandatory = $true)]$TextInputContext,
        [Parameter(Mandatory = $true)][string[]]$DeviceAliases
    )
    if ($Query -notmatch '[^\x00-\x7F]') { return $true }
    foreach ($alias in $DeviceAliases) {
        $supported = @($TextInputContext.unicodeInput.approvedAliases) -contains $alias
        $supported = $supported -or (@($TextInputContext.nativeIme.approvedAliases) -contains $alias)
        $supported = $supported -or (@($TextInputContext.xiaowei.textInput.approvedAliases) -contains $alias)
        if (!$supported) { return $false }
    }
    return $true
}
