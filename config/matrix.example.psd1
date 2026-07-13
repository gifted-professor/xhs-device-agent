@{
    # Xiaowei/Green Arrow provides connection, projection and the visual group console.
    # The agent uses ADB for per-device actions and verification by default.
    AdbPath = "C:\\path\\to\\xiaowei\\tools\\adb.exe"

    Xiaowei = @{
        InstallRoot = "C:\\path\\to\\xiaowei"
        Executable = "C:\\path\\to\\xiaowei\\touping.exe"
        ApiEndpoint = "ws://127.0.0.1:22222/"
        # API access may be version- or membership-gated. It is used only after a successful probe.
        PreferApi = $false
    }

    # Put real serials only in ignored config/local.psd1. Never commit them.
    Devices = @{
        "ADB_SERIAL_01" = "device-01"
        "ADB_SERIAL_02" = "device-02"
    }

    # Groups contain ADB serials. Each phone still resolves its own screen and UI hierarchy.
    Groups = @{
        "all" = @("ADB_SERIAL_01", "ADB_SERIAL_02")
        "content" = @("ADB_SERIAL_01")
    }

    Xhs = @{
        PackageName = "com.xingin.xhs"
    }

    # Chinese search input prefers a native IME that has been approved and
    # calibrated per alias. Plain `adb shell input text` is used only to feed
    # ASCII pinyin into that native IME; the exact Chinese candidate and final
    # EditText echo must both be verified before search submission.
    TextInput = @{
        NativeIme = @{
            Enabled = $false
            HumanApproved = $false
            PreferredServices = @(
                "com.sohu.inputmethod.sogou.xiaomi/.SogouIME"
                "com.baidu.input_mi/.ImeService"
                "com.iflytek.inputmethod.miui/.FlyIME"
            )
            ApprovedAliases = @()
            CalibrationProbe = "测试"
            CalibrationPinyin = "ceshi"
            PerDevice = @{
                "device-01" = @{
                    PreferredService = "com.sohu.inputmethod.sogou.xiaomi/.SogouIME"
                    # Use SPACE only to commit the native IME's first candidate;
                    # the final EditText must still exactly equal the target.
                    AllowVerifiedFirstCandidate = $false
                }
            }
        }

        # Optional approved device-side Unicode bridge. This remains a fallback
        # when the native candidate path cannot produce an exact phrase.
        UnicodeIme = @{
            Enabled = $false
            HumanApproved = $false
            Action = "ADB_INPUT_B64"
            ExtraKey = "msg"
            ApprovedAliases = @()
        }
    }

    BaseToken = "replace-with-base-token"
    TableId = "replace-with-table-id"
}
