param(
    [Parameter(Mandatory = $true)]
    [string]$ImagePath,
    [int]$CropX = -1,
    [int]$CropY = -1,
    [int]$CropWidth = -1,
    [int]$CropHeight = -1,
    [ValidateSet("page_safety", "exact_text", "locate_text", "numeric_count", "currency_amount")]
    [string]$Mode = "page_safety",
    [string]$ExpectedTextHash = "",
    [switch]$RequireChinese
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

function Invoke-OcrFile {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)]$Engine
    )
    $localStream = $null
    $localBitmap = $null
    try {
        $localFile = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($LiteralPath)) ([Windows.Storage.StorageFile])
        $localStream = Wait-WinRt ($localFile.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $localDecoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($localStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $localBitmap = Wait-WinRt ($localDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        Wait-WinRt ($Engine.RecognizeAsync($localBitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally {
        if ($localBitmap) { $localBitmap.Dispose() }
        if ($localStream) { $localStream.Dispose() }
    }
}

function Get-LocateMatches {
    param(
        [Parameter(Mandatory = $true)]$OcrResult,
        [Parameter(Mandatory = $true)][string]$ExpectedHash,
        [int]$OffsetX = 0,
        [int]$OffsetY = 0,
        [double]$Scale = 1
    )
    $found = @()
    foreach ($line in @($OcrResult.Lines)) {
        $words = @($line.Words)
        if ((Get-TextSha256 ([string]$line.Text)).Equals($ExpectedHash, [System.StringComparison]::OrdinalIgnoreCase) -and $words.Count) {
            $found += [ordered]@{
                left = $OffsetX + [int][Math]::Floor((($words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum) / $Scale)
                top = $OffsetY + [int][Math]::Floor((($words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum) / $Scale)
                right = $OffsetX + [int][Math]::Ceiling((($words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum) / $Scale)
                bottom = $OffsetY + [int][Math]::Ceiling((($words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum) / $Scale)
            }
        }
        foreach ($word in $words) {
            if ((Get-TextSha256 ([string]$word.Text)).Equals($ExpectedHash, [System.StringComparison]::OrdinalIgnoreCase)) {
                $rect = $word.BoundingRect
                $found += [ordered]@{
                    left = $OffsetX + [int][Math]::Floor($rect.X / $Scale)
                    top = $OffsetY + [int][Math]::Floor($rect.Y / $Scale)
                    right = $OffsetX + [int][Math]::Ceiling(($rect.X + $rect.Width) / $Scale)
                    bottom = $OffsetY + [int][Math]::Ceiling(($rect.Y + $rect.Height) / $Scale)
                }
            }
        }
    }
    $found
}

$temporaryCropPath = $null
$temporaryTilePaths = @()
$stream = $null
$bitmap = $null
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    [void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    [void][Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

    $resolved = (Resolve-Path -LiteralPath $ImagePath).Path
    $ocrImagePath = $resolved
    $locateMode = $Mode -eq "locate_text"
    $exactMode = $ExpectedTextHash -ne "" -and !$locateMode
    $numericMode = $Mode -eq "numeric_count"
    $currencyMode = $Mode -eq "currency_amount"
    if (($numericMode -or $currencyMode) -and $ExpectedTextHash -ne "") {
        throw "Numeric OCR cannot include an exact-text hash"
    }
    if ($locateMode -and ($ExpectedTextHash -notmatch '^[a-fA-F0-9]{64}$' -or
        $CropX -ne -1 -or $CropY -ne -1 -or $CropWidth -ne -1 -or $CropHeight -ne -1)) {
        throw "Invalid locate-text OCR request"
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

    $engine = $null
    $chineseLanguage = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object {
        $_.LanguageTag -match '^zh(?:-|$)'
    } | Select-Object -First 1)
    if ($chineseLanguage.Count -eq 1) {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($chineseLanguage[0])
    }
    if ($RequireChinese -and !$engine) { throw "Chinese OCR recognizer unavailable" }
    if (!$engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (!$engine) { throw "OCR engine unavailable" }
    $result = Invoke-OcrFile -LiteralPath $ocrImagePath -Engine $engine
    $lines = @($result.Lines | ForEach-Object { $_.Text } | Where-Object { $_ })
    if ($locateMode) {
        Add-Type -AssemblyName System.Drawing
        $tileSource = [System.Drawing.Bitmap]::FromFile($resolved)
        try {
            $matches = @()
            $tileWidth = [int][Math]::Min($tileSource.Width, [Math]::Ceiling($tileSource.Width / 4) + 30)
            $tileHeight = [int][Math]::Min($tileSource.Height, [Math]::Ceiling($tileSource.Height / 5) + 20)
            for ($row = 0; $row -lt 5; $row++) {
                $tileTop = [int][Math]::Min(
                    [Math]::Floor(($tileSource.Height * $row) / 5),
                    $tileSource.Height - $tileHeight
                )
                for ($column = 0; $column -lt 4; $column++) {
                    $tileLeft = [int][Math]::Min(
                        [Math]::Floor(($tileSource.Width * $column) / 4),
                        $tileSource.Width - $tileWidth
                    )
                    $tile = New-Object System.Drawing.Bitmap($tileWidth, $tileHeight)
                    $tileGraphics = [System.Drawing.Graphics]::FromImage($tile)
                    try {
                        $destination = New-Object System.Drawing.Rectangle(0, 0, $tileWidth, $tileHeight)
                        $sourceRectangle = New-Object System.Drawing.Rectangle($tileLeft, $tileTop, $tileWidth, $tileHeight)
                        $tileGraphics.DrawImage($tileSource, $destination, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
                        $tilePath = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-ocr-tile-{0}.png" -f [guid]::NewGuid().ToString("N"))
                        $temporaryTilePaths += $tilePath
                        $tile.Save($tilePath, [System.Drawing.Imaging.ImageFormat]::Png)
                        $tileResult = Invoke-OcrFile -LiteralPath $tilePath -Engine $engine
                        $matches += @(Get-LocateMatches -OcrResult $tileResult -ExpectedHash $ExpectedTextHash -OffsetX $tileLeft -OffsetY $tileTop)
                    } finally {
                        $tileGraphics.Dispose()
                        $tile.Dispose()
                    }
                }
            }
            if (!$matches.Count) {
                $scale = 2
                for ($row = 0; $row -lt 5; $row++) {
                    $tileTop = [int][Math]::Min(
                        [Math]::Floor(($tileSource.Height * $row) / 5),
                        $tileSource.Height - $tileHeight
                    )
                    for ($column = 0; $column -lt 4; $column++) {
                        $tileLeft = [int][Math]::Min(
                            [Math]::Floor(($tileSource.Width * $column) / 4),
                            $tileSource.Width - $tileWidth
                        )
                        $scaledWidth = $tileWidth * $scale
                        $scaledHeight = $tileHeight * $scale
                        $tile = New-Object System.Drawing.Bitmap($scaledWidth, $scaledHeight)
                        $tileGraphics = [System.Drawing.Graphics]::FromImage($tile)
                        try {
                            $tileGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                            $tileGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                            $destination = New-Object System.Drawing.Rectangle(0, 0, $scaledWidth, $scaledHeight)
                            $sourceRectangle = New-Object System.Drawing.Rectangle($tileLeft, $tileTop, $tileWidth, $tileHeight)
                            $tileGraphics.DrawImage($tileSource, $destination, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
                            $tilePath = Join-Path ([System.IO.Path]::GetTempPath()) ("xhs-ocr-scaled-tile-{0}.png" -f [guid]::NewGuid().ToString("N"))
                            $temporaryTilePaths += $tilePath
                            $tile.Save($tilePath, [System.Drawing.Imaging.ImageFormat]::Png)
                            $tileResult = Invoke-OcrFile -LiteralPath $tilePath -Engine $engine
                            $matches += @(Get-LocateMatches -OcrResult $tileResult -ExpectedHash $ExpectedTextHash -OffsetX $tileLeft -OffsetY $tileTop -Scale $scale)
                        } finally {
                            $tileGraphics.Dispose()
                            $tile.Dispose()
                        }
                    }
                }
            }
        } finally {
            $tileSource.Dispose()
        }
        if (!$matches.Count) { $matches = @(Get-LocateMatches -OcrResult $result -ExpectedHash $ExpectedTextHash) }
        $unique = @($matches | Group-Object { "$($_.left),$($_.top),$($_.right),$($_.bottom)" } | ForEach-Object { $_.Group[0] } | Select-Object -First 16)
        [ordered]@{ available = $true; matches = $unique } | ConvertTo-Json -Depth 4 -Compress
    } elseif ($exactMode) {
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
    } elseif ($currencyMode) {
        $currencyPattern = '(?:(?:\u00A5|\uFFE5)\s*\d{1,12}(?:[\.,]\d{1,2})?|\d{1,12}(?:[\.,]\d{1,2})?\s*\u5143)'
        $candidates = @(
            @([string]$result.Text) + $lines |
                ForEach-Object { [System.Text.RegularExpressions.Regex]::Matches([string]$_, $currencyPattern) } |
                ForEach-Object { $_.Value.Normalize([System.Text.NormalizationForm]::FormKC) -replace '\s+', '' -replace ',', '.' } |
                Where-Object { $_ } |
                Select-Object -Unique -First 16
        )
        [ordered]@{ available = $true; candidates = $candidates } | ConvertTo-Json -Depth 3 -Compress
    } else {
        [ordered]@{ available = $true; text = [string]$result.Text; lines = $lines } | ConvertTo-Json -Depth 4 -Compress
    }
} catch {
    if ($Mode -eq "locate_text") {
        [ordered]@{ available = $false; matches = @(); error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 3 -Compress
    } elseif ($ExpectedTextHash -ne "") {
        [ordered]@{ available = $false; matched = $false; error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 2 -Compress
    } elseif ($Mode -in @("numeric_count", "currency_amount")) {
        [ordered]@{ available = $false; candidates = @(); error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 3 -Compress
    } else {
        [ordered]@{ available = $false; text = ""; lines = @(); error = "WINDOWS_OCR_UNAVAILABLE" } | ConvertTo-Json -Depth 4 -Compress
    }
} finally {
    if ($bitmap) { $bitmap.Dispose() }
    if ($stream) { $stream.Dispose() }
    if ($temporaryCropPath) { Remove-Item -LiteralPath $temporaryCropPath -Force -ErrorAction SilentlyContinue }
    foreach ($tilePath in $temporaryTilePaths) { Remove-Item -LiteralPath $tilePath -Force -ErrorAction SilentlyContinue }
}
