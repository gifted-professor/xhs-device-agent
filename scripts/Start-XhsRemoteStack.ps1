$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

& (Join-Path $PSScriptRoot "Set-XiaoweiPrivateApi.ps1") -Mode Enable -RestartXiaowei -ElevatedChild
& (Join-Path $PSScriptRoot "Manage-XhsRemoteGateway.ps1") -Action Start -ElevatedChild
