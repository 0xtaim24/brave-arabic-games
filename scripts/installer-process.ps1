param([Parameter(Mandatory = $true)][string]$InstallDir)
$ErrorActionPreference = 'Stop'
try {
    $appFile = [IO.Path]::GetFullPath((Join-Path $InstallDir 'brave.exe'))
    # The browser has the same executable name. Never stop a process by name alone.
    $owned = @(Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
        $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $appFile, [StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($process in $owned) {
        if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
    }
    exit 0
} catch { exit 1 }
