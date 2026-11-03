$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$stage = Join-Path $projectRoot 'engine\build-character-native'
$archive = Join-Path $stage 'audio-v0.9.3-lib-windows-x64-vulkan-portable.zip'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri 'https://github.com/0xShug0/audio.cpp/releases/download/v0.9.3/audio-v0.9.3-lib-windows-x64-vulkan-portable.zip' -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant() -ne 'b4e5a66e0bda38daabfd00c0b0273a23f9789766a777b5247203f1d1ba2c1572') { throw 'Character runtime checksum mismatch.' }
$payload = Join-Path $stage 'payload'
Expand-Archive -LiteralPath $archive -DestinationPath $payload -Force
$target = Join-Path $projectRoot 'plugin\dist\character-native'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -LiteralPath (Join-Path $payload 'libs') -Filter '*.dll' | Copy-Item -Destination $target -Force
Copy-Item -LiteralPath (Join-Path $payload 'LICENSE') -Destination (Join-Path $target 'LICENSE-audio-cpp.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'engine\LICENSE-Chatterbox.txt') -Destination (Join-Path $target 'LICENSE-Chatterbox.txt') -Force
Write-Host 'Verified optional character voice runtime is ready.'
