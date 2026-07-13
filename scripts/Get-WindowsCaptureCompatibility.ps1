param(
    [Nullable[int]]$BuildNumber,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
$minimumBuild = 20348

if ($null -eq $BuildNumber) {
    $windowsVersion = Get-ItemProperty -LiteralPath "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion"
    $BuildNumber = [int]$windowsVersion.CurrentBuild
}

$isBorderRequiredApiAvailable = $BuildNumber -ge $minimumBuild
$result = [ordered]@{
    windowsBuild = [int]$BuildNumber
    minimumBuild = $minimumBuild
    isBorderRequiredApiAvailable = $isBorderRequiredApiAvailable
    computerUseWindowScreenshotCompatible = $isBorderRequiredApiAvailable
    reasonCode = if ($isBorderRequiredApiAvailable) { "supported" } else { "windows_build_below_20348" }
    fallback = if ($isBorderRequiredApiAvailable) { "computer-use" } else { "adb-screenshot-and-ui-hierarchy" }
    visibleWindowCaptureAvailable = $true
    visibleWindowCaptureRecommended = !$isBorderRequiredApiAvailable
    visibleWindowCaptureScript = "scripts/Capture-VisibleWindow.ps1"
}

if ($AsJson) {
    $result | ConvertTo-Json -Compress
} else {
    [pscustomobject]$result
}
