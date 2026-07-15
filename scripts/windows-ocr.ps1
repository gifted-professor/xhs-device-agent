param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,
    [int]$CropX = -1,
    [int]$CropY = -1,
    [int]$CropWidth = -1,
    [int]$CropHeight = -1,
    [ValidateSet("page_safety", "exact_text", "numeric_count")]
    [string]$Mode = "page_safety",
    [string]$ExpectedTextHash = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Wait-WinRt {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq "AsTask" -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}

function Normalize-ExactOcrText {
    param([AllowEmptyString()][string]$Value)
    $normalized = ([string]$Value).Normalize([System.Text.NormalizationForm]::FormKC)
    $normalized = [System.Text.RegularExpressions.Regex]::Replace($normalized, '\s+', ' ').Trim()
    $han = '[\u2E80-\u2FFF\u3007\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]'
    $letterOrNumber = '[\p{L}\p{N}]'
    $normalized = [System.Text.RegularExpressions.Regex]::Replace($normalized, "($han)\s+(?=$letterOrNumber)", '$1')
    [System.Text.RegularExpressions.Regex]::Replace($normalized, "($letterOrNumber)\s+(?=$han)", '$1')
}

function Get-TextSha256 {
    param([AllowEmptyString()][string]$Value)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes((Normalize-ExactOcrText $Value))
        -join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
    } finally {
        $sha.Dispose()
    }
}

$temporaryCropPath = $null
$stream = $null
$bitmap = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

    $resolved = (Resolve-Path -LiteralPath $ImagePath).Path
    $ocrImagePath = $resolved
    $exactMode = $ExpectedTextHash -ne ""
    $numericMode = $Mode -eq "numeric_count"
    if ($numericMode -and $exactMode) {
        throw "Numeric OCR cannot include an exact-text hash"
    }
    if ($exactMode -or $numericMode) {
        if ($exactMode -and ($ExpectedTextHash -notmatch '^[a-fA-F0-9]{64}$' -or $CropX -lt 0 -or $CropY -lt 0 -or $CropWidth -le 0 -or $CropHeight -le 0)) {
            throw "Invalid exact OCR request"
        }
        if ($numericMode -and ($CropX -lt 0 -or $CropY -lt 0 -or $CropWidth -le 0 -or $CropHeight -le 0)) {
            throw "Invalid numeric OCR request"
        }
        Add-Type -AssemblyName System.Drawing
        $source = [System.Drawing.Bitmap]::FromFile($resolved)
        $cropped = $null
        $graphics = $null
        try {
            if (($CropX + $CropWidth) -gt $source.Width -or ($CropY + $CropHeight) -gt $source.Height) {
                throw "OCR crop is outside the source image"
            }
            $cropped = New-Object System.Drawing.Bitmap($CropWidth, $CropHeight)
            $graphics = [System.Drawing.Graphics]::FromImage($cropped)
            $destination = New-Object System.Drawing.Rectangle(0, 0, $CropWidth, $CropHeight)
            $sourceRectangle = New-Object System.Drawing.Rectangle($CropX, $CropY, $CropWidth, $CropHeight)
            $graphics.DrawImage($source, $destination, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
            $temporaryCropPath = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-ocr-{0}.png" -f [guid]::NewGuid().ToString("N"))
            $cropped.Save($temporaryCropPath, [System.Drawing.Imaging.ImageFormat]::Png)
            $ocrImagePath = $temporaryCropPath
        } finally {
            if ($graphics) { $graphics.Dispose() }
            if ($cropped) { $cropped.Dispose() }
            $source.Dispose()
        }
    } elseif ($CropX -ne -1 -or $CropY -ne -1 -or $CropWidth -ne -1 -or $CropHeight -ne -1) {
        throw "Page OCR cannot use a crop"
    }

    $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ocrImagePath)) ([Windows.Storage.StorageFile])
    $stream = Wait-WinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (!$engine) { throw "OCR engine unavailable" }
    $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($result.Lines | ForEach-Object { $_.Text } | Where-Object { $_ })
    if ($exactMode) {
        $candidates = @([string]$result.Text) + $lines
        $matched = [bool]($candidates | Where-Object {
            (Get-TextSha256 ([string]$_)).Equals($ExpectedTextHash, [System.StringComparison]::OrdinalIgnoreCase)
        } | Select-Object -First 1)
        [ordered]@{ available = $true; matched = $matched } | ConvertTo-Json -Depth 2 -Compress
    } elseif ($numericMode) {
        $numericPattern = '(?<![\p{L}\p{N}])\d+(?:\.\d+)?\s*(?:\+|[kKwW\u4e07])?(?![\p{L}\p{N}])'
        $candidates = @(
            @([string]$result.Text) + $lines |
                ForEach-Object { [System.Text.RegularExpressions.Regex]::Matches([string]$_, $numericPattern) } |
                ForEach-Object { $_.Value -replace '\s+', '' } |
                Where-Object { $_ } |
                Select-Object -Unique -First 16
        )
        [ordered]@{ available = $true; candidates = $candidates } | ConvertTo-Json -Depth 3 -Compress
    } else {
        [ordered]@{ available = $true; text = [string]$result.Text; lines = $lines } | ConvertTo-Json -Depth 4 -Compress
    }
} catch {
    if ($ExpectedTextHash -ne "") {
        [ordered]@{ available = $false; matched = $false; error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 2 -Compress
    } elseif ($Mode -eq "numeric_count") {
        [ordered]@{ available = $false; candidates = @(); error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 3 -Compress
    } else {
        [ordered]@{ available = $false; text = ""; lines = @(); error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 4 -Compress
    }
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($temporaryCropPath) { Remove-Item -LiteralPath $temporaryCropPath -Force -ErrorAction SilentlyContinue }
}
