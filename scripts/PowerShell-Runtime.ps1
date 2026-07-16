function Resolve-XhsPowerShellExecutable {
    [CmdletBinding()]
    param()

    $explicit = [string]$env:XHS_POWERSHELL_PATH
    if ($explicit.Trim()) {
        $command = Get-Command -Name $explicit.Trim() -ErrorAction SilentlyContinue
        if (!$command) { throw "XHS_POWERSHELL_PATH does not identify an available PowerShell executable" }
        return $command.Source
    }

    $candidates = @(
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\pwsh.exe" }),
        $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe" }),
        $(if ($env:ProgramW6432) { Join-Path $env:ProgramW6432 "PowerShell\7\pwsh.exe" }),
        $(if ($PSVersionTable.PSEdition -eq "Core") { Join-Path $PSHOME "pwsh.exe" })
    ) | Where-Object { $_ }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    $pwsh = Get-Command -Name "pwsh.exe" -ErrorAction SilentlyContinue
    if ($pwsh) { return $pwsh.Source }
    $legacy = Get-Command -Name "powershell.exe" -ErrorAction Stop
    return $legacy.Source
}
