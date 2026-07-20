@{
    # Store services and device aliases only; never store real serials here.
    InputMethod = @{
        Enabled = $false
        HumanApproved = $false
        RequireNativeChinese = $true
        RequireExactEcho = $true

        # Select an installed native service with a Chinese subtype in this order.
        PreferredServices = @(
            "com.sohu.inputmethod.sogou.xiaomi/.SogouIME"
            "com.baidu.input_mi/.ImeService"
            "com.iflytek.inputmethod.miui/.FlyIME"
        )

        # Language mode is IME-specific; do not assume a universal system API.
        ChineseMode = "calibrate-per-device"
        CalibrationProbe = "测试"
        CalibrationPinyin = "ceshi"
        ApprovedAliases = @()

        PerDevice = @{
            "DEVICE_ALIAS_01" = @{
                PreferredService = ""
                CalibrationStatus = "required"
                LastVerifiedAt = ""
                AllowVerifiedFirstCandidate = $false
                # Optional last resort when the IME does not expose its language key
                # to Android UI hierarchy. Calibrate separately on this exact device.
                ChineseModeToggle = $null
                # ChineseModeToggle = @{
                #     HumanApproved = $true
                #     ImeService = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME"
                #     X = 0; Y = 0
                #     DisplayWidth = 1080; DisplayHeight = 2400; DensityDpi = 440
                # }
            }
            "DEVICE_ALIAS_02" = @{
                PreferredService = ""
                CalibrationStatus = "required"
                LastVerifiedAt = ""
                AllowVerifiedFirstCandidate = $false
            }
        }
    }
}
