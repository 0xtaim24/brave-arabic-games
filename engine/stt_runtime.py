"""Local inference with a verified CUDA warm-up and same-model CPU fallback.

No network access during recognition. GPU runtime installation is an explicit
one-time action; NVIDIA files live in the user's app data, not system folders.
"""
import gc
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile

RUNTIME_ID = "cuda12.8-cudnn9.10-v1"
# cuDNN 9.10 retains Pascal support (GTX 10xx); later releases dropped it.
PACKAGES = (
    ("nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl",
     "https://files.pythonhosted.org/packages/70/61/7d7b3c70186fb651d0fbd35b01dbfc8e755f69fd58f817f3d0f642df20c3/nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl",
     "47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af"),
    ("nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl",
     "https://files.pythonhosted.org/packages/3d/90/0bd6e586701b3a890fd38aa71c387dab4883d619d6e5ad912ccbd05bfd67/nvidia_cudnn_cu12-9.10.2.21-py3-none-win_amd64.whl",
     "c6288de7d63e6cf62988f0923f96dc339cea362decb1bf5b3141883392a7d65e"),
)
_dll_handles = []


def runtime_dir():
    if os.environ.get("ARABICAI_GPU_RUNTIME"):
        return Path(os.environ["ARABICAI_GPU_RUNTIME"]) / RUNTIME_ID
    sibling = Path(sys.executable if getattr(sys, "frozen", False) else __file__).parent / "gpu-runtime" / RUNTIME_ID
    if (sibling / "complete.json").is_file():
        return sibling
    shared = Path(os.environ.get("PROGRAMDATA", "C:/ProgramData")) / "brave" / "gpu-runtime" / RUNTIME_ID
    if (shared / "complete.json").is_file():
        return shared
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "brave" / "gpu-runtime" / RUNTIME_ID


def runtime_installed():
    root = runtime_dir()
    return (root / "complete.json").is_file() and all(
        (root / n).is_file() for n in ("cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll"))


def register_runtime():
    if sys.platform != "win32" or not runtime_installed():
        return
    root = str(runtime_dir())
    if not _dll_handles:
        _dll_handles.append(os.add_dll_directory(root))
        os.environ["PATH"] = root + os.pathsep + os.environ.get("PATH", "")


def install_runtime(wheel_dir=None, progress=lambda s: print(s, file=sys.stderr, flush=True)):
    if sys.platform != "win32":
        raise RuntimeError("The optional NVIDIA download is for Windows only.")
    if runtime_installed():
        return {"installed": True, "path": str(runtime_dir())}
    target = runtime_dir()
    target.parent.mkdir(parents=True, exist_ok=True)
    target = target.resolve()
    if target.exists():
        raise RuntimeError("An incomplete GPU runtime exists. Choose a fresh runtime directory before retrying.")
    # The only temporary directory removed by this routine is created beneath our own runtime root.
    with tempfile.TemporaryDirectory(prefix="install-", dir=target.parent) as tmp:
        stage = Path(tmp).resolve()
        if stage.parent != target.parent.resolve():
            raise RuntimeError("Unexpected staging path")
        payload = stage / "payload"
        payload.mkdir()
        for index, (filename, url, expected) in enumerate(PACKAGES):
            archive = Path(wheel_dir) / filename if wheel_dir else stage / filename
            if not wheel_dir:
                progress(f"Downloading NVIDIA component {index + 1}/2 (one time)…")
                with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as out:
                    shutil.copyfileobj(response, out, length=1024 * 1024)
            with archive.open("rb") as f:
                actual = hashlib.file_digest(f, "sha256").hexdigest()
            if actual != expected:
                raise RuntimeError("NVIDIA package checksum mismatch; nothing was installed.")
            progress(f"Verified NVIDIA component {index + 1}/2; extracting…")
            with zipfile.ZipFile(archive) as z:
                for member in z.infolist():
                    name = Path(member.filename).name
                    if name.lower().endswith(".dll"):
                        dest = payload / name  # never use archive directory paths
                    elif "license" in name.lower():
                        dest = payload / (str(index) + "-" + name)
                    else:
                        continue
                    with z.open(member) as src, dest.open("wb") as dst:
                        shutil.copyfileobj(src, dst)
        (payload / "complete.json").write_text(json.dumps({"version": RUNTIME_ID,
            "sha256": [p[2] for p in PACKAGES]}), encoding="utf8")
        payload.rename(target)
    return {"installed": True, "path": str(target)}


def hardware_status():
    register_runtime()
    try:
        import ctranslate2
        count = ctranslate2.get_cuda_device_count()
        types = sorted(ctranslate2.get_supported_compute_types("cuda")) if count else []
        return {"cuda_devices": count, "compute_types": types, "runtime_installed": runtime_installed()}
    except Exception as exc:
        return {"cuda_devices": 0, "runtime_installed": runtime_installed(), "error": str(exc)[:240]}


def load_model(name, threads=4, device="auto", allow_download=False):
    """Return (model, diagnostics). A failed GPU never causes a smaller-model downgrade."""
    from stt_native import MODELS, load_model as load_native
    if name in MODELS:
        return load_native(name, threads=threads, device=device, allow_download=allow_download)
    from faster_whisper import WhisperModel
    import numpy as np
    register_runtime()
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("device must be auto, cpu or cuda")
    threads = max(1, min(int(threads), max(1, os.cpu_count() or 1)))
    errors = []
    status = hardware_status() if device != "cpu" else {"cuda_devices": 0}
    candidates = []
    if device != "cpu" and status["cuda_devices"]:
        supported = status.get("compute_types", [])
        compute = next((t for t in ("int8_float16", "int8_float32", "float32") if t in supported), "float32")
        candidates.append(("cuda", compute))
    elif device == "cuda":
        raise RuntimeError("No supported NVIDIA GPU was detected.")
    if device != "cuda":
        candidates.append(("cpu", "int8"))
    for backend, compute in candidates:
        model = None
        try:
            model = WhisperModel(name, device=backend, compute_type=compute,
                                 cpu_threads=threads, local_files_only=not allow_download)
            # Loading weights alone does not test cuBLAS/cuDNN. Execute an encoder/decoder pass.
            list(model.transcribe(np.zeros(16000, dtype=np.float32), language="ar", beam_size=1,
                                  temperature=0.0, condition_on_previous_text=False)[0])
            return model, {"device": backend, "compute_type": compute, "threads": threads,
                           "fallback": errors, "model": name}
        except Exception as exc:
            errors.append(f"{backend}: {str(exc)[:240]}")
            if model is not None:
                del model
                gc.collect()
    raise RuntimeError("Could not load the selected speech model. Download it from Models first. " + " | ".join(errors))
