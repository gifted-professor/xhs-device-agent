param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][int]$CropX,
    [Parameter(Mandatory = $true)][int]$CropY,
    [Parameter(Mandatory = $true)][int]$CropWidth,
    [Parameter(Mandatory = $true)][int]$CropHeight
)

$ErrorActionPreference = "Stop"
if ($CropX -lt 0 -or $CropY -lt 0 -or $CropWidth -le 0 -or $CropHeight -le 0) {
    throw "Invalid bounded image crop"
}
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Bitmap]::FromFile((Resolve-Path -LiteralPath $ImagePath).Path)
$cropped = $null
$graphics = $null
try {
    if (($CropX + $CropWidth) -gt $source.Width -or ($CropY + $CropHeight) -gt $source.Height) {
        throw "Image crop is outside the source image"
    }
    $parent = Split-Path -Parent $OutputPath
    if (!$parent -or !(Test-Path -LiteralPath $parent -PathType Container)) { throw "Output directory is unavailable" }
    $cropped = New-Object System.Drawing.Bitmap($CropWidth, $CropHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($cropped)
    $destination = New-Object System.Drawing.Rectangle(0, 0, $CropWidth, $CropHeight)
    $sourceRectangle = New-Object System.Drawing.Rectangle($CropX, $CropY, $CropWidth, $CropHeight)
    $graphics.DrawImage($source, $destination, $sourceRectangle, [System.Drawing.GraphicsUnit]::Pixel)
    $cropped.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
} catch {
    Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
    throw
} finally {
    if ($graphics) { $graphics.Dispose() }
    if ($cropped) { $cropped.Dispose() }
    $source.Dispose()
}
