"""Speech-recognition core shared by the in-game helper (supertts.py --stt), the microphone test and the
evaluation script, so what is measured is exactly what ships.

Pipeline: clean the audio (undo the game's zero padding, DC/low-rumble removal, optional level lift and
noise reduction) -> Silero VAD finds the real speech -> Whisper decodes only that part -> segments that
look like silence-hallucinations are dropped. Nothing here rewrites words: text either comes from the
model or is removed.
"""
import math
import re

import numpy as np

SR = 16000

# Every field can be overridden per request. "baseline" is what version 1.0.x shipped.
BASELINE = {
    "beam": 1, "prompt": None, "vad": False, "preprocess": False, "denoise": False,
    "temperature": (0.0,), "language": "ar", "multilingual": False, "gate": False,
}
# beam 1 (greedy): beam 5 gave no accuracy gain on the test set and costs ~20% more time per sentence.
IMPROVED = {
    "beam": 1, "prompt": "", "vad": True, "preprocess": True, "denoise": False,
    "temperature": (0.0,), "language": "ar", "multilingual": False, "gate": True,
}

# What Whisper tends to invent when it hears silence or hum. Dropped only when the VAD found no speech.
HALLUCINATIONS = [
    "ترجمة نانسي قنقر", "اشتركوا في القناة", "اشترك في القناة", "شكرا على المشاهدة", "شكراً على المشاهدة",
    "شكرا لكم على المشاهدة", "لا تنسوا الاشتراك", "الحمد لله رب العالمين", "موسيقى", "تابعونا",
    "thanks for watching", "thank you", "subtitles by", "amara.org",
]


def strip_padding(x):
    """The game pads short clips to 1.1 s with exact zeros; real microphone audio is never exactly 0."""
    nz = np.flatnonzero(np.abs(x) > 1e-7)
    if len(nz) == 0:
        return x[:0]
    end = min(len(x), nz[-1] + 1 + int(0.15 * SR))
    return x[:end]


def highpass(x, hz=70.0):
    if len(x) < 512:
        return x
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / SR)
    gain = np.clip((freqs - hz * 0.5) / (hz * 0.5), 0.0, 1.0)
    return np.fft.irfft(spec * gain, n=len(x)).astype(np.float32)


def denoise(x, floor=0.25):
    """Light spectral gating. Off unless the evaluation shows it helps: it can blur soft consonants."""
    n_fft, hop = 512, 128
    if len(x) < n_fft * 2:
        return x
    win = np.hanning(n_fft).astype(np.float32)
    pad = np.pad(x, (n_fft, n_fft))
    idx = np.arange(0, len(pad) - n_fft, hop)
    frames = np.stack([pad[i:i + n_fft] * win for i in idx])
    spec = np.fft.rfft(frames, axis=1)
    mag = np.abs(spec)
    energy = mag.mean(axis=1)
    noise = np.percentile(mag[energy <= np.percentile(energy, 15)], 50, axis=0) if len(energy) > 8 else mag.min(axis=0)
    gain = np.clip(1.0 - 1.5 * noise / (mag + 1e-9), floor, 1.0)
    out = np.fft.irfft(spec * gain, n=n_fft, axis=1) * win
    res = np.zeros(len(pad), dtype=np.float32)
    norm = np.zeros(len(pad), dtype=np.float32)
    for k, i in enumerate(idx):
        res[i:i + n_fft] += out[k]
        norm[i:i + n_fft] += win * win
    res /= np.maximum(norm, 1e-6)
    return res[n_fft:-n_fft][: len(x)].astype(np.float32)


def preprocess(x, cfg):
    x = np.asarray(x, dtype=np.float32)
    x = strip_padding(x)
    if len(x) == 0:
        return x
    x = x - float(np.mean(x))
    x = highpass(x)
    if cfg.get("denoise"):
        x = denoise(x)
    # lift quiet speech so the log-mel front end sees a normal level (capped: never boost pure noise by much)
    peak = float(np.max(np.abs(x)))
    if 1e-4 < peak < 0.35:
        x = x * min(0.6 / peak, 30.0)
    return np.clip(x, -1.0, 1.0)


def speech_spans(x, vad_params=None):
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    settings = dict(threshold=0.3, min_speech_duration_ms=80, min_silence_duration_ms=600, speech_pad_ms=300)
    settings.update(vad_params or {})
    opts = VadOptions(**settings)
    return get_speech_timestamps(x, opts)


def decode(model, samples, cfg=None, prompt_default=""):
    """Returns (text, confidence, info). info has timings and whether the VAD saw any speech."""
    import time

    cfg = dict(IMPROVED if cfg is None else cfg)
    t0 = time.time()
    raw = np.asarray(samples, dtype=np.float32)
    if raw.ndim != 1 or not np.all(np.isfinite(raw)):
        raise ValueError("Expected finite mono PCM samples")
    x = preprocess(raw, cfg) if cfg.get("preprocess") else raw
    info = {"audio_s": round(len(x) / SR, 2), "peak": float(np.max(np.abs(x))) if len(x) else 0.0,
            "rms": float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0, "speech": True,
            "raw_peak": float(np.max(np.abs(raw))) if len(raw) else 0.0,
            "raw_rms": float(np.sqrt(np.mean(raw ** 2))) if len(raw) else 0.0,
            "raw_clip_pct": float(np.mean(np.abs(raw) >= 0.98) * 100) if len(raw) else 0.0}
    if len(x) < int(0.12 * SR):
        info["speech"] = False
        return "", 0.0, info
    if cfg.get("vad") or cfg.get("gate"):
        spans = speech_spans(x)
        info["speech"] = bool(spans)
        if cfg.get("gate") and not spans:
            info["ms"] = round((time.time() - t0) * 1000)
            return "", 0.0, info
        if cfg.get("vad") and spans:
            # cut to the speech with margin so Whisper does not decode long silence/noise either side
            a = max(0, spans[0]["start"] - int(0.2 * SR))
            b = min(len(x), spans[-1]["end"] + int(0.3 * SR))
            x = x[a:b]
    if hasattr(model, "decode_pcm"):
        text = model.decode_pcm(np.ascontiguousarray(x), cfg.get("language") or "ar")
        info.update(ms=round((time.time() - t0) * 1000), confidence_available=False)
        # This model does not expose token confidence; never manufacture a percentage.
        return text, None, info
    prompt = cfg.get("prompt")
    if prompt is None:
        prompt = prompt_default
    kw = dict(
        language=cfg.get("language") or None,
        initial_prompt=prompt or None,
        beam_size=int(cfg.get("beam", 1)),
        temperature=list(cfg.get("temperature", (0.0,))),
        condition_on_previous_text=False,
        vad_filter=False,
        no_speech_threshold=0.6,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
    )
    if cfg.get("multilingual"):
        kw["multilingual"] = True
    segs, _ = model.transcribe(x, **kw)
    parts, logps = [], []
    for s in segs:
        if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
            continue
        if s.compression_ratio > 2.4:
            continue  # repetition loop
        t = s.text.strip()
        if t:
            parts.append(t)
            logps.append(s.avg_logprob)
    text = " ".join(parts).strip()
    # Silence was already rejected by VAD. Do not blacklist legitimate spoken phrases.
    conf = math.exp(sum(logps) / len(logps)) if logps else 0.0
    info["ms"] = round((time.time() - t0) * 1000)
    return text, conf, info


# ───────────────────────── scoring (used by the evaluation and benchmarks) ─────────────────────────
def norm_ar(s):
    s = re.sub(r"[ً-ٰٟـ]", "", s)
    s = re.sub(r"[^\w\s]", " ", s)
    s = s.replace("أ", "ا").replace("إ", "ا").replace("آ", "ا").replace("ى", "ي").replace("ة", "ه")
    return " ".join(s.lower().split())


def edit_distance(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def score(hyp, ref, alts=None):
    """(char errors, ref chars). English words may be written in Latin or Arabic script - both are right."""
    h, r = norm_ar(hyp), norm_ar(ref)
    for key, options in (alts or {}).items():
        for opt in options:
            o = norm_ar(opt)
            if o and o in h and o != key:
                r = r.replace(key, o)
                break
    return edit_distance(h, r), max(1, len(r))
