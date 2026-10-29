# Builds engine/dist/patcher.exe (standalone, no Python needed on players' PCs).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot 'engine')
if (-not (Test-Path .venv)) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -q -r requirements.txt pyinstaller
.\.venv\Scripts\pyinstaller.exe --onefile --name patcher --collect-all UnityPy patcher.py
Write-Host "Done: engine\dist\patcher.exe"

