$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$stage = Join-Path $projectRoot 'engine\build-native'
$archive = Join-Path $stage 'transcribe-native-0.4.1-windows-x86_64-cpu-vulkan.tar.gz'
$url = 'https://github.com/handy-computer/transcribe.cpp/releases/download/v0.4.1/transcribe-native-0.4.1-windows-x86_64-cpu-vulkan.tar.gz'
$expectedHash = '272eb97795048ccb557c85bb9dd44c9e530e1c928443114c39816a8a5f76269d'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $url -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Native speech archive checksum mismatch.'
}
tar.exe -xzf $archive -C $stage
if ($LASTEXITCODE) { throw 'Could not extract native speech runtime.' }
$payload = Join-Path $stage 'transcribe-native-windows-x86_64-cpu-vulkan'
$target = Join-Path $projectRoot 'plugin\dist\stt-native'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -LiteralPath $payload | Copy-Item -Destination $target -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'data\bench-ar.wav') -Destination (Join-Path $target 'warmup-ar.wav') -Force
Write-Host 'Verified local speech runtime is ready.'
