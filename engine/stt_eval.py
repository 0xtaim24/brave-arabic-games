"""Compare recognition settings on the same recordings.

  python stt_eval.py <corpus_dir> --model small --configs baseline,improved [--json out.json]

<corpus_dir> holds *.wav (16 kHz mono) plus manifest.json from stt_corpus.py (or your own recordings with the same shape).
"""
import argparse
import json
import os
import time
import wave

import numpy as np

import stt_core as core

CONFIGS = {
    "baseline": core.BASELINE,
    "beam5": dict(core.BASELINE, beam=5),
    "beam5-noprompt": dict(core.BASELINE, beam=5, prompt=""),
    "vad": dict(core.BASELINE, beam=5, prompt="", vad=True, gate=True),
    "vad+pre": dict(core.BASELINE, beam=5, prompt="", vad=True, gate=True, preprocess=True),
    "vad+pre+denoise": dict(core.BASELINE, beam=5, prompt="", vad=True, gate=True, preprocess=True, denoise=True),
    "improved": core.IMPROVED,
    "improved-mixed": dict(core.IMPROVED, language=None, multilingual=True),
    "improved-fallback": dict(core.IMPROVED, temperature=(0.0, 0.2, 0.4, 0.6)),
}
OLD_PROMPT = ("مرحباً، أنا أتحدث بالعربية مع بعض الكلمات الإنجليزية مثل: subscription، gift card، credit card، "
              "password، Bitcoin، Steam، email، number، security code، OK، hello.")


def load(path):
    with wave.open(path, "rb") as w:
        raw = w.readframes(w.getnframes())
        assert w.getframerate() == 16000
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("corpus")
    ap.add_argument("--model", default="small")
    ap.add_argument("--configs", default="baseline,improved")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--json")
    a = ap.parse_args()

    from faster_whisper import WhisperModel

    t0 = time.time()
    model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=a.threads)
    print(f"model {a.model} loaded in {time.time() - t0:.1f}s")
    list(model.transcribe(np.zeros(16000, dtype=np.float32), language="ar", beam_size=1)[0])
    manifest = json.load(open(os.path.join(a.corpus, "manifest.json"), encoding="utf8"))
    audio = {m["file"]: load(os.path.join(a.corpus, m["file"])) for m in manifest}
    results = {}
    for name in a.configs.split(","):
        cfg = CONFIGS[name]
        rows = []
        for m in manifest:
            t = time.time()
            text, conf, info = core.decode(model, audio[m["file"]], cfg, prompt_default=OLD_PROMPT)
            rows.append(dict(m, hyp=text, ms=round((time.time() - t) * 1000), conf=round(conf, 3)))
        results[name] = rows
    # summary: character error rate per group, latency, and text produced where nothing was said
    groups = ["dialect", "mixed", "short", "long"]
    variants = ["clean", "quiet", "noisy", "tight"]
    print(f"\n{'config':20s}" + "".join(f"{g:>9s}" for g in groups) + "".join(f"{v:>8s}" for v in variants) + "   all  false-text  ms/clip")
    for name, rows in results.items():
        def cer(sel):
            e = n = 0
            for r in rows:
                if r["kind"] == "none" or not sel(r):
                    continue
                de, dn = core.score(r["hyp"], r["ref"], r["alts"])
                e += de
                n += dn
            return 100.0 * e / n if n else float("nan")
        none = [r for r in rows if r["kind"] == "none"]
        false_text = sum(1 for r in none if core.norm_ar(r["hyp"]))
        speech = [r for r in rows if r["kind"] != "none"]
        line = f"{name:20s}" + "".join(f"{cer(lambda r, g=g: r['kind'] == g):8.1f}%" for g in groups)
        line += "".join(f"{cer(lambda r, v=v: r['variant'] == v):7.1f}%" for v in variants)
        line += f"{cer(lambda r: True):6.1f}%  {false_text:>3d}/{len(none)}     {np.mean([r['ms'] for r in speech]):6.0f}"
        print(line)
    if a.json:
        json.dump(results, open(a.json, "w", encoding="utf8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
