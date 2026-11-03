"""Builds a repeatable recognition test set from the local Arabic voice (Supertonic) and degrades it
(quiet, noisy, padded, silence). Synthetic speech is cleaner than a real microphone, so results are an
indication, not proof; real recordings from the in-app microphone test should be added with --extra.

  python stt_corpus.py <out_dir>
Writes <out_dir>/*.wav (16 kHz mono PCM16) and <out_dir>/manifest.json
"""
import json
import os
import sys
import wave

import numpy as np

SR = 16000

# (id, kind, [(lang, text), ...], reference text, alternatives for English words)
ITEMS = [
    ("gulf1", "dialect", [("ar", "شو تبي مني الحين؟ أنا ما سويت شي")], "شو تبي مني الحين انا ما سويت شي", {}),
    ("gulf2", "dialect", [("ar", "وش هالمكالمة؟ ليش تتصل علي هالوقت")], "وش هالمكالمه ليش تتصل علي هالوقت", {}),
    ("egy1", "dialect", [("ar", "إيه ده؟ أنا مش فاهم حاجة خالص")], "ايه ده انا مش فاهم حاجه خالص", {}),
    ("lev1", "dialect", [("ar", "شو بدك مني؟ ما بعرف مين انت")], "شو بدك مني ما بعرف مين انت", {}),
    ("msa1", "dialect", [("ar", "أرجوك لا تغلق الخط، أحتاج إلى مساعدتك")], "ارجوك لا تغلق الخط احتاج الي مساعدتك", {}),
    ("mix1", "mixed", [("ar", "خلاص أرسل لي "), ("en", "email"), ("ar", " بسرعة")], "خلاص ارسل لي email بسرعه", {"email": ["email", "ايميل", "إيميل", "الايميل"]}),
    ("mix2", "mixed", [("ar", "أنا أشتري "), ("en", "iPhone"), ("ar", " جديد من "), ("en", "Amazon")], "انا اشتري iphone جديد من amazon", {"iphone": ["iphone", "ايفون", "آيفون"], "amazon": ["amazon", "امازون", "أمازون"]}),
    ("mix3", "mixed", [("ar", "ما عندي "), ("en", "password"), ("ar", " ولا "), ("en", "code")], "ما عندي password ولا code", {"password": ["password", "باسورد", "الباسورد"], "code": ["code", "كود"]}),
    ("short1", "short", [("ar", "لا")], "لا", {}),
    ("short2", "short", [("ar", "ايوه")], "ايوه", {}),
    ("short3", "short", [("ar", "وين")], "وين", {}),
    ("short4", "short", [("ar", "شكرا")], "شكرا", {}),
    ("short5", "short", [("ar", "مين انت")], "مين انت", {}),
    ("long1", "long", [("ar", "اسمع، أنا ما أعطي أرقام حسابي لأي أحد على الهاتف، وإذا كنت تريد شيئاً تعال إلى الفرع بنفسك")], "اسمع انا ما اعطي ارقام حسابي لاي احد علي الهاتف واذا كنت تريد شيئا تعال الي الفرع بنفسك", {}),
]
VOICES = ["F1", "M1", "F3", "M4"]


def synth_all(out_dir):
    from supertonic import TTS

    tts = TTS(auto_download=True)
    sr_t = tts.sample_rate
    clips = {}
    for vi, voice in enumerate(VOICES):
        style = tts.get_voice_style(voice)
        for iid, kind, parts, ref, alts in ITEMS:
            # alternate voices over items so the set stays small but covers every voice
            if (sum(map(ord, iid)) + vi) % 2:
                continue
            wavs = []
            for lang, text in parts:
                w, _ = tts.synthesize(text, style, total_steps=8, speed=1.0, lang=lang)
                wavs.append(np.asarray(w, dtype=np.float32).reshape(-1))
            audio = np.concatenate(wavs)
            clips[f"{iid}_{voice}"] = (audio, sr_t, kind, ref, alts)
    return clips


def resample(x, sr_in):
    if sr_in == SR:
        return x
    n = int(round(len(x) * SR / sr_in))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


def write(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def level(x, db):
    return x * (10 ** (db / 20))


def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def add_noise(x, snr_db, rng):
    n = rng.standard_normal(len(x)).astype(np.float32)
    # a little low-pass tilt so it sounds like room/fan noise, not pure hiss
    n = np.convolve(n, np.ones(6) / 6, mode="same")
    n *= rms(x) / (10 ** (snr_db / 20)) / (rms(n) + 1e-9)
    return x + n


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    rng = np.random.default_rng(7)
    manifest = []
    for name, (audio, sr_t, kind, ref, alts) in synth_all(out).items():
        a = resample(audio, sr_t)
        a = a / (np.max(np.abs(a)) + 1e-9) * 0.5
        sil = np.zeros(int(0.25 * SR), dtype=np.float32)
        variants = {
            "clean": np.concatenate([sil, a, sil]),
            "quiet": np.concatenate([sil, level(a, -26), sil]),  # a soft voice / far from the mic
            "noisy": add_noise(np.concatenate([sil, a, sil]), 8, rng),  # fan / room noise, 8 dB SNR
            "tight": a.copy(),  # no lead-in / tail: the game's VAD cut
        }
        for vn, x in variants.items():
            # the game pads anything shorter than 1.1 s with zeros before recognising
            if len(x) < 17600:
                x = np.concatenate([x, np.zeros(17600 - len(x), dtype=np.float32)])
            fn = f"{name}__{vn}.wav"
            write(os.path.join(out, fn), x)
            manifest.append({"file": fn, "id": name, "kind": kind, "variant": vn, "ref": ref, "alts": alts})
    # hallucination probes: nothing was said
    for fn, x in {
        "none_silence__clean.wav": np.zeros(3 * SR, dtype=np.float32),
        "none_noise__noisy.wav": (rng.standard_normal(3 * SR) * 0.01).astype(np.float32),
        "none_hum__noisy.wav": (0.02 * np.sin(2 * np.pi * 120 * np.arange(3 * SR) / SR)).astype(np.float32),
    }.items():
        write(os.path.join(out, fn), x)
        manifest.append({"file": fn, "id": fn.split("__")[0], "kind": "none", "variant": fn.split("__")[1][:-4], "ref": "", "alts": {}})
    json.dump(manifest, open(os.path.join(out, "manifest.json"), "w", encoding="utf8"), ensure_ascii=False, indent=1)
    print(len(manifest), "clips ->", out)


if __name__ == "__main__":
    main()
