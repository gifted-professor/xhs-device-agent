@{
    # Xiaowei/Green Arrow provides connection, projection and the visual group console.
    # The agent uses ADB for per-device actions and verification by default.
    AdbPath = "C:\\path\\to\\xiaowei\\tools\\adb.exe"

    Xiaowei = @{
        InstallRoot = "C:\\path\\to\\xiaowei"
        Executable = "C:\\path\\to\\xiaowei\\touping.exe"
        ApiEndpoint = "ws://127.0.0.1:22222/"
        # Xiaowei capabilities are routed one action at a time. Keep the API
        # disabled until each named action has passed the guide's single-device
        # acceptance procedure for the installed Xiaowei version.
        Api = @{
            Enabled = $false
            AcceptedXiaoweiVersion = ""
            # Acceptance is per device profile. A canary result must never
            # authorize another phone implicitly.
            # Repeat the accepted phone's raw ADB identifier only in ignored
            # config/local.psd1. Remapping an alias then invalidates the canary.
            AcceptedDeviceSerialsByAlias = @{
                "device-01" = "ADB_SERIAL_01"
            }
            AcceptedActionsByAlias = @{
                "device-01" = @()
            }
        }

        # Arbitrary app launch/stop is not exposed. Add only packages that were
        # explicitly approved for this local device matrix.
        ApprovedAppPackages = @("com.xingin.xhs")

        # Optional direct Unicode text adapter. It temporarily selects an
        # explicitly approved Xiaowei bridge IME, calls inputText, verifies the
        # exact EditText echo in the research provider, then restores the prior
        # default IME. A successful API probe is required before enabling it.
        TextInput = @{
            Enabled = $false
            HumanApproved = $false
            ApprovedAliases = @()
            PreferredImeServices = @(
                "com.xiaowei.assistant/.keyboard.XwIME"
                "com.android.xwkeyboard/.XwIME"
            )
            # Pin one known bridge per alias; do not opportunistically choose a
            # different installed IME on another phone.
            PerDevice = @{
                "device-01" = @{
                    PreferredImeService = "com.android.xwkeyboard/.XwIME"
                    # Explicitly permits temporary enablement when the bridge
                    # is installed but disabled. The adapter restores the
                    # original enabled/default IME state on every exit path.
                    AllowTemporaryEnable = $false
                    # Keep UI hierarchy verification for builds that expose
                    # the real EditText value. Use local_ocr only when an exact
                    # device profile proves the hierarchy contains a fixed hint.
                    EchoVerification = "ui_text"
                }
            }
        }
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
        # XHS semantic actions are local operator capabilities, not Xiaowei
        # WebSocket action names. Keep them in this separate per-alias map.
        Interactions = @{
            AllowedActionsByAlias = @{
                "device-01" = @()
            }
        }
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
