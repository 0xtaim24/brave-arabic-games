# Builds engine/dist/patcher.exe (standalone, no Python needed on players' PCs).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot 'engine')
if (-not (Test-Path .venv)) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -q -r requirements.txt pyinstaller
if ($LASTEXITCODE) { throw 'Engine dependencies could not be installed' }
.\.venv\Scripts\pyinstaller.exe --noconfirm --onefile --name patcher --collect-all UnityPy patcher.py
if ($LASTEXITCODE) { throw 'Patcher build failed' }
.\.venv\Scripts\pyinstaller.exe --noconfirm --onefile --name supertts --collect-all supertonic --collect-all onnxruntime --collect-all faster_whisper --collect-all ctranslate2 --collect-all av --collect-all transcribe_cpp supertts.py
if ($LASTEXITCODE) { throw 'Speech helper build failed' }
New-Item -ItemType Directory -Path '..\plugin\dist' -Force | Out-Null
Copy-Item -LiteralPath 'dist\supertts.exe' -Destination '..\plugin\dist\supertts.exe' -Force
New-Item -ItemType Directory -Path '..\plugin\dist\licenses' -Force | Out-Null
& (Join-Path $PSScriptRoot 'scripts\prepare-stt-native.ps1')
Write-Host "Done: engine\dist\patcher.exe"


& (Join-Path $PSScriptRoot 'scripts\prepare-character-native.ps1')
