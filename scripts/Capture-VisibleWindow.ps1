[CmdletBinding(DefaultParameterSetName = "Handle")]
param(
    [Parameter(Mandatory, ParameterSetName = "Handle")]
    [string]$WindowHandle,

    [Parameter(Mandatory, ParameterSetName = "Process")]
    [string]$ProcessName,

    [string]$OutputPath,
    [switch]$AsJson
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$captureRoot = Join-Path $projectRoot "data\windows-capture"

if (!("XhsDeviceAgent.VisibleWindowCapture" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace XhsDeviceAgent
{
    public static class VisibleWindowCapture
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(
            IntPtr hWnd,
            int attribute,
            out RECT value,
            int valueSize);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
    }
}
'@
}

function ConvertTo-WindowPointer {
    param([Parameter(Mandatory)][string]$Value)

    $numericValue = 0L
    if ($Value -match '^0[xX]([0-9a-fA-F]+)$') {
        $numericValue = [Convert]::ToInt64($matches[1], 16)
    } elseif (![long]::TryParse($Value, [ref]$numericValue)) {
        throw "WindowHandle must be a decimal or hexadecimal HWND"
    }

    if ($numericValue -le 0) { throw "WindowHandle must be greater than zero" }
    [IntPtr]::new($numericValue)
}

if ($PSCmdlet.ParameterSetName -eq "Process") {
    $windows = @(
        Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 }
    )
    if ($windows.Count -eq 0) {
        throw "No visible main window found for process '$ProcessName'"
    }
    if ($windows.Count -gt 1) {
        throw "More than one main window was found for process '$ProcessName'; pass -WindowHandle explicitly"
    }
    $windowPointer = $windows[0].MainWindowHandle
} else {
    $windowPointer = ConvertTo-WindowPointer -Value $WindowHandle
}

if (![XhsDeviceAgent.VisibleWindowCapture]::IsWindow($windowPointer)) {
    throw "The supplied window handle is no longer valid"
}
if (![XhsDeviceAgent.VisibleWindowCapture]::IsWindowVisible($windowPointer)) {
    throw "The target window is not visible"
}
if ([XhsDeviceAgent.VisibleWindowCapture]::IsIconic($windowPointer)) {
    throw "The target window is minimized; restore it before capture"
}

$foregroundWindow = [XhsDeviceAgent.VisibleWindowCapture]::GetForegroundWindow()
if ($foregroundWindow -ne $windowPointer) {
    throw "The target window must be in the foreground and unobscured before capture"
}

# Per-monitor DPI awareness keeps the Win32 rectangle and screen pixels in the
# same coordinate space. Failure is harmless when the host already selected a
# DPI mode before this script ran.
[void][XhsDeviceAgent.VisibleWindowCapture]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))

$rect = [XhsDeviceAgent.VisibleWindowCapture+RECT]::new()
$extendedFrameBounds = 9
$dwmResult = [XhsDeviceAgent.VisibleWindowCapture]::DwmGetWindowAttribute(
    $windowPointer,
    $extendedFrameBounds,
    [ref]$rect,
    [Runtime.InteropServices.Marshal]::SizeOf([type][XhsDeviceAgent.VisibleWindowCapture+RECT])
)
if ($dwmResult -ne 0 -and ![XhsDeviceAgent.VisibleWindowCapture]::GetWindowRect($windowPointer, [ref]$rect)) {
    throw "Windows could not read the target window bounds"
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "The target window has invalid bounds"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$virtualScreen = [System.Windows.Forms.SystemInformation]::VirtualScreen
if (
    $rect.Left -lt $virtualScreen.Left -or
    $rect.Top -lt $virtualScreen.Top -or
    $rect.Right -gt $virtualScreen.Right -or
    $rect.Bottom -gt $virtualScreen.Bottom
) {
    throw "The whole target window must be inside the visible desktop before capture"
}

New-Item -ItemType Directory -Force -Path $captureRoot | Out-Null
if (!$OutputPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
    $OutputPath = Join-Path $captureRoot "window-$($windowPointer.ToInt64())-$stamp.png"
} elseif (![IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $captureRoot $OutputPath
}

$resolvedCaptureRoot = [IO.Path]::GetFullPath($captureRoot).TrimEnd('\') + '\'
$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
if (!$resolvedOutputPath.StartsWith($resolvedCaptureRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must stay inside $captureRoot"
}
if ([IO.Path]::GetExtension($resolvedOutputPath) -ine ".png") {
    throw "OutputPath must use the .png extension"
}
if (Test-Path -LiteralPath $resolvedOutputPath) {
    throw "OutputPath already exists; choose a new runtime filename"
}

$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen(
        $rect.Left,
        $rect.Top,
        0,
        0,
        [System.Drawing.Size]::new($width, $height),
        [System.Drawing.CopyPixelOperation]::SourceCopy
    )
    $bitmap.Save($resolvedOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

$processId = 0
[void][XhsDeviceAgent.VisibleWindowCapture]::GetWindowThreadProcessId($windowPointer, [ref]$processId)
$titleBuffer = [Text.StringBuilder]::new(512)
[void][XhsDeviceAgent.VisibleWindowCapture]::GetWindowText($windowPointer, $titleBuffer, $titleBuffer.Capacity)
$hash = (Get-FileHash -LiteralPath $resolvedOutputPath -Algorithm SHA256).Hash.ToLowerInvariant()

$result = [ordered]@{
    captured = $true
    captureMode = "foreground-visible-window"
    outputPath = $resolvedOutputPath
    sha256 = $hash
    windowHandle = $windowPointer.ToInt64()
    processId = [int]$processId
    windowTitle = $titleBuffer.ToString()
    width = $width
    height = $height
}

if ($AsJson) {
    $result | ConvertTo-Json -Compress
} else {
    [pscustomobject]$result
}
