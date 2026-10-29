"""Arabic patch engine for "Scam With Your Friends".

Edits the Arabic Unity-Localization string tables (Addressables bundle) and the
AI caller language prompts. Every command prints one JSON object per line:
  {"type": "log", "msg": "..."}   progress
  {"type": "result", ...}          final answer (last line)

Commands: detect | export | apply | restore | status
"""
import argparse
import glob
import hashlib
import json
import os
import shutil
import sys
import subprocess
import time

import UnityPy
import dnfile

BACKUP_DIR = "ArabicPatcher_Backup"
TABLES = ["Menu", "Controls"]  # "Commands" holds voice-command trigger words: left untouched
PROMPT_REL = os.path.join("kolkata-json", "dialogue-support.json")
import struct

DIALECTS = {
    "msa": ("simple, clear Modern Standard Arabic (not heavy classical Arabic)", ""),
    "gulf_saudi": ("Saudi Arabic (Najdi/Hijazi, understood across the Gulf)", "وش، ايش، كذا، زين، الحين، مرة، يا شيخ، ابشر، وايد"),
    "gulf_khaleeji": ("Khaleeji Arabic (Kuwait, UAE, Bahrain, Qatar)", "شنو، شلونك، هواية، حيل، يالله، چذي، عيل، مب"),
    "iraqi": ("Iraqi Arabic", "شكو ماكو، شلونك، هواية، خوش، اكو، ماكو، گلت، هسه"),
    "levant_syrian": ("Syrian (Shami) Arabic", "شو، كيفك، هلق، كتير، ليش، يلا، منيح، شو القصة"),
    "levant_lebanese": ("Lebanese Arabic", "شو، كيفك، هلّأ، كتير، عنجد، يلا، منيح، بدّي"),
    "levant_jordan": ("Jordanian/Palestinian Arabic", "شو، كيفك، هسا، كثير، يا زلمة، زاي، بدّي، مش"),
    "egypt": ("Egyptian Arabic", "إيه، ازيك، دلوقتي، قوي، كده، يعني، يا باشا، عايز"),
    "sudan": ("Sudanese Arabic", "شنو، كيف الحال، هسي، شديد، ياخ، مافي، داير"),
    "morocco": ("Moroccan Arabic (Darija)", "شنو، كيداير، دابا، بزاف، واخا، ياك، ديال، فين"),
    "algeria": ("Algerian Arabic (Darja)", "واش، كيراك، دروك، بزاف، يا خويا، راني، كاش"),
    "tunisia": ("Tunisian Arabic", "شنوة، كيفاش، توا، برشا، يعيشك، باهي، موش"),
}


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg):
    out({"type": "log", "msg": msg})


def fail(msg, **extra):
    out({"type": "result", "ok": False, "error": msg, **extra})
    sys.exit(1)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- locating files
def find_data_dir(game):
    for d in glob.glob(os.path.join(game, "*_Data")):
        if os.path.isdir(os.path.join(d, "StreamingAssets", "aa")):
            return d
    return None


def paths(game):
    data = find_data_dir(game)
    if not data:
        return None
    sa = os.path.join(data, "StreamingAssets")
    aa = os.path.join(sa, "aa", "StandaloneWindows64")

    def one(pattern):
        hits = glob.glob(os.path.join(aa, pattern))
        return hits[0] if hits else None

    return {
        "data": data,
        "streaming": sa,
        "ar_tables": one("localization-string-tables-arabic*"),
        "en_tables": one("localization-string-tables-english*"),
        "shared": one("localization-assets-shared*"),
        "prompt": os.path.join(sa, PROMPT_REL),
        "catalog": os.path.join(sa, "aa", "catalog.bin"),
        "moss_dll": os.path.join(data, "Managed", "Kolkata.MossTtsNano.dll"),
        "tmp_dll": os.path.join(data, "Managed", "Unity.TextMeshPro.dll"),
        "uitk_dll": os.path.join(data, "Managed", "UnityEngine.UIElementsModule.dll"),
        "scripts_dll": os.path.join(data, "Managed", "ScriptsAssDef.dll"),
        "fix_dll": os.path.join(data, "Managed", "ArabicFix.dll"),
    }


def check_game(game):
    p = paths(game)
    if not p or not all(p[k] and os.path.exists(p[k]) for k in ("ar_tables", "en_tables", "shared", "prompt", "catalog", "moss_dll", "tmp_dll", "uitk_dll")):
        return None
    return p


# ---------------------------------------------------------------- bundle helpers
def read_tables(bundle_path, suffix):
    env = UnityPy.load(bundle_path)
    res = {}
    for o in env.objects:
        if o.type.name == "MonoBehaviour":
            try:
                t = o.read_typetree()
            except Exception:
                continue
            name = t.get("m_Name", "")
            if name.endswith(suffix) and "m_TableData" in t:
                res[name[: -len(suffix)]] = (o, t)
    return env, res


def read_shared_keys(shared_path):
    env = UnityPy.load(shared_path)
    keys = {}
    for o in env.objects:
        if o.type.name == "MonoBehaviour":
            try:
                t = o.read_typetree()
            except Exception:
                continue
            if "m_Entries" in t:
                keys[t["m_Name"].replace(" Shared Data", "")] = {e["m_Id"]: e["m_Key"] for e in t["m_Entries"]}
    return keys


def collect(p, ar_bundle=None):
    shared = read_shared_keys(p["shared"])
    _, en = read_tables(p["en_tables"], "_en")
    _, ar = read_tables(ar_bundle or p["ar_tables"], "_ar")
    rows = []
    for tn in TABLES:
        if tn not in en:
            continue
        ar_map = {e["m_Id"]: e["m_Localized"] for e in ar[tn][1]["m_TableData"]} if tn in ar else {}
        for e in en[tn][1]["m_TableData"]:
            rows.append({
                "table": tn,
                "id": str(e["m_Id"]),
                "key": shared.get(tn, {}).get(e["m_Id"], ""),
                "en": e["m_Localized"],
                "ar": ar_map.get(e["m_Id"]),
            })
    return rows


# ---------------------------------------------------------------- backup
def backup_root(game):
    return os.path.join(game, BACKUP_DIR)


def manifest_path(game):
    return os.path.join(backup_root(game), "manifest.json")


def load_manifest(game):
    try:
        with open(manifest_path(game), encoding="utf8") as f:
            return json.load(f)
    except Exception:
        return None


def tracked_files(p):
    return (p["ar_tables"], p["prompt"], p["catalog"], p["moss_dll"], p["tmp_dll"], p["uitk_dll"], p["scripts_dll"])


def ensure_backup(game, p):
    """Keep one backup of the ORIGINAL files, and notice game updates.

    A live file is one of: the original we backed up, the patched file we wrote, or something else.
    "Something else" means Steam updated the game, so the old backup is stale and must be replaced by the
    new original (restoring a stale backup over an updated game breaks it)."""
    m = load_manifest(game) or {"created": time.time(), "files": []}
    by_rel = {f["rel"]: f for f in m["files"]}
    patched = m.get("patched_sha256", {})
    for src in tracked_files(p):
        rel = os.path.relpath(src, game)
        dst = os.path.join(backup_root(game), rel)
        cur = sha256(src)
        entry = by_rel.get(rel)
        if entry is None or not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
            if entry is None:
                m["files"].append({"rel": rel, "sha256": cur})
            else:
                entry["sha256"] = cur
            log(f"Backed up {rel}")
        elif cur not in (entry["sha256"], patched.get(rel)):
            shutil.copy2(src, dst)
            entry["sha256"] = cur
            patched.pop(rel, None)
            log(f"Game update detected, refreshed backup of {rel}")
    m["patched_sha256"] = patched
    os.makedirs(backup_root(game), exist_ok=True)
    with open(manifest_path(game), "w", encoding="utf8") as f:
        json.dump(m, f, indent=2)


# ---------------------------------------------------------------- patching
def load_overrides(files):
    merged = {"Menu": {}, "Controls": {}}
    for fp in files or []:
        if not fp or not os.path.exists(fp):
            continue
        with open(fp, encoding="utf8") as f:
            data = json.load(f)
        for tn in merged:
            merged[tn].update({k: v for k, v in (data.get(tn) or {}).items() if isinstance(v, str) and v.strip()})
    return merged


def patch_tables(p, src_bundle, overrides):
    shared = read_shared_keys(p["shared"])
    _, en = read_tables(p["en_tables"], "_en")
    env, ar = read_tables(src_bundle, "_ar")
    changed = {}
    for tn in TABLES:
        if tn not in ar or tn not in en:
            continue
        ov = overrides.get(tn, {})
        if not ov:
            continue
        key_to_id = {k: i for i, k in shared.get(tn, {}).items()}
        text_to_ids = {}
        for e in en[tn][1]["m_TableData"]:
            text_to_ids.setdefault(e["m_Localized"], []).append(e["m_Id"])
        obj, tree = ar[tn]
        existing = {e["m_Id"]: e for e in tree["m_TableData"]}
        n = 0
        for src, text in ov.items():
            ids = [key_to_id[src]] if src in key_to_id else text_to_ids.get(src, [])
            for i in ids:
                if i in existing:
                    if existing[i]["m_Localized"] != text:
                        existing[i]["m_Localized"] = text
                        n += 1
                else:
                    entry = {"m_Id": i, "m_Localized": text, "m_Metadata": {"m_Items": []}}
                    tree["m_TableData"].append(entry)
                    existing[i] = entry
                    n += 1
        if n:
            obj.save_typetree(tree)
            changed[tn] = n
    return env, changed


def build_prompts(src_json, dialect, extra, short=False):
    with open(src_json, encoding="utf8") as f:
        d = json.load(f)
    style, words = DIALECTS.get(dialect, DIALECTS["msa"])
    flavour = (" Typical words of this dialect: " + words + ".") if words else ""
    arabic = (
        " If the language is Arabic (ar): talk like a real person on a phone call, in " + style + ". "
        "Stay consistently in this one dialect." + flavour + " Use natural, everyday spoken phrasing the way people actually talk, never stiff or machine-translated wording. "
        "Use correct grammar and gender agreement, short sentences, and write only in Arabic script "
        "(never Latin letters or Arabizi). Write numbers, prices and letters as Arabic words so the voice reads them well. "
        "Keep names, brands and gameplay tokens such as [[...]] exactly as they are. "
        "Use the Arabic comma ، and question mark ؟. "
        "Never use diacritics (tashkeel), tatweel or stretched letters (write سوّي as سوي, never سُوووويييي), "
        "and no emoji: they break the voice. Answer exactly what the player just said, stay in character, "
        "and never repeat the same sentence twice. "
        "The player's words come from an imperfect speech recognizer, so some Arabic words may be wrong, "
        "misspelled or sound-alike. Work out what the player most likely meant from the conversation so far "
        "and answer that naturally; never mention transcription errors or repeat their garbled words. "
        "Only if the message is truly meaningless, ask very briefly to repeat."
    )
    if short:
        arabic += (
            " IMPORTANT for voice speed: every reply must be ONE short sentence of at most 7 words, "
            "never more than two very short sentences. Long replies make the voice lag, so be brief and punchy."
        )
    if extra and extra.strip():
        arabic += " Extra style notes: " + extra.strip()
    d.setdefault("turn", {})["language"] = "Speak {language} from now on." + arabic
    rep = d.setdefault("repair", {})
    rep["language"] = (
        "Write all dialogue in {language}. Preserve the JSON fields, gameplay tokens and the caller's meaning."
        + arabic
    )
    fpm = d.get("firstPlayerMessages")
    if isinstance(fpm, dict):
        fpm["ar"] = "مرحبًا، لماذا تتصل بي؟"
    return d


def patch_moss_threads(src_dll, threads):
    """MossTtsSingleton.Prompt reads the serialized `cpuThreads` field (default 4) for the ONNX
    thread count. Replace `ldarg.0; ldfld cpuThreads` with `ldc.i4.s N; nop*4` (same stack effect)."""
    if not 1 <= threads <= 64:
        raise ValueError("threads must be 1-64")
    pe = dnfile.dnPE(src_dll)
    t = pe.net.mdtables
    owner = next(td for td in t.TypeDef if str(td.TypeName) == "MossTtsSingleton")
    rid = None
    for f in owner.FieldList:
        if str(f.row.Name) == "cpuThreads":
            rid = f.row_index
    if rid is None:
        raise RuntimeError("cpuThreads field not found")
    pat = b"{" + struct.pack("<I", 0x04000000 | rid)
    data = bytearray(open(src_dll, "rb").read())
    hits = []
    i = data.find(pat)
    while i >= 0:
        hits.append(i)
        i = data.find(pat, i + 1)
    if len(hits) != 1:
        raise RuntimeError(f"Unexpected code layout ({len(hits)} matches); the game was probably updated")
    i = hits[0]
    data[i:i + 6] = bytes([0x1F, threads, 0x00, 0x00, 0x00, 0x00])
    return bytes(data)


def patch_catalog(src_catalog, orig_bundle, new_size):
    """Addressables rejects a bundle whose CRC differs from the catalog entry.
    The entry is [crc:u32][bundleSize:u32]; set crc=0 (= no check) and the new size."""
    data = bytearray(open(src_catalog, "rb").read())
    pat = struct.pack("<I", os.path.getsize(orig_bundle))
    hits = [i for i in range(4, len(data) - 3) if data[i:i + 4] == pat]
    if len(hits) != 1:
        raise RuntimeError(f"Could not locate the bundle entry in catalog.bin ({len(hits)} matches)")
    i = hits[0]
    data[i - 4:i] = struct.pack("<I", 0)
    data[i:i + 4] = struct.pack("<I", new_size)
    return bytes(data)


def is_junction(path):
    try:
        return os.path.isjunction(path)
    except AttributeError:
        return False


def fast_models_apply(p, target_root):
    """Move the Arabic voice model to a fast drive and link it back (big speed-up when the game is on a slow/USB drive)."""
    src = os.path.join(p["streaming"], "moss-tts-nano")
    if is_junction(src):
        return
    dst = os.path.join(target_root, "moss-tts-nano")
    log("Copying voice model to the fast drive…")
    if not os.path.isdir(dst):
        shutil.copytree(src, dst)
    backup = src + ".orig-backup"
    if os.path.exists(backup):
        shutil.rmtree(backup)
    os.rename(src, backup)
    r = subprocess.run(["cmd", "/c", "mklink", "/J", src, dst], capture_output=True, text=True)
    if r.returncode != 0:
        os.rename(backup, src)
        raise RuntimeError("Could not create the link: " + (r.stderr or r.stdout).strip())
    log("Voice model now loads from " + dst)


def fast_models_restore(p):
    src = os.path.join(p["streaming"], "moss-tts-nano")
    backup = src + ".orig-backup"
    if is_junction(src) and os.path.isdir(backup):
        os.rmdir(src)  # removes only the link
        os.rename(backup, src)
        log("Voice model folder restored")


FIX_MANIFEST = "fix-manifest.json"


def tts_dir_path(p):
    return os.path.join(p["data"], "ArabicTTS")


def install_helper(source, target_dir):
    src = os.path.join(source, "supertts.exe")
    if not os.path.exists(src):
        raise RuntimeError("Helper not found: " + src)
    os.makedirs(target_dir, exist_ok=True)
    dst = os.path.join(target_dir, "supertts.exe")
    if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src):
        shutil.copy2(src, dst)
    return dst


def run_patch_tool(source, args, p, game):
    exe = os.path.join(source, "ArabicPatch.exe")
    if not os.path.exists(exe):
        raise RuntimeError("Patch tool not found: " + exe)
    shutil.copy2(os.path.join(source, "ArabicFix.dll"), p["fix_dll"])
    r = subprocess.run([exe] + args, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("Patch failed: " + (r.stderr or r.stdout).strip())


def fix_patch(game, p, source):
    """Make TextMeshPro and UI Toolkit text setters call ArabicFix (shaping + RTL). Patches from the backed-up originals."""
    exe = os.path.join(source, "ArabicPatch.exe")
    lib = os.path.join(source, "ArabicFix.dll")
    if not (os.path.exists(exe) and os.path.exists(lib)):
        raise RuntimeError("Fix files not found: " + source)
    managed = os.path.dirname(p["tmp_dll"])
    orig = os.path.join(backup_root(game), os.path.relpath(managed, game))
    shutil.copy2(lib, p["fix_dll"])
    r = subprocess.run([exe, p["fix_dll"], orig, managed, managed], capture_output=True, text=True)
    if r.returncode != 0:
        fix_unpatch(game, p)
        raise RuntimeError("Arabic text fix failed: " + (r.stderr or r.stdout).strip())
    log("Installed Arabic text fix (TextMeshPro + UI Toolkit)")


def fix_unpatch(game, p, keep_lib=False):
    root = backup_root(game)
    changed = False
    for key in ("tmp_dll", "uitk_dll"):
        src = os.path.join(root, os.path.relpath(p[key], game))
        if os.path.exists(src):
            shutil.copy2(src, p[key])
    if not keep_lib and os.path.exists(p["fix_dll"]):
        os.remove(p["fix_dll"])
        changed = True
        ini = os.path.join(os.path.dirname(p["fix_dll"]), "ArabicFix.ini")
        if os.path.exists(ini):
            os.remove(ini)
    return changed


def fix_remove(game):
    mp = os.path.join(backup_root(game), FIX_MANIFEST)
    if not os.path.exists(mp):
        return False
    with open(mp, encoding="utf8") as f:
        files = json.load(f)["files"]
    dirs = set()
    for rel in files:
        fp = os.path.join(game, rel)
        if os.path.exists(fp):
            os.remove(fp)
        dirs.add(os.path.dirname(fp))
    for d in sorted(dirs, key=len, reverse=True):
        try:
            os.rmdir(d)
        except OSError:
            pass
    for extra in ("BepInEx/plugins", "BepInEx/config", "BepInEx/patchers", "BepInEx/cache", "BepInEx"):
        try:
            os.rmdir(os.path.join(game, extra))
        except OSError:
            pass
    os.remove(mp)
    log("Removed Arabic text fix")
    return True


# ---------------------------------------------------------------- commands
def cmd_detect(a):
    p = check_game(a.game)
    if not p:
        fail("This folder does not look like Scam With Your Friends.")
    m = load_manifest(a.game)
    out({"type": "result", "ok": True, "data": p["data"], "patched": bool(m)})


def set_speech_provider(value):
    """Edit the game's own settings file. Returns True when the value was changed."""
    import re
    path = os.path.join(os.path.expanduser("~"), "AppData", "LocalLow", "Jatater Worldwide", "Scam With Your Friends", "MetaSave", "local.json")
    if not os.path.exists(path):
        return False
    with open(path, encoding="utf8") as f:
        text = f.read()
    new = re.sub(r'("SpeechRecognition\.Provider"\s*:\s*")[^"]*(")', lambda m: m.group(1) + value + m.group(2), text)
    if '"SpeechRecognition.Provider"' not in new:
        new = new.rstrip().rstrip("}").rstrip() + ',\n    "SpeechRecognition.Provider": "' + value + '"\n}'
    if new == text:
        return False
    shutil.copy2(path, path + ".before-arabic")
    with open(path, "w", encoding="utf8") as f:
        f.write(new)
    return True


def cmd_status(a):
    p = check_game(a.game)
    if not p:
        fail("Game not found.")
    m = load_manifest(a.game)
    if not m:
        out({"type": "result", "ok": True, "patched": False})
        return
    patched = m.get("patched_sha256", {})
    cur = {f["rel"]: sha256(os.path.join(a.game, f["rel"])) for f in m["files"]}
    modified = any(cur[f["rel"]] != f["sha256"] for f in m["files"])
    # "intact": every tracked file is exactly what we wrote. Anything else after a patch means a game update.
    intact = bool(patched) and all(cur.get(rel) == h for rel, h in patched.items() if rel in cur)
    out({"type": "result", "ok": True, "patched": True, "modified": modified, "intact": intact,
         "needs_reapply": bool(patched) and not intact, "created": m.get("created")})


def cmd_export(a):
    p = check_game(a.game)
    if not p:
        fail("Game not found.")
    m = load_manifest(a.game)
    src = os.path.join(backup_root(a.game), os.path.relpath(p["ar_tables"], a.game)) if m else p["ar_tables"]
    rows = collect(p, src)
    out({"type": "result", "ok": True, "rows": rows})


def cmd_apply(a):
    p = check_game(a.game)
    if not p:
        fail("Game not found.")
    log("Creating backup of the original files…")
    ensure_backup(a.game, p)
    root = backup_root(a.game)
    src_bundle = os.path.join(root, os.path.relpath(p["ar_tables"], a.game))
    src_prompt = os.path.join(root, os.path.relpath(p["prompt"], a.game))

    result = {"type": "result", "ok": True}
    if a.text:
        log("Patching Arabic text tables…")
        overrides = load_overrides(a.overrides)
        env, changed = patch_tables(p, src_bundle, overrides)
        data = env.file.save(packer="original")
        tmp = p["ar_tables"] + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, p["ar_tables"])
        cat = patch_catalog(os.path.join(root, os.path.relpath(p["catalog"], a.game)), src_bundle, len(data))
        with open(p["catalog"], "wb") as f:
            f.write(cat)
        result["text_changed"] = changed
        log("Text patched: " + ", ".join(f"{k}: {v}" for k, v in changed.items()))
    else:
        shutil.copy2(src_bundle, p["ar_tables"])
        shutil.copy2(os.path.join(root, os.path.relpath(p["catalog"], a.game)), p["catalog"])

    if a.prompts:
        log("Improving Arabic AI-caller instructions…")
        d = build_prompts(src_prompt, a.dialect, a.extra, a.short)
        with open(p["prompt"], "w", encoding="utf8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        result["prompts"] = True
    else:
        shutil.copy2(src_prompt, p["prompt"])

    if a.threads:
        log(f"Raising Arabic voice CPU threads to {a.threads}…")
        data = patch_moss_threads(os.path.join(root, os.path.relpath(p["moss_dll"], a.game)), a.threads)
        with open(p["moss_dll"], "wb") as f:
            f.write(data)
        result["threads"] = a.threads
    else:
        shutil.copy2(os.path.join(root, os.path.relpath(p["moss_dll"], a.game)), p["moss_dll"])

    ini_path = os.path.join(os.path.dirname(p["fix_dll"]), "ArabicFix.ini")
    tts_dir = os.path.join(p["data"], "ArabicTTS")
    ini = []
    scripts_backup = os.path.join(root, os.path.relpath(p["scripts_dll"], a.game))
    shutil.copy2(scripts_backup, p["scripts_dll"])
    if a.stt:
        log("Tuning Arabic speech recognition…")
        run_patch_tool(a.fix_source, ["stt", os.path.join(a.fix_source, "ArabicFix.dll"), p["scripts_dll"]], p, a.game)
        ini += ["stt_language=" + a.stt_language, "stt_prompt=" + a.stt_prompt.replace(chr(10), " ")]
        result["stt"] = True
        if a.stt_helper:
            helper = install_helper(a.fix_source, tts_dir_path(p))
            log("Downloading the speech-recognition model (first time only)…")
            r = subprocess.run([helper, "--download-stt"], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError("Recognition model download failed (check your internet): " + (r.stderr or r.stdout).strip()[-300:])
            ini += ["stt_helper=" + helper, "stt_model=small", "stt_threads=" + str(a.stt_threads)]
            result["stt_helper"] = True
            if set_speech_provider("Moonshine"):
                log("Speech recognition setting switched to Moonshine (the game's own hook point)")
    if a.prebuffer or a.tts:
        patch_args = ["moss", os.path.join(a.fix_source, "ArabicFix.dll"), p["moss_dll"]] + (["tts"] if a.tts else [])
        if a.prebuffer:
            log("Smoothing Arabic voice (buffering before playback)…")
        run_patch_tool(a.fix_source, patch_args, p, a.game)
        ini.append("prebuffer=" + str(a.prebuffer_seconds if a.prebuffer else 0))
        result["prebuffer"] = bool(a.prebuffer)
    if a.tts:
        helper = install_helper(a.fix_source, tts_dir)
        log("Downloading the Arabic voice model (first time only)…")
        r = subprocess.run([helper, "--download"], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("Voice model download failed (check your internet): " + (r.stderr or r.stdout).strip()[-300:])
        ini += ["tts=supertonic", "tts_exe=" + helper, "tts_voices=" + a.tts_voices, "tts_threads=" + str(a.tts_threads)]
        result["tts"] = True
    elif os.path.isdir(tts_dir) and not (a.stt and a.stt_helper):
        shutil.rmtree(tts_dir, ignore_errors=True)
    if ini:
        with open(ini_path, "w", encoding="utf8") as f:
            f.write(chr(10).join(ini) + chr(10))
    elif os.path.exists(ini_path):
        os.remove(ini_path)

    fix_remove(a.game)  # clean up the earlier BepInEx-based attempt, if present
    if a.fix:
        fix_patch(a.game, p, a.fix_source)
        result["fix"] = True
    else:
        fix_unpatch(a.game, p, keep_lib=bool(a.prebuffer or a.tts or a.stt))

    if a.fast_models:
        fast_models_apply(p, a.fast_models)
        result["fast_models"] = True

    # refresh manifest hashes to the patched files so "modified by update" can be detected
    m = load_manifest(a.game)
    m["patched_sha256"] = {os.path.relpath(x, a.game): sha256(x) for x in tracked_files(p)}
    with open(manifest_path(a.game), "w", encoding="utf8") as f:
        json.dump(m, f, indent=2)
    out(result)


def cmd_restore(a):
    m = load_manifest(a.game)
    if not m:
        fail("No backup found, nothing to restore.")
    patched = m.get("patched_sha256", {})
    for f in m["files"]:
        src = os.path.join(backup_root(a.game), f["rel"])
        dst = os.path.join(a.game, f["rel"])
        if os.path.exists(dst) and sha256(dst) not in (f["sha256"], patched.get(f["rel"])):
            log(f"Skipped {f['rel']} (the game was updated since the backup)")
            continue
        shutil.copy2(src, dst)
        log(f"Restored {f['rel']}")
    p = check_game(a.game)
    if p and os.path.exists(p["fix_dll"]):
        os.remove(p["fix_dll"])
        ini = os.path.join(os.path.dirname(p["fix_dll"]), "ArabicFix.ini")
        if os.path.exists(ini):
            os.remove(ini)
    fix_remove(a.game)
    if p:
        shutil.rmtree(os.path.join(p["data"], "ArabicTTS"), ignore_errors=True)
        fast_models_restore(p)
    if a.remove_backup:
        shutil.rmtree(backup_root(a.game), ignore_errors=True)
    out({"type": "result", "ok": True})


def _ps(cmd):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", cmd], capture_output=True, text=True, timeout=20)
        return r.stdout.strip()
    except Exception:
        return ""


def cmd_analyze(a):
    """Inspect this PC and recommend settings (threads, voice buffering, fast model drive)."""
    import ctypes

    class MEM(ctypes.Structure):
        _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                    ("pt", ctypes.c_ulonglong), ("pa", ctypes.c_ulonglong), ("vt", ctypes.c_ulonglong), ("va", ctypes.c_ulonglong),
                    ("ex", ctypes.c_ulonglong)]

    mem = MEM()
    mem.l = ctypes.sizeof(MEM)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem))
    logical = os.cpu_count() or 4
    physical = int(_ps("(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum") or 0) or max(2, logical // 2)
    cpu = _ps("(Get-CimInstance Win32_Processor | Select-Object -First 1).Name")
    gpu = _ps("(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name")

    drive = os.path.splitdrive(os.path.abspath(a.game))[0].rstrip(":")
    bus = _ps(f"(Get-Partition -DriveLetter {drive} | Get-Disk | Get-PhysicalDisk | Select-Object -First 1).BusType") if drive else ""
    media = _ps(f"(Get-Partition -DriveLetter {drive} | Get-Disk | Get-PhysicalDisk | Select-Object -First 1).MediaType") if drive else ""
    sys_drive = os.environ.get("SystemDrive", "C:").rstrip(":")
    free_sys = shutil.disk_usage(sys_drive + ":\\").free / 1e9

    # sequential read speed of the voice model on the game drive (best effort; cache can make it look faster)
    speed = None
    p = check_game(a.game)
    if p:
        moss = os.path.join(p["streaming"], "moss-tts-nano")
        big = []
        for dp, _, fs in os.walk(moss):
            for f in fs:
                fp = os.path.join(dp, f)
                big.append((os.path.getsize(fp), fp))
        if big and not is_junction(moss):
            size, fp = sorted(big)[len(big) // 2]
            t0 = time.time()
            n = 0
            with open(fp, "rb") as fh:
                while n < 40 * 1048576:
                    chunk = fh.read(8 * 1048576)
                    if not chunk:
                        break
                    n += len(chunk)
            dt = max(time.time() - t0, 1e-3)
            speed = n / 1048576 / dt

    slow_drive = bus.upper() == "USB" or media.upper() == "HDD" or (speed is not None and speed < 150)
    on_system = drive.upper() == sys_drive.upper()
    rec = {
        "threads": max(4, min(10, round(logical * 0.66))),
        "fast_models": bool(slow_drive and not on_system and free_sys >= 2.5),
        "prebuffer_seconds": 10 if logical < 16 else 3,
        "reasons": [],
    }
    if slow_drive and not on_system:
        rec["reasons"].append("قرص اللعبة بطيء (" + (bus or media or "?") + (f"، {speed:.0f} MB/s" if speed else "") + "): تحميل نموذج الصوت أسرع من القرص الرئيسي")
    rec["reasons"].append(f"المعالج {logical} خيط: صوت العربي يتولّد عليه، نوصي بـ{rec['threads']} خيوط")
    if rec["prebuffer_seconds"] >= 10:
        rec["reasons"].append("الصوت يبدأ بعد اكتمال الجملة حتى يطلع نقي بدون تقطيع")
    out({"type": "result", "ok": True, "cpu": cpu, "logical": logical, "physical": physical, "ram_gb": round(mem.total / 1e9, 1),
         "gpu": gpu, "game_drive": drive, "bus": bus, "media": media, "read_mb_s": None if speed is None else round(speed),
         "free_system_gb": round(free_sys, 1), "recommend": rec})


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("detect", "status", "export", "apply", "restore", "analyze"):
        sp = sub.add_parser(name)
        sp.add_argument("--game", required=True)
        if name == "apply":
            sp.add_argument("--overrides", nargs="*", default=[])
            sp.add_argument("--text", action="store_true")
            sp.add_argument("--prompts", action="store_true")
            sp.add_argument("--dialect", default="msa")
            sp.add_argument("--extra", default="")
            sp.add_argument("--threads", type=int, default=0)
            sp.add_argument("--short", action="store_true")
            sp.add_argument("--fix", action="store_true")
            sp.add_argument("--prebuffer", action="store_true")
            sp.add_argument("--stt", action="store_true")
            sp.add_argument("--stt-language", default="ar")
            sp.add_argument("--stt-helper", action="store_true")
            sp.add_argument("--stt-threads", type=int, default=6)
            sp.add_argument("--stt-prompt", default="مرحباً، أنا أتحدث بالعربية مع بعض الكلمات الإنجليزية مثل: subscription، gift card، credit card، password، Bitcoin، Steam، email، number، security code، OK، hello.")
            sp.add_argument("--tts", action="store_true")
            sp.add_argument("--tts-voices", default="M1,F1,M2,F2,M3,F3,M4,F4,M5,F5")
            sp.add_argument("--tts-threads", type=int, default=4)
            sp.add_argument("--prebuffer-seconds", type=float, default=1.5)
            sp.add_argument("--fast-models", default="")
            sp.add_argument("--fix-source", default="")
        if name == "restore":
            sp.add_argument("--remove-backup", action="store_true")
    a = ap.parse_args()
    try:
        {"detect": cmd_detect, "status": cmd_status, "export": cmd_export, "apply": cmd_apply, "restore": cmd_restore, "analyze": cmd_analyze}[a.cmd](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()

