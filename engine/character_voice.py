"""Consent-backed local character voices. No audio uploads; downloads require the explicit setup action."""
import json
import os
import re
import hashlib
import threading
import time
import wave
from pathlib import Path

import numpy as np

ID = re.compile(r'brave-[a-f0-9]{32}\Z')
_runtime = None
_native_lock = threading.RLock()


def runtime(quality):
    global _runtime
    from character_native import NativeVoice
    if _runtime is not None and _runtime.quality != quality:
        _runtime.close(); _runtime = None
    if _runtime is None: _runtime = NativeVoice(quality)
    return _runtime


def tempo(audio, rate, speed):
    """Speed up speech without shifting the speaker's pitch."""
    if abs(speed-1) < .001: return audio
    import av
    from fractions import Fraction
    graph = av.filter.Graph()
    source = graph.add_abuffer(sample_rate=rate, format='fltp', layout='mono', time_base=Fraction(1, rate))
    effect = graph.add('atempo', str(speed)); sink = graph.add('abuffersink')
    source.link_to(effect); effect.link_to(sink); graph.configure()
    frame = av.AudioFrame.from_ndarray(np.asarray(audio,dtype=np.float32).reshape(1,-1), format='fltp', layout='mono')
    frame.sample_rate=rate;frame.time_base=Fraction(1,rate);frame.pts=0
    graph.push(frame);graph.push(None);pieces=[]
    while True:
        try: pieces.append(graph.pull().to_ndarray().reshape(-1))
        except (av.error.EOFError, av.error.BlockingIOError): break
    return np.concatenate(pieces) if pieces else audio


def speech_chunks(text):
    # A substantial first phrase avoids a long gap while the next one renders.
    chunks=[]
    while len(text)>90:
        points=[m.end() for m in re.finditer(r'[،,؛;.!؟?]\s+', text[:81]) if m.end()>=45]
        end=points[-1] if points else text.rfind(' ',45,81)
        if end<1: break
        chunks.append(text[:end].strip());text=text[end:].strip()
    if text: chunks.append(text)
    return chunks


def character_directory(identity):
    if not ID.fullmatch(str(identity)):
        raise ValueError('Invalid character identifier')
    root = Path(os.environ.get('ARABICAI_CHARACTERS_DIR') or
                Path.home() / 'AppData/LocalLow/Jatater Worldwide/Scam With Your Friends/Character Creator').resolve()
    directory = (root / identity).resolve()
    if directory.parent != root:
        raise ValueError('Character path escapes its library')
    return directory


def profile(identity):
    directory = character_directory(identity)
    data = json.loads((directory / 'brave-character.json').read_text(encoding='utf-8-sig'))
    if data.get('id') != identity or data.get('voiceMode') not in ('clone', 'preset'):
        raise ValueError('Invalid character voice profile')
    if data['voiceMode'] == 'clone' and data.get('voiceConsent') is not True:
        raise ValueError('Permission to use the reference voice is required')
    return data


def write_wav(file, audio, rate=48000):
    x = np.asarray(audio, dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    if not np.isfinite(x).all():
        raise ValueError('Invalid audio samples')
    with wave.open(str(file), 'wb') as output:
        output.setnchannels(x.shape[1]); output.setsampwidth(2); output.setframerate(rate)
        output.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())


def prepare_reference(source, output):
    import av
    if Path(source).stat().st_size > 100 * 1024 * 1024:
        raise ValueError('اختر تسجيلًا قصيرًا بحجم أقل من 100 ميجابايت.')
    pieces, samples, rate = [], 0, 48000
    with av.open(str(source)) as container:
        resampler = av.AudioResampler(format='s16', layout='stereo', rate=rate)
        for frame in container.decode(audio=0):
            for converted in resampler.resample(frame):
                piece = converted.to_ndarray().reshape(-1, 2).astype(np.float32) / 32768
                pieces.append(piece); samples += len(piece)
            if samples >= rate * 15:
                break
        for converted in resampler.resample(None):
            pieces.append(converted.to_ndarray().reshape(-1, 2).astype(np.float32) / 32768)
    if not pieces:
        raise ValueError('لم أجد صوتًا في الملف.')
    audio = np.concatenate(pieces)[:rate*15]
    mono = audio.mean(axis=1)
    active = np.flatnonzero(np.abs(mono) > max(.006, float(np.max(np.abs(mono))) * .025))
    if not len(active):
        raise ValueError('التسجيل صامت أو منخفض جدًا.')
    audio = audio[max(0, active[0]-rate//10):min(len(audio), active[-1]+rate//5)]
    if len(audio) < rate * 2:
        raise ValueError('نحتاج ثانيتين على الأقل من الكلام الواضح، والأفضل 6 إلى 12 ثانية.')
    audio *= min(3.0, .9 / max(.01, float(np.max(np.abs(audio)))))
    write_wav(output, audio)
    return {'seconds': round(len(audio)/rate, 2), 'sample_rate': rate}


def synthesize_clone(identity, text, on_audio=None, prime=False):
    data = profile(identity)
    if data['voiceMode'] != 'clone':
        raise ValueError('This character uses a preset voice')
    text = re.sub(r'<[^>]{0,80}>', '', str(text)).strip()
    if not text or len(text) > 500:
        raise ValueError('استخدم جملة قصيرة للصوت المستنسخ.')
    speed = max(1.0,min(1.3,float(data.get('voiceSpeed',1))))
    quality = 'fast' if data.get('voiceQuality') == 'fast' else 'balanced'
    started=time.monotonic();first_audio=None
    directory = character_directory(identity)
    source = directory / 'reference.wav'
    reference_bytes = source.read_bytes()
    if len(reference_bytes) > 4*1024*1024:
        raise ValueError('Reference audio is too large')
    version = b'chatterbox-v3-q8-seed42-v1' if quality=='balanced' else b'chatterbox-v3-q8-cfg0-chunks-v2'
    digest = hashlib.sha256(version + reference_bytes + text.encode('utf-8')).hexdigest()
    cache = directory / 'voice-cache'
    if cache.is_symlink(): raise ValueError('Invalid voice cache')
    cache.mkdir(exist_ok=True)
    target = cache / (digest + '.wav')
    cache_hit=target.is_file() and not prime
    if cache_hit:
        with wave.open(str(target), 'rb') as wav:
            rate = wav.getframerate()
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getnframes() > 60*rate:
                raise ValueError('Invalid cached voice')
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)/32768
        audio=tempo(audio,rate,speed)
        if on_audio: on_audio(audio,rate)
        first_audio=time.monotonic()-started
    else:
        with wave.open(str(source), 'rb') as wav:
            if wav.getframerate() != 48000 or wav.getnchannels() != 2 or wav.getsampwidth() != 2 or not 2 <= wav.getnframes()/48000 <= 16:
                raise ValueError('Reference audio must be prepared before synthesis')
            reference = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32).reshape(-1,2)/32768
        original=[];spoken=[]
        with _native_lock:
            engine=runtime(quality)
            for part in (speech_chunks(text) if quality=='fast' else [text]):
                piece, rate = engine.generate(part, reference, 48000)
                piece *= min(1.0, .97/max(.01, float(np.max(np.abs(piece)))))
                original.append(piece)
                chunk=tempo(piece,rate,speed);spoken.append(chunk)
                if on_audio: on_audio(chunk,rate)
                if first_audio is None: first_audio=time.monotonic()-started
            audio=np.concatenate(spoken)
            write_wav(target.with_suffix('.tmp.wav'), np.concatenate(original), rate)
            os.replace(target.with_suffix('.tmp.wav'), target)
        for old in sorted(cache.glob('*.wav'), key=lambda f:f.stat().st_mtime, reverse=True)[24:]:
            old.unlink()
    try:
        folder=Path(os.environ.get('APPDATA',Path.home()/'AppData/Roaming'))/'brave/logs';folder.mkdir(parents=True,exist_ok=True)
        log=folder/'character-voice.jsonl'
        if log.exists() and log.stat().st_size>256*1024: log.unlink()
        with log.open('a',encoding='utf-8') as out:
            out.write(json.dumps({'time':time.time(),'chars':len(text),'quality':quality,'speed':speed,'cache':cache_hit,'warmup':prime,'first_audio_s':round(first_audio,3),'total_s':round(time.monotonic()-started,3),'audio_s':round(len(audio)/rate,3),'backend':getattr(_runtime,'backend',None)})+'\n')
    except OSError: pass
    return audio, rate


def warm_clone(identity):
    try:
        if profile(identity)['voiceMode']=='clone': synthesize_clone(identity,'همم، فهمت.',prime=True)
    except Exception as error:
        import sys
        print('[brave] Character warmup skipped: '+str(error),file=sys.stderr)
