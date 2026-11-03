# Builds plugin/dist: ArabicFix.dll (runs inside the game), ArabicPatch.exe (+Mono.Cecil.dll) that wires it into the game's DLLs.
# Needs: .NET SDK (csc), the game's Managed folder, and Mono.Cecil.dll (net35/net40 build, e.g. from a BepInEx 5 zip).
param(
  [Parameter(Mandatory = $true)][string]$Managed,
  [Parameter(Mandatory = $true)][string]$CecilDll
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$csc = (Get-ChildItem 'C:\Program Files\dotnet\sdk' -Recurse -Filter csc.dll | Select-Object -First 1).FullName
$dist = Join-Path $here 'dist'
# The speech helper/runtime also live here; rebuild only the plugin outputs.
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# 1) library that runs inside the game (compiled against the game's own mscorlib)
$refs = 'mscorlib', 'System', 'System.Core', 'UnityEngine.CoreModule', 'UnityEngine.UIElementsModule', 'UnityEngine.TextCoreTextEngineModule', 'UnityEngine.TextRenderingModule' |
  ForEach-Object { "-r:$Managed\$_.dll" }
dotnet $csc -noconfig -nostdlib -nologo -target:library -langversion:7.3 "-out:$dist\ArabicFix.dll" @refs "$here\ArabicFix.cs" "$here\ArabicTts.cs" "$here\ArabicStt.cs" "$here\ArabicPortrait.cs"
if ($LASTEXITCODE) { throw 'ArabicFix build failed' }

# 2) patcher (plain .NET Framework exe, runs on any Windows 10/11)
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
if ([System.IO.Path]::GetFullPath($CecilDll) -ne [System.IO.Path]::GetFullPath("$dist\Mono.Cecil.dll")) {
  Copy-Item -LiteralPath $CecilDll -Destination "$dist\Mono.Cecil.dll" -Force
  Copy-Item -LiteralPath (Join-Path (Split-Path $CecilDll) 'Mono.Cecil.Rocks.dll') -Destination "$dist\Mono.Cecil.Rocks.dll" -Force
}
dotnet $csc -noconfig -nostdlib -nologo -target:exe -langversion:7.3 "-out:$dist\ArabicPatch.exe" "-r:$fw\mscorlib.dll" "-r:$fw\System.dll" "-r:$fw\System.Core.dll" "-r:$dist\Mono.Cecil.dll" "-r:$dist\Mono.Cecil.Rocks.dll" "$here\ArabicPatch.cs"
if ($LASTEXITCODE) { throw 'ArabicPatch build failed' }
node (Join-Path $here '..\scripts\write-plugin-manifest.js')
if ($LASTEXITCODE) { throw 'Plugin manifest failed' }
Get-ChildItem $dist | Select-Object Name, Length

