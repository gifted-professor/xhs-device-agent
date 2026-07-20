function Import-Utf8PowerShellDataFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath
    )

    if (!(Get-Command -Name Import-PowerShellDataFile -ErrorAction SilentlyContinue)) {
        $utilityModule = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
        if (!(Test-Path -LiteralPath $utilityModule -PathType Leaf)) {
            throw "The PowerShell data-file module is unavailable in this runtime"
        }
        Import-Module -Name $utilityModule -ErrorAction Stop
    }

    $resolved = (Resolve-Path -LiteralPath $LiteralPath).Path
    $bytes = [System.IO.File]::ReadAllBytes($resolved)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    $hasUtf16Bom = $bytes.Length -ge 2 -and (
        ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or
        ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF)
    )
    if ($hasUtf8Bom -or $hasUtf16Bom) {
        return Import-PowerShellDataFile -LiteralPath $resolved
    }

    # Windows PowerShell 5.1 decodes a BOM-less .psd1 using the active ANSI
    # code page. Validate it as UTF-8, then import an ephemeral BOM-prefixed
    # copy so non-ASCII configuration values keep their exact contents.
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try {
        $contents = $strictUtf8.GetString($bytes)
    } catch {
        throw "PowerShell data file must be valid UTF-8 or include an encoding BOM: $LiteralPath"
    }

    $temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-utf8-data-{0}.psd1" -f [guid]::NewGuid().ToString("N"))
    try {
        [System.IO.File]::WriteAllText($temporary, $contents, (New-Object System.Text.UTF8Encoding($true)))
        return Import-PowerShellDataFile -LiteralPath $temporary
    } finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}
