Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
Write-Host "Count: $($langs.Count)"
foreach ($l in $langs) {
    Write-Host $l.LanguageTag
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($engine) {
    Write-Host "Engine OK"
} else {
    Write-Host "Engine FAIL"
}
