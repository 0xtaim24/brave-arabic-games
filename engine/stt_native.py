"""Pinned offline Cohere Arabic models on transcribe.cpp (CPU / Vulkan).

Native libraries ship beside the helper. Model downloads only happen in the
explicit installer, never while recognizing the microphone.
"""
import hashlib
import os
from pathlib import Path
import sys

from stt_catalog import MODELS, REPO, REVISION, cache_path, installed
_dll_handles = []


def install(name):
    from huggingface_hub import hf_hub_download
    spec = MODELS[name]
    path = Path(hf_hub_download(spec.get('repo', REPO), spec['filename'], revision=spec.get('revision', REVISION)))
    with path.open('rb') as f:
        digest = hashlib.file_digest(f, 'sha256').hexdigest()
    if digest != spec['sha256']:
        raise RuntimeError('Speech model checksum mismatch. Please download the model again.')
    return path


def library():
    base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent/'plugin'/'dist'
    root = Path(os.environ.get('ARABICAI_STT_NATIVE_DIR') or base/'stt-native')
    dll = root / 'transcribe.dll'
    if not dll.is_file():
        raise RuntimeError('The local Cohere engine is missing. Reinstall or reapply the application.')
    if not _dll_handles and sys.platform == 'win32':
        _dll_handles.append(os.add_dll_directory(str(root)))
    os.environ['TRANSCRIBE_LIBRARY'] = str(dll)
    import transcribe_cpp
    return transcribe_cpp


class NativeModel:
    def __init__(self, tc, path, device, threads):
        self._model = tc.Model(path, device=device)
        try:
            self._session = self._model.session(n_threads=threads)
        except Exception:
            self._model.close()
            raise

    def decode_pcm(self, pcm, language):
        return self._session.run(pcm, language=language or 'ar', timestamps='none').text.strip()

    def close(self):
        if getattr(self, '_session', None) is not None:
            self._session.close()
            self._session = None
        if getattr(self, '_model', None) is not None:
            self._model.close()
            self._model = None


def load_model(name, threads=4, device='auto', allow_download=False):
    import numpy as np
    if name not in MODELS:
        raise ValueError('Unknown native speech model')
    path = install(name) if allow_download else cache_path(name)
    if not path.is_file() or path.stat().st_size != MODELS[name]['size']:
        raise RuntimeError('Download the selected local speech model from Models first.')
    tc = library()
    devices = tc.backends()
    # Leave room for activations and the game; do not rely on slow shared VRAM.
    gpu = [d for d in devices if d.device_type == 'gpu' and d.memory_free >= MODELS[name]['size'] + 600*1024*1024]
    gpu.sort(key=lambda d: d.memory_free, reverse=True)
    cpu = [d for d in devices if d.device_type == 'cpu']
    candidates = cpu if device == 'cpu' else gpu + cpu if device == 'auto' else [d for d in gpu if d.kind == device]
    errors = []
    for target in candidates:
        model = None
        try:
            model = NativeModel(tc, path, target, threads)
            # Prime both encoder and multi-token decoder before announcing READY.
            import wave
            warm_path = Path(os.environ['TRANSCRIBE_LIBRARY']).parent / 'warmup-ar.wav'
            if warm_path.is_file():
                with wave.open(str(warm_path)) as wav:
                    warm = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)/32768.0
            else:
                warm = np.zeros(16000, dtype=np.float32)
            model.decode_pcm(warm, 'ar')
            return model, {'engine': 'transcribe.cpp', 'device': model._model.device.kind,
                'device_name': model._model.device.description, 'compute_type': MODELS[name]['quant'],
                'threads': threads, 'model': name, 'fallback': errors,
                'confidence_available': False}
        except Exception as exc:
            if model is not None:
                model.close()
            errors.append(f'{target.kind}: {str(exc)[:200]}')
    raise RuntimeError('Could not start local recognition: ' + ' | '.join(errors))
