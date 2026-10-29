"""Local Arabic speech helper for the game, one executable with two modes.

  supertts.exe                 TTS server (Supertonic 3, CPU, ONNX Runtime)
  supertts.exe --stt           speech-recognition server (faster-whisper, CPU, int8)
  supertts.exe --download      fetch the TTS model, then exit
  supertts.exe --download-stt  fetch the recognition model, then exit

TTS request : {"text": "...", "voice": "M1", "speed": 1.05, "steps": 8, "lang": "ar", "silence": 0.15}
TTS response: b"OK <nbytes> <samplerate>\\n" + <16-bit little-endian mono PCM>   or  b"ERR <message>\\n"

STT request : {"n": <samples>, "lang": "ar", "prompt": "..."}\\n  followed by n float32 LE samples at 16 kHz mono
STT response: b"OK <confidence> <base64 of utf-8 text>\\n"                        or  b"ERR <message>\\n"

Both servers print READY once their model is loaded.
"""
import base64
import json
import math
import os
import sys

# keep stdout clean: libraries may print, the protocol uses the original binary stream
_out = sys.stdout.buffer
sys.stdout = sys.stderr


def reply(data: bytes):
    _out.write(data)
    _out.flush()


def serve_tts(download_only=False):
    import numpy as np
    from supertonic import TTS

    tts = TTS(auto_download=True)
    if download_only:
        reply(b"OK 0 0\n")
        return
    styles = {}
    reply(b"READY\n")
    for raw in sys.stdin.buffer:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw.decode("utf-8"))
            voice = req.get("voice", "M1")
            if voice not in styles:
                styles[voice] = tts.get_voice_style(voice)
            wav, _ = tts.synthesize(
                req["text"],
                styles[voice],
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


def serve_stt(download_only=False):
    import numpy as np
    from faster_whisper import WhisperModel

    model_name = os.environ.get("ARABICAI_STT_MODEL", "small")
    threads = int(os.environ.get("ARABICAI_STT_THREADS", "4"))
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
    if download_only:
        reply(b"OK 0 0\n")
        return
    # warm up so the first real sentence is fast
    list(model.transcribe(np.zeros(16000, dtype=np.float32), language="ar", beam_size=1)[0])
    reply(b"READY\n")
    stdin = sys.stdin.buffer
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
            samples = np.frombuffer(read_exact(stdin, n * 4), dtype="<f4")
            segs, _info = model.transcribe(
                samples,
                language=req.get("lang", "ar"),
                initial_prompt=req.get("prompt") or None,
                beam_size=int(req.get("beam", 1)),
                temperature=0.0,
                condition_on_previous_text=False,
                vad_filter=False,
                no_speech_threshold=0.6,
            )
            parts, logps = [], []
            for s in segs:
                if s.no_speech_prob > 0.6 and s.avg_logprob < -1.0:
                    continue  # silence / hallucination
                parts.append(s.text.strip())
                logps.append(s.avg_logprob)
            text = " ".join(p for p in parts if p).strip()
            conf = math.exp(sum(logps) / len(logps)) if logps else 0.0
            reply(f"OK {conf:.3f} ".encode("ascii") + base64.b64encode(text.encode("utf-8")) + b"\n")
        except EOFError:
            return
        except Exception as e:  # noqa: BLE001
            reply(("ERR " + str(e).replace("\n", " ") + "\n").encode("utf-8"))


def main():
    args = set(sys.argv[1:])
    if "--stt" in args:
        serve_stt()
    elif "--download-stt" in args:
        serve_stt(download_only=True)
    else:
        serve_tts(download_only="--download" in args)


if __name__ == "__main__":
    main()
