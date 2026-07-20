$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$projectRoot = $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$previousGatewayKey = $env:XHS_XIAOWEI_GATEWAY_KEY
$gatewayKeyBytes = New-Object byte[] 32
$gatewayRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $gatewayRng.GetBytes($gatewayKeyBytes)
} finally {
    $gatewayRng.Dispose()
}
$env:XHS_XIAOWEI_GATEWAY_KEY = [Convert]::ToBase64String($gatewayKeyBytes)
$exitCode = 1
try {
    & $node (Join-Path $projectRoot "scripts\xhs-agent.mjs") @args
    $exitCode = $LASTEXITCODE
} finally {
    [Array]::Clear($gatewayKeyBytes, 0, $gatewayKeyBytes.Length)
    if ($null -eq $previousGatewayKey) {
        Remove-Item Env:XHS_XIAOWEI_GATEWAY_KEY -ErrorAction SilentlyContinue
    } else {
        $env:XHS_XIAOWEI_GATEWAY_KEY = $previousGatewayKey
    }
}
exit $exitCode
