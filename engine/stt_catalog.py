"""Model download identities and local availability; no inference imports."""
import os
from pathlib import Path

REPO = 'handy-computer/cohere-transcribe-arabic-07-2026-gguf'
REVISION = '11a54d6895f94cce78d0ece142b8e552e7822539'
MODELS = {
    'qwen-ar-light': {
        'repo': 'handy-computer/Qwen3-ASR-0.6B-gguf',
        'revision': '7e7c69a577fa2725dfedbe34b5e999336e30a19b',
        'filename': 'Qwen3-ASR-0.6B-Q8_0.gguf',
        'size': 850423456,
        'sha256': 'f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8',
        'quant': 'Q8_0',
    },
    'cohere-ar-q5': {
        'filename': 'cohere-transcribe-arabic-07-2026-Q5_K_M.gguf',
        'size': 1770270112,
        'sha256': '55e61c9b047e36f0e084d367f6b0bfecc71a6a0527da6eea4f0c687f3584775f',
        'quant': 'Q5_K_M',
    },
    'cohere-ar-q8': {
        'filename': 'cohere-transcribe-arabic-07-2026-Q8_0.gguf',
        'size': 2410655136,
        'sha256': '910de5c9c57f9fd8a280e1701f9cd96f63768878c1ca9e4ecf23638a5e0fef16',
        'quant': 'Q8_0',
    },
}


def cache_path(name):
    base = Path(os.environ.get('HF_HUB_CACHE') or
                Path(os.environ.get('HF_HOME') or Path.home()/'.cache'/'huggingface')/'hub')
    spec = MODELS[name]
    return base / ('models--'+spec.get('repo', REPO).replace('/', '--')) / 'snapshots' / spec.get('revision', REVISION) / spec['filename']


def installed(name):
    path = cache_path(name)
    return path.is_file() and path.stat().st_size == MODELS[name]['size']
