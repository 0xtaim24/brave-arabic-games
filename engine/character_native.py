"""Pinned audio.cpp C ABI for optional local Chatterbox Multilingual V3 voices."""
import ctypes as c
import hashlib
import os
from pathlib import Path
import sys

import numpy as np

REVISION = '874fcb41ececda20bcbc0782d6b4ea7f7d069ea8'
FILENAME = 'Chatterbox-GGUF/chatterbox-q8_0.gguf'
SIZE = 2088399204
SHA256 = '45d71d8d248ba831014813bbbbba74c7d786dd9447c02090fe05c44344f69453'


def model_root():
    return Path(os.environ.get('APPDATA', Path.home()/'AppData/Roaming'))/'brave/models/character-voice'


def model_path():
    return model_root()/FILENAME


def installed():
    p = model_path()
    return p.is_file() and p.stat().st_size == SIZE


def install():
    from huggingface_hub import hf_hub_download
    p = Path(hf_hub_download('audio-cpp/audio.cpp-gguf', FILENAME, revision=REVISION, local_dir=str(model_root())))
    with p.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != SHA256:
            raise RuntimeError('لم يكتمل نموذج الصوت بشكل سليم. أعد تنزيله.')
    return {'installed': True, 'size': SIZE}


P = c.c_void_p
S = c.c_char_p
F = c.POINTER(c.c_float)


class ModelConfig(c.Structure):
    _fields_ = [('family', S), ('config', S), ('weight', S), ('spec', S)]


class BackendConfig(c.Structure):
    _fields_ = [('backend', S), ('device', c.c_int), ('threads', c.c_int)]


class NativeVoice:
    def __init__(self, quality='balanced'):
        self.quality = 'fast' if quality == 'fast' else 'balanced'
        if not installed():
            raise RuntimeError('نزّل نموذج الصوت المخصص من صفحة الشخصيات أولًا (2.1 جيجابايت).')
        base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent/'plugin/dist'
        root = Path(os.environ.get('ARABICAI_CHARACTER_NATIVE_DIR') or base/'character-native')
        if not (root/'audiocpp.dll').is_file():
            raise RuntimeError('محرك الصوت المخصص غير موجود. أعد تطبيق التحسينات.')
        self.dll_directory = os.add_dll_directory(str(root)) if sys.platform == 'win32' else None
        self.lib = c.CDLL(str(root/'audiocpp.dll'))
        self.registry, self.model, self.session = P(), P(), P()
        signatures = {
            'abi_version': (c.c_uint32, []), 'last_error': (S, []),
            'registry_create': (c.c_int, [S, c.POINTER(P)]), 'registry_free': (None, [P]),
            'model_load': (c.c_int, [P, S, c.POINTER(ModelConfig), P, c.POINTER(P)]), 'model_free': (None, [P]),
            'options_create': (P, []), 'options_set': (c.c_int, [P, S, S]), 'options_free': (None, [P]),
            'session_create': (c.c_int, [P, S, S, c.POINTER(BackendConfig), P, c.POINTER(P)]),
            'session_free': (None, [P]), 'session_run': (c.c_int, [P, P, c.POINTER(P)]),
            'request_create': (P, []), 'request_free': (None, [P]),
            'request_set_text': (c.c_int, [P, S, S]), 'request_set_option': (c.c_int, [P, S, S]),
            'request_set_voice_audio': (c.c_int, [P, F, c.c_size_t, c.c_int, c.c_int]),
            'result_audio': (c.c_int, [P, c.POINTER(F), c.POINTER(c.c_size_t), c.POINTER(c.c_int), c.POINTER(c.c_int)]),
            'result_free': (None, [P]),
        }
        for name, (result, args) in signatures.items():
            fn = getattr(self.lib, 'audiocpp_'+name); fn.restype = result; fn.argtypes = args
            setattr(self, name, fn)
        if self.abi_version() != 0x200:
            raise RuntimeError('Unsupported character voice runtime ABI')
        try:
            self.check(self.registry_create(None, c.byref(self.registry)))
            config = ModelConfig(b'chatterbox', None, None, b'embedded')
            self.check(self.model_load(self.registry, str(model_path()).encode('utf-8'), c.byref(config), None, c.byref(self.model)))
            options = self.options_create()
            try:
                self.check(self.options_set(options, b'multilingual_t3', b'v3'))
                self.check(self.options_set(options, b'conditionals_cache_slots', b'1'))
                backend, device = self.choose_backend()
                threads = max(1, min(8, int(os.environ.get('SUPERTONIC_INTRA_OP_THREADS', '4'))))
                for candidate in dict.fromkeys([backend, 'cpu']):
                    cfg = BackendConfig(candidate.encode(), device if candidate != 'cpu' else 0, threads)
                    code = self.session_create(self.model, b'clon', b'offline', c.byref(cfg), options, c.byref(self.session))
                    if code == 0:
                        self.backend = candidate; break
                    self.session_free(self.session); self.session = P()
                    if candidate == 'cpu': self.check(code)
            finally:
                self.options_free(options)
        except Exception:
            self.close(); raise

    @staticmethod
    def choose_backend():
        if os.environ.get('ARABICAI_CHARACTER_DEVICE') == 'cpu': return 'cpu', 0
        try:
            from stt_native import library
            devices = [d for d in library().backends() if d.device_type == 'gpu' and d.kind == 'vulkan' and d.memory_free >= 2800*1024*1024]
            if devices: return 'vulkan', devices[0].index
        except Exception:
            pass
        return 'cpu', 0

    def check(self, code):
        if code:
            message = self.last_error().decode('utf-8', 'replace')
            raise RuntimeError('تعذّر توليد الصوت المخصص: '+message[:600])

    def close(self):
        for name in ('session', 'model', 'registry'):
            handle = getattr(self, name, None)
            if handle: getattr(self, name+'_free')(handle); setattr(self, name, P())

    def generate(self, text, reference, rate):
        request, result = self.request_create(), P()
        try:
            self.check(self.request_set_text(request, text.encode('utf-8'), b'ar'))
            audio = np.ascontiguousarray(reference, dtype=np.float32)
            if audio.ndim == 1: audio = audio[:, None]
            self.check(self.request_set_voice_audio(request, audio.ctypes.data_as(F), len(audio), rate, audio.shape[1]))
            for key, value in {'seed':'42', 'max_tokens':'384', 'temperature':'0.8', 'exaggeration':'0.5', 'guidance_scale':'0' if self.quality == 'fast' else '0.5'}.items():
                self.check(self.request_set_option(request, key.encode(), value.encode()))
            self.check(self.session_run(self.session, request, c.byref(result)))
            samples, frames, sr, channels = F(), c.c_size_t(), c.c_int(), c.c_int()
            self.check(self.result_audio(result, c.byref(samples), c.byref(frames), c.byref(sr), c.byref(channels)))
            if not 8000 <= sr.value <= 96000 or not 1 <= channels.value <= 2 or not 0 < frames.value <= sr.value*60:
                raise RuntimeError('Invalid character audio output')
            output = np.ctypeslib.as_array(samples, shape=(frames.value*channels.value,)).copy().reshape(-1,channels.value).mean(axis=1)
            if not np.isfinite(output).all(): raise RuntimeError('Invalid character audio samples')
            return output, sr.value
        finally:
            self.result_free(result); self.request_free(request)
