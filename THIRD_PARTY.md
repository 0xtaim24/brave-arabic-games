# Third-party components

## Local character voices (1.3)

Chatterbox Multilingual V3 (Resemble AI, MIT): https://huggingface.co/ResembleAI/chatterbox
Native runtime audio.cpp 0.9.3 (MIT): https://github.com/0xShug0/audio.cpp/tree/v0.9.3
The runtime is shipped under `fix/character-native`, including its license and the Chatterbox license.
The optional Q8 GGUF downloads from `audio-cpp/audio.cpp-gguf`, revision
`874fcb41ececda20bcbc0782d6b4ea7f7d069ea8`, SHA-256
`45d71d8d248ba831014813bbbbba74c7d786dd9447c02090fe05c44344f69453`.
The model is not bundled. The explicit setup action verifies its hash before use.
Our wrappers provide persistent sessions, bounded imports and a local generated-phrase cache.
Reference voices and portraits belong to the user's local library and are not included in the installer.

brave bundles or downloads the following. Check each license before redistributing.

| Component | Used for | License |
|---|---|---|
| Electron, electron-builder, electron-updater | app shell, installer, auto update | MIT |
| Lucide icons | UI icons | ISC |
| IBM Plex Sans Arabic, Tajawal (via Fontsource) | UI fonts | SIL OFL 1.1 |
| UnityPy, dnfile | editing Unity asset bundles / reading .NET metadata | MIT |
| Mono.Cecil | patching the game's .NET assemblies | MIT |
| PyInstaller | packaging the helpers | GPL-2.0 with bootloader exception |
| Supertonic 3 (supertonic) | local Arabic text-to-speech | code: MIT. **Model weights: check the license on the model page before redistributing** |
| faster-whisper, CTranslate2 | local speech recognition | MIT |
| OpenAI Whisper model weights (downloaded at first use) | speech recognition | MIT |
| ONNX Runtime, NumPy, PyAV | inference / audio | MIT / BSD / BSD |

## Not included
brave does **not** contain any file from *Scam With Your Friends*. It edits the copy installed on the user's own PC and keeps a
backup of every file it changes. It is a community project and is not affiliated with or endorsed by the game's developer.
# Local Arabic recognition added in 1.2

- **Cohere Transcribe Arabic 07-2026**: Apache-2.0, Cohere Labs.
  Upstream: https://huggingface.co/CohereLabs/cohere-transcribe-arabic-07-2026
  GGUF conversions: https://huggingface.co/handy-computer/cohere-transcribe-arabic-07-2026-gguf
  Pinned conversion revision: `11a54d6895f94cce78d0ece142b8e552e7822539`.
  Q5_K_M and Q8_0 weights are optional downloads, not included in the installer.
- **transcribe.cpp 0.4.1** and Python bindings: MIT.
  https://github.com/handy-computer/transcribe.cpp/tree/v0.4.1
  Windows CPU/Vulkan native libraries and their original license files ship under
  `stt-native`. Vendored ggml and other component licenses are retained there.
  Cohere does not expose a calibrated confidence score through this runtime:
  diagnostics use null, and the legacy game protocol uses -1 (unavailable).

Public evaluation recordings (FLEURS and Casablanca) are not included in the
application or source update. Reported sample results are not general accuracy guarantees.

- **Qwen3-ASR-0.6B**: Apache-2.0, Qwen / Alibaba.
  https://huggingface.co/Qwen/Qwen3-ASR-0.6B
  Optional Q8_0 conversion: https://huggingface.co/handy-computer/Qwen3-ASR-0.6B-gguf
  Revision `7e7c69a577fa2725dfedbe34b5e999336e30a19b`.
  A lower-memory alternative; small-sample dialect results were mixed, so this is
  not presented as an accuracy upgrade over Cohere.
