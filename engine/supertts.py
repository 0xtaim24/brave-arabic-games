"""Local Arabic speech helper for the game, one executable with several modes.

  supertts.exe                 TTS server (Supertonic 3, CPU, ONNX Runtime)
  supertts.exe --stt           speech-recognition server (faster-whisper, CPU, int8)
  supertts.exe --stt-file      recognise ARABICAI_STT_FILE (wav) once and print JSON: text, confidence, levels, timings
  supertts.exe --download      fetch the TTS model, then exit
  supertts.exe --download-stt  fetch the recognition model (ARABICAI_STT_MODEL), then exit
  supertts.exe --bench-stt     time the recognition model on a known Arabic clip, print JSON
  supertts.exe --bench-tts     time the TTS at ARABICAI_TTS_STEPS on a known sentence, print JSON
  supertts.exe --voices        list the TTS voices (built in + custom ones in ARABICAI_VOICES_DIR)

TTS request : {"text": "...", "voice": "M1", "speed": 1.05, "steps": 8, "lang": "ar", "silence": 0.15}
TTS response: b"OK <nbytes> <samplerate>\\n" + <16-bit little-endian mono PCM>   or  b"ERR <message>\\n"

STT request : {"n": <samples>, "lang": "ar", "prompt": "..."}\\n  followed by n float32 LE samples at 16 kHz mono
STT response: b"OK <confidence> <base64 of utf-8 text>\\n"                        or  b"ERR <message>\\n"

Servers print READY once their model is loaded. Environment:
  ARABICAI_STT_MODEL    faster-whisper model: a size (tiny, base, small, medium, large-v3-turbo...), a Hugging Face repo id, or a folder
  ARABICAI_STT_THREADS  CPU threads for recognition
  ARABICAI_VOICES_DIR   folder with extra Supertonic voice-style .json files (the file name is the voice name)
"""
import base64
import json
import math
import os
import re
import sys
import time

# keep stdout clean: libraries may print, the protocol uses the original binary stream
_out = sys.stdout.buffer
sys.stdout = sys.stderr


def reply(data: bytes):
    _out.write(data)
    _out.flush()


def reply_json(obj):
    reply(("OK " + json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))


def custom_voices():
    d = os.environ.get("ARABICAI_VOICES_DIR", "")
    if not d or not os.path.isdir(d):
        return {}
    return {os.path.splitext(f)[0]: os.path.join(d, f) for f in os.listdir(d) if f.lower().endswith(".json")}


def load_style(tts, name, cache):
    if name in cache:
        return cache[name]
    extra = custom_voices()
    if name in extra:
        cache[name] = tts.get_voice_style_from_path(extra[name])
    else:
        cache[name] = tts.get_voice_style(name)
    return cache[name]


def serve_tts(download_only=False):
    import numpy as np
    from supertonic import TTS

    tts = TTS(auto_download=True)
    if download_only:
        reply(b"OK 0 0\n")
        return
    styles = {}
    reply(b"READY\n")
    warm_id = os.environ.get('ARABICAI_PREWARM_CHARACTER')
    if warm_id:
        import threading
        from character_voice import warm_clone
        threading.Thread(target=warm_clone,args=(warm_id,),daemon=True).start()
    for raw in sys.stdin.buffer:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw.decode("utf-8"))
            if req.get('character'):
                from character_voice import profile, synthesize_clone
                character = profile(req['character'])
                if character['voiceMode'] == 'clone':
                    streaming = bool(req.get('stream'))
                    stream_started = False
                    def send_chunk(audio, rate):
                        nonlocal stream_started
                        if not stream_started:
                            reply(f'STREAM {rate}\n'.encode('ascii')); stream_started = True
                        pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
                        reply(f'CHUNK {len(pcm)}\n'.encode('ascii') + pcm)
                    wav, rate = synthesize_clone(req['character'], req['text'], send_chunk if streaming else None)
                    if streaming:
                        reply(b'END\n')
                    else:
                        pcm = (np.clip(wav, -1, 1) * 32767).astype('<i2').tobytes()
                        reply(f'OK {len(pcm)} {rate}\n'.encode('ascii') + pcm)
                    continue
                req['voice'] = character['voicePreset']
                req['speed'] = character.get('voiceSpeed',req.get('speed',1.05))
            style = load_style(tts, req.get("voice", "M1"), styles)
            wav, _ = tts.synthesize(
                req["text"],
                style,
                total_steps=int(req.get("steps", 8)),
                speed=float(req.get("speed", 1.05)),
                silence_duration=float(req.get("silence", 0.15)),
                lang=req.get("lang", "ar"),
            )
            a = np.asarray(wav, dtype=np.float32).reshape(-1)
            pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
            reply(f"OK {len(pcm)} {tts.sample_rate}\n".encode("ascii") + pcm)
        except Exception as e:  # noqa: BLE001
            reply(("ERR " + str(e).replace("\n", " ") + "\n").encode("utf-8"))


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError("input closed")
        buf += chunk
    return bytes(buf)


_stt_runtime_info = {}


def stt_model(name=None, allow_download=False):
    from stt_runtime import load_model
    global _stt_runtime_info
    name = name or os.environ.get("ARABICAI_STT_MODEL", "small")
    model, _stt_runtime_info = load_model(name,
        threads=int(os.environ.get("ARABICAI_STT_THREADS", "4")),
        device=os.environ.get("ARABICAI_STT_DEVICE", "auto"), allow_download=allow_download)
    return model


def stt_model_with_fallback():
    name = os.environ.get("ARABICAI_STT_MODEL", "small")
    model = stt_model(name)
    return model, name, _stt_runtime_info.get("fallback", [])


def stt_config():
    """Decoding profile: ARABICAI_STT_PROFILE = baseline | improved (default) | a JSON object of overrides."""
    import stt_core

    raw = os.environ.get("ARABICAI_STT_PROFILE", "improved").strip()
    if raw == "baseline":
        return dict(stt_core.BASELINE)
    cfg = dict(stt_core.IMPROVED)
    if raw.startswith("{"):
        try:
            cfg.update(json.loads(raw))
        except ValueError:
            pass
    return cfg


class SttLog:
    """One line per utterance (levels and timings, no text unless ARABICAI_STT_DEBUG=1) so a bad recognition can be traced
    to the microphone level, the cut of the clip or the model. Audio is never written unless debug is on."""

    def __init__(self):
        self.path = os.environ.get("ARABICAI_STT_LOG", "")
        self.debug = os.environ.get("ARABICAI_STT_DEBUG") == "1"
        self.kept = 0

    def write(self, obj):
        if not self.path:
            return
        try:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        except OSError:
            pass

    def keep_audio(self, samples, metadata):
        if not (self.debug and self.path):
            return
        import wave

        import numpy as np

        d = os.path.join(os.path.dirname(self.path), "stt-clips")
        os.makedirs(d, exist_ok=True)
        self.kept = (self.kept % 5) + 1  # rolling: only the last five clips are kept
        with wave.open(os.path.join(d, f"last-{self.kept}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
        with open(os.path.join(d, f"last-{self.kept}.json"), "w", encoding="utf8") as f:
            json.dump(metadata, f, ensure_ascii=False)
        return f"last-{self.kept}.wav"


def serve_stt(download_only=False, json_mode=False):
    import numpy as np

    import stt_core

    if download_only:
        stt_model(allow_download=True)
        reply(b"OK 0 0\n")
        return
    model, loaded_name, tried = stt_model_with_fallback()
    cfg = stt_config()
    log = SttLog()
    if tried:
        log.write({"event": "device_fallback", "to": _stt_runtime_info.get("device"), "tried": tried})
    log.write({"event": "ready", "runtime": _stt_runtime_info, "model": loaded_name, "profile": {k: v for k, v in cfg.items() if k != "prompt"}})
    # warm up so the first real sentence is fast
    reply(b"READY\n")
    stdin = sys.stdin.buffer
    slow = 0
    while True:
        line = stdin.readline()
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line.decode("utf-8"))
            n = int(req["n"])
            if not 1 <= n <= 16000 * 60:
                raise ValueError("Invalid audio frame length")
            samples = np.frombuffer(read_exact(stdin, n * 4), dtype="<f4")
            run = dict(stt_core.BASELINE if json_mode and req.get("profile") == "baseline" else cfg)
            if req.get("lang"):
                run["language"] = req["lang"]
            try:
                text, conf, info = stt_core.decode(model, samples, run, prompt_default=req.get("prompt") or "")
            except RuntimeError:
                if _stt_runtime_info.get("device") not in ("cuda", "vulkan"):
                    raise
                # Games can consume VRAM after warm-up. Retry the same audio/model on CPU once.
                import gc
                from stt_runtime import load_model
                if hasattr(model, "close"):
                    model.close()
                del model
                gc.collect()
                model, cpu_info = load_model(loaded_name, threads=int(os.environ.get("ARABICAI_STT_THREADS", "4")), device="cpu")
                _stt_runtime_info.update(cpu_info)
                log.write({"event": "device_fallback", "reason": "GPU inference failed; same model retried on CPU"})
                text, conf, info = stt_core.decode(model, samples, run, prompt_default=req.get("prompt") or "")
            # too slow to keep up with the conversation twice in a row -> cheaper decoding for the rest of the session
            if info.get("ms", 0) > max(2500, 2000 * info["audio_s"]) and cfg.get("beam", 1) > 1:
                slow += 1
                if slow >= 2:
                    cfg["beam"] = 1
                    log.write({"event": "speed_fallback", "beam": 1})
            else:
                slow = 0
            entry = {"t": round(time.time()), "in_s": round(n / 16000, 2), "peak": round(info["peak"], 3), "rms": round(info["rms"], 4),
                     "speech": info["speech"], "ms": info.get("ms"), "conf": round(conf, 3) if conf is not None else None,
                     "chars": len(text), "model": loaded_name, "device": _stt_runtime_info.get("device"),
                     "raw_peak": info["raw_peak"], "raw_rms": info["raw_rms"], "raw_clip_pct": info["raw_clip_pct"]}
            if log.debug:
                entry["text"] = text
                entry["clip"] = log.keep_audio(samples, entry)
            log.write(entry)
            if json_mode:
                reply_json({"text": text, "conf": round(conf, 3) if conf is not None else None, "model": loaded_name, **info, **_stt_runtime_info})
            else:
                # The game's legacy protocol requires a float: -1 means unavailable,
                # distinct from a measured probability. UI/logs retain null.
                wire_conf = conf if conf is not None else -1.0
                reply(f"OK {wire_conf:.3f} ".encode("ascii") + base64.b64encode(text.encode("utf-8")) + b"\n")
        except EOFError:
            return
        except Exception as e:  # noqa: BLE001
            reply(("ERR " + str(e).replace("\n", " ") + "\n").encode("utf-8"))


def transcribe_file():
    """One-shot recognition of a 16 kHz mono wav for the app's microphone test. Prints one JSON line."""
    import wave

    import numpy as np

    import stt_core

    path = os.environ["ARABICAI_STT_FILE"]
    t0 = time.time()
    model, loaded_name, tried = stt_model_with_fallback()
    load_s = time.time() - t0
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        sr = w.getframerate()
        ch = w.getnchannels()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        x = np.interp(np.linspace(0, len(x) - 1, int(len(x) * 16000 / sr)), np.arange(len(x)), x).astype(np.float32)
    text, conf, info = stt_stats(model, x)
    reply_json({"model": loaded_name, "fallback": tried, "load_s": round(load_s, 1), "text": text,
                "conf": round(conf, 3) if conf is not None else None, **info, **_stt_runtime_info})


def stt_stats(model, x):
    import stt_core

    text, conf, info = stt_core.decode(model, x, stt_config(), prompt_default=os.environ.get("ARABICAI_STT_PROMPT", ""))
    return text, conf, info


# ───────────────────────── benchmarks ─────────────────────────
def norm_ar(s):
    s = re.sub(r"[ً-ٰٟـ]", "", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = s.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    return " ".join(s.split())


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def bench_stt():
    import wave

    import numpy as np

    wav_path = os.environ["ARABICAI_BENCH_WAV"]
    expected = open(os.environ["ARABICAI_BENCH_TEXT"], encoding="utf8").read()
    t0 = time.time()
    model = stt_model(allow_download=True)
    load_s = time.time() - t0
    with wave.open(wav_path, "rb") as w:
        raw = w.readframes(w.getnframes())
        sr = w.getframerate()
    samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    import stt_core

    t0 = time.time()
    text, _conf, _info = stt_core.decode(model, samples, stt_config())  # the same path the game uses
    dt = time.time() - t0
    dur = len(samples) / sr
    a, b = norm_ar(text), norm_ar(expected)
    cer = edit_distance(a, b) / max(1, len(b))
    # Also time a short conversational turn; full-clip CER remains the quality probe.
    short_audio = samples[:min(len(samples), 4 * sr)]
    short_start = time.time()
    stt_core.decode(model, short_audio, stt_config())
    short_seconds = time.time() - short_start
    reply_json({"model": os.environ.get("ARABICAI_STT_MODEL", "small"), "load_s": round(load_s, 1), "seconds": round(dt, 2),
                "audio_s": round(dur, 1), "rtf": round(dt / dur, 3), "short_seconds": round(short_seconds, 3),
                "cer": round(cer, 3), "text": text, **_stt_runtime_info})


def bench_tts():
    import numpy as np
    from supertonic import TTS

    steps = int(os.environ.get("ARABICAI_TTS_STEPS", "8"))
    text = open(os.environ["ARABICAI_BENCH_TEXT"], encoding="utf8").read()
    t0 = time.time()
    tts = TTS(auto_download=True)
    load_s = time.time() - t0
    style = tts.get_voice_style("F1")
    tts.synthesize("مرحباً", style, total_steps=steps, lang="ar")  # warm-up
    t0 = time.time()
    wav, _ = tts.synthesize(text, style, total_steps=steps, speed=1.0, lang="ar")
    dt = time.time() - t0
    dur = len(np.asarray(wav).reshape(-1)) / tts.sample_rate
    reply_json({"steps": steps, "load_s": round(load_s, 1), "seconds": round(dt, 2), "audio_s": round(dur, 1), "rtf": round(dt / dur, 3)})


def list_voices():
    from supertonic import TTS

    tts = TTS(auto_download=True)
    reply_json({"builtin": list(tts.voice_style_names), "custom": sorted(custom_voices())})


def main():
    args = set(sys.argv[1:])
    if '--character-model-status' in args:
        from character_native import installed, SIZE
        reply_json({'installed': installed(), 'size': SIZE})
    elif '--download-character-model' in args:
        from character_native import install
        reply_json(install())
    elif '--prepare-character-reference' in args:
        from character_voice import prepare_reference
        reply_json(prepare_reference(os.environ['ARABICAI_REFERENCE_INPUT'], os.environ['ARABICAI_REFERENCE_OUTPUT']))
    elif '--character-preview' in args:
        from character_voice import profile, synthesize_clone, write_wav
        identity = os.environ['ARABICAI_CHARACTER_ID']
        p = profile(identity)
        text = os.environ.get('ARABICAI_PREVIEW_TEXT') or p['opening']
        start = time.monotonic()
        if p['voiceMode'] == 'clone':
            wav, rate = synthesize_clone(identity, text)
        else:
            import numpy as np
            from supertonic import TTS
            tts = TTS(auto_download=False)
            wav, _ = tts.synthesize(text, tts.get_voice_style(p['voicePreset']), total_steps=8, lang='ar', speed=float(p.get('voiceSpeed',1.05)))
            wav = np.asarray(wav).reshape(-1); rate = tts.sample_rate
        target = os.environ['ARABICAI_PREVIEW_OUTPUT']
        write_wav(target, wav, rate)
        reply_json({'seconds': round(time.monotonic()-start,2), 'audio_seconds': round(len(wav)/rate,2), 'sample_rate': rate})
    elif "--stt-hardware" in args:
        from stt_runtime import hardware_status
        reply_json(hardware_status())
    elif "--install-stt-gpu" in args:
        from stt_runtime import install_runtime
        reply_json(install_runtime())
    elif "--stt-json" in args:
        serve_stt(json_mode=True)
    elif "--stt" in args:
        serve_stt()
    elif "--stt-file" in args:
        transcribe_file()
    elif "--download-stt" in args:
        serve_stt(download_only=True)
    elif "--bench-stt" in args:
        bench_stt()
    elif "--bench-tts" in args:
        bench_tts()
    elif "--voices" in args:
        list_voices()
    else:
        serve_tts(download_only="--download" in args)


if __name__ == "__main__":
    main()
