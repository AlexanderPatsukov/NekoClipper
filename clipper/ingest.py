"""Получение исходника: скачивание (YouTube/Twitch/…), звук, чат, распознавание речи."""
from __future__ import annotations

import gc
import json
import os
import site
import sys
import wave
from pathlib import Path

import numpy as np

from .core import ffbin, load_config, pdir, run_ffmpeg

SR = 16000


# ---------------------------------------------------------------- скачивание

def fetch_info(url: str) -> dict:
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as y:
        info = y.extract_info(url, download=False)
    return {
        "id": f"{(info.get('extractor_key') or 'video').lower()}_{info.get('id')}",
        "title": info.get("title") or "Без названия",
        "channel": info.get("uploader") or info.get("channel") or "",
        "duration": float(info.get("duration") or 0),
        "live_status": info.get("live_status") or "",
    }


def format_sort(dl: dict) -> list[str]:
    """Порядок выбора дорожки yt-dlp: разрешение → кадры → кодек.
    H.264 у YouTube есть только до 1080p, поэтому выше 1080 (или codec=any) берём VP9/AV1."""
    h = int(dl.get("max_height") or 0)
    fps = int(dl.get("fps") or 60)
    codec = dl.get("codec") or "auto"
    h264 = codec == "h264" or (codec == "auto" and 0 < h <= 1080)
    return ([f"res:{h}"] if h else ["res"]) + [f"fps:{fps}"] + (["vcodec:h264"] if h264 else []) + ["acodec:m4a"]


def _hook(progress):
    def hook(st):
        if progress and st.get("status") == "downloading":
            total = st.get("total_bytes") or st.get("total_bytes_estimate") or 0
            if total:
                progress(min(0.99, st.get("downloaded_bytes", 0) / total))
    return hook


def redownload(url: str, pid: str, dl: dict, progress=None) -> Path:
    """Перекачивает видео в другом качестве; звук, расшифровка и клипы остаются."""
    import os
    import time

    import yt_dlp
    d = pdir(pid)
    for f in d.glob("source.new.*"):
        f.unlink(missing_ok=True)
    opts = {"format_sort": format_sort(dl), "merge_output_format": "mp4", "outtmpl": str(d / "source.new.%(ext)s"),
            "quiet": True, "no_warnings": True, "noprogress": True, "progress_hooks": [_hook(progress)],
            "ffmpeg_location": str(Path(ffbin("ffmpeg")).parent), "concurrent_fragment_downloads": 4}
    with yt_dlp.YoutubeDL(opts) as y:
        y.download([url])
    new = d / "source.new.mp4"
    if not new.exists():
        raise RuntimeError("Скачивание не удалось: файл не появился")
    for _ in range(20):         # старый файл может быть занят плеером — ждём, пока отпустит
        try:
            os.replace(new, d / "source.mp4")
            return d / "source.mp4"
        except PermissionError:
            time.sleep(0.5)
    raise RuntimeError("Старое видео занято (открыт плеер?) — закрой просмотр и попробуй ещё раз")


def download(url: str, pid: str, progress=None) -> Path:
    import yt_dlp
    d = pdir(pid)
    d.mkdir(parents=True, exist_ok=True)
    out = d / "source.mp4"
    if out.exists() and out.stat().st_size > 0:
        return out
    cfg = load_config()

    opts = {
        "format_sort": format_sort(cfg["download"]),
        "merge_output_format": "mp4",
        "outtmpl": str(d / "source.%(ext)s"),
        "writesubtitles": True,
        "subtitleslangs": ["live_chat", "rechat"],
        "quiet": True, "no_warnings": True, "noprogress": True,
        "progress_hooks": [_hook(progress)],
        "ffmpeg_location": str(Path(ffbin("ffmpeg")).parent),
        "concurrent_fragment_downloads": 4,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as y:
            y.download([url])
    except Exception:
        if not out.exists():       # чат мог сломать загрузку — пробуем без него
            opts["writesubtitles"] = False
            with yt_dlp.YoutubeDL(opts) as y:
                y.download([url])
    if not out.exists():
        cands = [f for f in d.glob("source.*") if f.suffix in (".mkv", ".webm", ".mov", ".ts")]
        if not cands:
            raise RuntimeError("Скачивание не удалось: файл не появился")
        run_ffmpeg(["-i", str(cands[0]), "-c", "copy", str(out)])
        cands[0].unlink(missing_ok=True)
    return out


def fetch_chat(url: str, pid: str) -> int:
    """Скачивает только чат стрима (без видео) и пересобирает chat.json. Возвращает число сообщений."""
    import yt_dlp
    d = pdir(pid)
    opts = {"skip_download": True, "writesubtitles": True, "subtitleslangs": ["live_chat", "rechat"],
            "outtmpl": str(d / "source.%(ext)s"), "quiet": True, "no_warnings": True, "noprogress": True}
    with yt_dlp.YoutubeDL(opts) as y:
        y.download([url])
    (d / "chat.json").unlink(missing_ok=True)
    return len(load_chat(pid))


# ---------------------------------------------------------------- звук

def extract_audio(src: Path, pid: str, duration: float, progress=None) -> Path:
    wav = pdir(pid) / "audio.wav"
    if wav.exists() and wav.stat().st_size > 1000:
        return wav
    run_ffmpeg(["-i", str(src), "-vn", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(wav)],
               duration, progress)
    return wav


def loudness_curve(wav: Path) -> np.ndarray:
    """Громкость (дБ) с шагом 1 секунда."""
    out = []
    with wave.open(str(wav), "rb") as w:
        while True:
            raw = w.readframes(SR * 60)
            if not raw:
                break
            x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            n = len(x) // SR
            if n == 0:
                break
            rms = np.sqrt((x[: n * SR].reshape(n, SR) ** 2).mean(axis=1) + 1e-10)
            out.append(20 * np.log10(rms))
    return np.concatenate(out) if out else np.zeros(1, dtype=np.float32)


# ---------------------------------------------------------------- чат

def _yt_text(runs) -> str:
    parts = []
    for r in runs or []:
        if "text" in r:
            parts.append(r["text"])
        elif "emoji" in r:
            sc = r["emoji"].get("shortcuts") or []
            parts.append(sc[0] if sc else r["emoji"].get("emojiId", ""))
    return "".join(parts)


def load_chat(pid: str) -> list[dict]:
    """Сообщения чата [{t, user, text}] из реплея YouTube или Twitch."""
    d = pdir(pid)
    cache = d / "chat.json"
    if cache.exists():
        return json.loads(cache.read_text("utf-8"))
    msgs: list[dict] = []
    yt = d / "source.live_chat.json"
    tw = d / "source.rechat.json"
    try:
        if yt.exists():
            for line in yt.read_text("utf-8", "replace").splitlines():
                try:
                    act = json.loads(line).get("replayChatItemAction") or {}
                    t = int(act.get("videoOffsetTimeMsec") or 0) / 1000
                    for a in act.get("actions") or []:
                        item = (a.get("addChatItemAction") or {}).get("item") or {}
                        r = item.get("liveChatTextMessageRenderer") or item.get("liveChatPaidMessageRenderer")
                        if r:
                            msgs.append({"t": t, "user": (r.get("authorName") or {}).get("simpleText", ""),
                                         "text": _yt_text((r.get("message") or {}).get("runs"))})
                except Exception:
                    continue
        elif tw.exists():
            for c in json.loads(tw.read_text("utf-8", "replace")):
                try:
                    msgs.append({"t": float(c["content_offset_seconds"]),
                                 "user": (c.get("commenter") or {}).get("display_name", ""),
                                 "text": (c.get("message") or {}).get("body", "")})
                except Exception:
                    continue
    except Exception:
        msgs = []
    msgs.sort(key=lambda m: m["t"])
    cache.write_text(json.dumps(msgs, ensure_ascii=False), "utf-8")
    return msgs


# ---------------------------------------------------------------- речь

def _cuda_dlls() -> None:
    """Подключает DLL от pip-пакетов nvidia-* (нужны ctranslate2 на Windows)."""
    if sys.platform != "win32":
        return
    for sp in site.getsitepackages():
        base = Path(sp) / "nvidia"
        if base.exists():
            for b in base.glob("*/bin"):
                try:
                    os.add_dll_directory(str(b))
                except OSError:
                    pass
                os.environ["PATH"] = str(b) + os.pathsep + os.environ.get("PATH", "")


def transcribe(wav: Path, pid: str, duration: float, progress=None) -> list[dict]:
    """Распознаёт речь с таймкодами слов. Результат кэшируется в transcript.json."""
    cache = pdir(pid) / "transcript.json"
    if cache.exists():
        return json.loads(cache.read_text("utf-8"))["segments"]
    _cuda_dlls()
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    cfg = load_config()["whisper"]
    attempts = []
    if cfg["device"] in ("auto", "cuda"):
        attempts.append(("cuda", "float16", cfg["model"]))
    if cfg["device"] in ("auto", "cpu"):
        attempts.append(("cpu", "int8", cfg["model"] if cfg["device"] == "cpu" else "small"))

    last_err = None
    for device, ctype, name in attempts:
        model = None
        try:
            model = WhisperModel(name, device=device, compute_type=ctype)
            pipe = BatchedInferencePipeline(model=model)
            it, info = pipe.transcribe(
                str(wav), language=cfg.get("language") or None, word_timestamps=True,
                vad_filter=True, batch_size=16 if device == "cuda" else 4,
                condition_on_previous_text=False)
            segs = []
            for s in it:
                words = [{"s": round(w.start, 2), "e": round(w.end, 2), "w": w.word.strip()}
                         for w in (s.words or []) if w.word.strip()]
                text = s.text.strip()
                if text:
                    segs.append({"start": round(s.start, 2), "end": round(s.end, 2),
                                 "text": text, "words": words})
                if progress and duration:
                    progress(min(0.99, s.end / duration))
            segs.sort(key=lambda x: x["start"])
            cache.write_text(json.dumps({"language": info.language, "device": device, "model": name,
                                         "segments": segs}, ensure_ascii=False), "utf-8")
            return segs
        except Exception as e:      # нет CUDA-библиотек и т.п. — пробуем следующий вариант
            last_err = e
        finally:
            del model
            gc.collect()
    raise RuntimeError(f"Не удалось распознать речь: {last_err}")
