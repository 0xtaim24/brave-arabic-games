# Development and release

Windows x64, Node.js 20+, Python 3.12+, and the .NET SDK are used for builds. Players do not need these developer tools.

## Build and test

Run npm ci, then build-engine.ps1 in PowerShell. npm start launches the app; npm run dist builds an installer without publishing. Output is dist/.

The engine script freezes patcher.exe and supertts.exe and prepares pinned CPU/Vulkan libraries for recognition and character voices. Model weights remain optional user downloads.

C# binaries are committed because GitHub runners do not have the game. After modifying plugin sources, rebuild using plugin/build-plugin.ps1 with -Managed pointing to your legally installed game's Managed directory and -CecilDll pointing to plugin/dist/Mono.Cecil.dll. Commit the updated ArabicFix.dll and ArabicPatch.exe. Do not commit game assemblies.

Checks:
- node --test characters.test.js update-state.test.js
- engine/.venv/Scripts/python.exe -m unittest discover -s engine -p 'test_*.py'
- node scripts/verify-release.js
- npm run dist
- node scripts/verify-release.js dist

The audit checks stable version/tag consistency, privacy exclusions, plugin hashes, update metadata and installer SHA-512. Source tests do not establish dialect accuracy or game performance; test microphone recordings and calls too.

stt_corpus.py and stt_eval.py compare recognition on the same recordings. Synthetic benchmarks are only diagnostics. The bundled bench-ar.wav is a synthetic warm-up sample, not a custom character reference. Do not commit personal recordings or evaluation corpora.

## Publish

1. Update package.json and its lockfile to a stable version for public automatic updates. Update RELEASE_NOTES.md and README.
2. Run the checks, inspect the exact staged files and diff, and confirm no local profiles, portraits, reference voices, settings, credentials, game saves or game binaries are included.
3. Push the reviewed commit and a new matching tag, for example v1.3.1. Never move an existing release tag.
4. The workflow checks and builds, creates a draft release, attaches the installer, blockmap, latest.yml and SHA256SUMS.txt, then publishes the completed release as Latest. Monitor it before announcing availability.
5. Verify /releases/latest, manifest version and asset hashes. Test detection with the previous updater version.

GitHub Actions uses its repository-scoped automatic token. Players need no GitHub account or API token. Never embed publishing credentials in an installer.

## Update behavior

The 1.0.1 app already downloads newer stable releases on launch and installs on quit or through its button. Version 1.3.1 also checks every four hours while open. Offline clients check when opened with internet again.

Updating brave does not overwrite a running game. The app records the version applied to each game path and requests reapplication after updates. User libraries and settings are preserved. Model downloads and game patches are separate from app installation.

The installer uses a path-aware process check because its executable shares brave.exe with the Brave browser. Keep installer.nsh and installer-process.ps1: the hook also replaces legacy uninstallers during upgrades to avoid closing the browser.

## Architecture and data

- main.js, preload.js, renderer/: Electron UI, settings, updater and local IPC.
- characters.js: local profiles, consent validation and game installation.
- engine/patcher.py: backups, translation, prompts, assembly patching and restore.
- engine/supertts.py: local speech servers; stt_*.py and character_*.py implement backends.
- plugin/*.cs: game-side text shaping, voice, recognition and portrait animation.
- plugin/dist/: built plugin and patch tool; speech helper/runtime built separately.

A character is copied into the game's Character Creator directory and one owned brave-UUID identity is added to the game catalog. Removal preserves other characters. Trial mode saves and replaces only DailyCallers; it never publishes a full save.

Custom synthesis uses audio.cpp 0.9.3 and Chatterbox Multilingual V3, caches up to 24 phrases per character, and sends completed phrase chunks. This is not native token-streaming synthesis. Standard voices use Supertonic.

See THIRD_PARTY.md for provenance and licenses and README.md for user instructions, privacy, consent and limitations.
