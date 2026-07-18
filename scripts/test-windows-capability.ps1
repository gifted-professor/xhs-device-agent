$ErrorActionPreference = "Stop"
$ocrCaps = Get-WindowsCapability -Online | Where-Object { $_.Name -like "*OCR*" -or $_.Name -like "*Media*" }
Write-Host "OCR/Media capabilities:"
foreach ($cap in $ocrCaps) {
    Write-Host "$($cap.Name) = $($cap.State)"
}

$winVer = [System.Environment]::OSVersion.Version
Write-Host "OS Version: $($winVer.Major).$($winVer.Minor).$($winVer.Build)"

$isWin10 = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name ProductName).ProductName
Write-Host "Product: $isWin10"
