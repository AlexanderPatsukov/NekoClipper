"""Конфиг, пути, хранилище проектов и запуск ffmpeg."""
from __future__ import annotations

import copy
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "projects"
ASSETS = ROOT / "data" / "assets"       # загруженные картинки и логотипы
CONFIG_PATH = ROOT / "config.json"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

DEFAULT_CONFIG = {
    "llm": {
        "enabled": True,
        "base_url": "http://127.0.0.1:5000/v1",
        "api_key": "",
        "model": "",            # пусто = взять первую модель с сервера
        "temperature": 0.4,
        "max_tokens": 6000,     # с запасом: «думающие» модели тратят токены на рассуждения
        "timeout": 600,
    },
    "whisper": {
        "model": "large-v3-turbo",
        "device": "auto",       # auto | cuda | cpu
        "language": "",         # пусто = автоопределение
    },
    "download": {"max_height": 1080, "fps": 60, "codec": "auto"},   # max_height 0 — лучшее; codec auto|h264|any
    "highlights": {
        "count": 0,             # 0 = авто (примерно 1 клип на 5 минут стрима)
        "min_len": 18,
        "max_len": 58,
        "target_len": 38,
    },
    "render": {
        "encoder": "auto",      # auto | nvenc | x264
        "quality": 21,
        "max_fps": 60,
        "font": "Arial Black",
        "font_size": 78,
        "uppercase": True,
        "highlight_color": "#FFE500",
        "normalize_audio": True,
    },
    "ffmpeg_dir": "",
    "last_layout": None,
    "presets": [],              # сохранённые пресеты раскладки [{name, layout}]        # последняя раскладка из редактора — с неё стартуют новые стримы
}

DEFAULT_LAYOUT = {
    "mode": "split",            # split (вебка + игра стопкой) | pip (вебка поверх) | fit_blur | fill
    "zoom": 1.0,                # fit_blur: приближение
    "focus_x": 0.5,
    "focus_y": 0.5,
    "game": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0},
    "game_zoom": 0.0,           # split: 0 — игра целиком, 1 — заполняет всё свободное место
    "cam_source": "auto",       # auto (искать в каждом клипе) | manual | off
    "cam": None,                # маска вебки; None — ещё не задана
    "cam_pos": "top",           # split: top | bottom
    "cam_ratio": 0.0,           # split: доля высоты под вебку; 0 — по её пропорциям
    "pip_size": 0.45,           # pip: ширина вебки в долях кадра
    "pip_x": 0.5,
    "pip_y": 0.05,
    "cam_zoom": 1.0,            # приближение внутри маски вебки
    "cam_dy": 0,                # split: ручной сдвиг вебки по вертикали (пиксели кадра 1080x1920)
    "game_dy": 0,               # split / fit_blur: ручной сдвиг игры по вертикали
    "bg_dim": 0.12,             # затемнение размытого фона
    "subtitles": True,
    "title_overlay": True,
    "sub_pos": 0.75,
    "title_pos": None,          # None — авто, иначе доля высоты кадра
    "font": "Arial Black",
    "sub_size": 78,
    "sub_color": "#FFFFFF",
    "sub_hi": "#FFE500",
    "sub_outline": 7,
    "sub_words": 3,             # слов в одной строке субтитров
    "uppercase": True,
    "title_size": 56,
    "title_fg": "#101010",
    "title_bg": "#FFFFFF",
    "game_box": None,           # свободное окно игры в кадре: доли {x, y, w, h}; None — по раскладке
    "cam_box": None,            # то же для вебки
    "game_crop": None,          # обрезка игры с краёв: доли {l, t, r, b}
    "cam_crop": None,
    "out_w": 1080,              # размер итогового кадра
    "out_h": 1920,
    "fps": 0,                   # 0 — как в исходнике
    "quality": 21,              # меньше — лучше качество и больше файл
    # экспорт
    "container": "mp4",         # mp4 | mov | mkv | webm
    "vcodec": "h264",           # h264 | hevc | av1 | vp9 | prores
    "hw": "auto",               # auto (видеокарта, если умеет) | gpu | cpu
    "rate": "quality",          # quality (постоянное качество) | bitrate (заданный битрейт)
    "bitrate": 12,              # Мбит/с, для rate=bitrate
    "speed": "balanced",        # fast | balanced | quality
    "abitrate": 192,            # кбит/с звука
    # дополнительные куски исходного кадра: [{src: доли исходника, box: доли шортса}] (старый формат, см. layers)
    "extras": [],
    # слои поверх шортса: текст, картинки, куски кадра — каждый со своим временем показа
    "layers": [],
    # чат стрима поверх шортса
    "chat": False,
    "chat_box": {"x": 0.04, "y": 0.56, "w": 0.66, "h": 0.17},
    "chat_size": 34,
    "chat_bg": 0.45,            # непрозрачность подложки
    "chat_shift": 0.0,          # показывать сообщения на столько секунд раньше
}

_lock = threading.RLock()


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config() -> dict:
    with _lock:
        user = {}
        if CONFIG_PATH.exists():
            try:
                user = json.loads(CONFIG_PATH.read_text("utf-8"))
            except Exception:
                user = {}
        return _merge(DEFAULT_CONFIG, user)


def save_config(cfg: dict) -> dict:
    with _lock:
        merged = _merge(DEFAULT_CONFIG, cfg)
        CONFIG_PATH.write_text(json.dumps(merged, ensure_ascii=False, indent=2), "utf-8")
        return merged


# ---------------------------------------------------------------- ffmpeg

BIN = ROOT / "bin"
# Официальные сборки, на которые ссылается ffmpeg.org; вторая — запасная.
FFMPEG_URLS = [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
]


def _find_ff(name: str) -> str | None:
    exe = name + (".exe" if sys.platform == "win32" else "")
    d = load_config().get("ffmpeg_dir") or ""
    for cand in ([Path(d) / exe] if d else []):
        if cand.exists():
            return str(cand)
    found = shutil.which(name)
    if found:
        return found
    if (BIN / exe).exists():
        return str(BIN / exe)
    return None


def download_ffmpeg(log=print) -> None:
    """Скачивает ffmpeg и ffprobe в папку bin рядом с программой (только Windows)."""
    import zipfile

    import requests
    BIN.mkdir(exist_ok=True)
    tmp = BIN / "ffmpeg.zip.part"
    last_err = None
    for url in FFMPEG_URLS:
        try:
            log(f"ffmpeg не найден — скачиваю (один раз, около 100 МБ): {url}")
            with requests.get(url, stream=True, timeout=60) as r:
                r.raise_for_status()
                total, done, shown = int(r.headers.get("content-length") or 0), 0, -1
                with open(tmp, "wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        pct = done * 100 // total if total else 0
                        if total and pct // 10 != shown:
                            shown = pct // 10
                            log(f"  {pct}%")
            with zipfile.ZipFile(tmp) as z:
                for info in z.infolist():
                    base = info.filename.rsplit("/", 1)[-1].lower()
                    if base in ("ffmpeg.exe", "ffprobe.exe"):
                        (BIN / base).write_bytes(z.read(info))
            tmp.unlink(missing_ok=True)
            if (BIN / "ffmpeg.exe").exists() and (BIN / "ffprobe.exe").exists():
                log("ffmpeg установлен в " + str(BIN))
                return
            last_err = "в архиве нет ffmpeg.exe/ffprobe.exe"
        except Exception as e:
            last_err = e
            tmp.unlink(missing_ok=True)
    raise RuntimeError(f"Не удалось скачать ffmpeg: {last_err}")


def ensure_ffmpeg(log=print) -> None:
    """Проверяет, что ffmpeg и ffprobe доступны; на Windows при отсутствии скачивает сам."""
    with _lock:
        if _find_ff("ffmpeg") and _find_ff("ffprobe"):
            return
        if sys.platform != "win32":
            raise RuntimeError("Не найден ffmpeg. Установи его: «sudo apt install ffmpeg» или «brew install ffmpeg».")
        download_ffmpeg(log)


def ffbin(name: str) -> str:
    found = _find_ff(name)
    if not found:
        ensure_ffmpeg()
        found = _find_ff(name)
    if not found:
        raise RuntimeError(f"Не найден {name}. Установи ffmpeg или укажи ffmpeg_dir в настройках.")
    return found


def run(cmd: list[str], cwd: str | None = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, creationflags=NO_WINDOW)
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace")[-1500:]
        raise RuntimeError(f"{Path(cmd[0]).stem} завершился с ошибкой:\n{err}")
    return p.stdout.decode("utf-8", "replace")


def run_ffmpeg(args: list[str], duration: float = 0, progress=None, cwd: str | None = None) -> None:
    """ffmpeg с отчётом о прогрессе (0..1)."""
    cmd = [ffbin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
           "-progress", "pipe:1", "-nostats"] + args
    p = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         creationflags=NO_WINDOW)
    err_chunks: list[bytes] = []
    t = threading.Thread(target=lambda: err_chunks.append(p.stderr.read()), daemon=True)
    t.start()
    for raw in p.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if progress and duration > 0 and line.startswith("out_time_us="):
            try:
                progress(min(1.0, int(line.split("=")[1]) / 1e6 / duration))
            except ValueError:
                pass
    p.wait()
    t.join(timeout=5)
    if p.returncode != 0:
        err = b"".join(err_chunks).decode("utf-8", "replace")[-1500:]
        raise RuntimeError(f"ffmpeg завершился с ошибкой:\n{err}")


def probe(path: str | Path) -> dict:
    out = run([ffbin("ffprobe"), "-v", "error", "-print_format", "json",
               "-show_format", "-show_streams", str(path)])
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not v:
        raise RuntimeError("В файле нет видеодорожки")
    num, den = (v.get("avg_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    has_audio = any(s["codec_type"] == "audio" for s in info["streams"])
    return {
        "width": int(v["width"]), "height": int(v["height"]),
        "fps": round(fps, 3) if fps > 0 else 30.0,
        "duration": float(info["format"].get("duration") or v.get("duration") or 0),
        "vcodec": v.get("codec_name"), "has_audio": has_audio,
    }


# ---------------------------------------------------------------- проекты

def pdir(pid: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_\-]+", pid):
        raise ValueError("bad project id")
    return DATA / pid


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:8]


def load_project(pid: str) -> dict:
    with _lock:
        f = pdir(pid) / "project.json"
        if not f.exists():
            raise FileNotFoundError(pid)
        p = json.loads(f.read_text("utf-8"))
        p["layout"] = _merge(DEFAULT_LAYOUT, p.get("layout") or {})
        p.setdefault("clips", [])
        return p


def save_project(p: dict) -> None:
    with _lock:
        d = pdir(p["id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(p, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(d / "project.json")


def update_project(pid: str, fn) -> dict:
    """Атомарно прочитать-изменить-записать проект."""
    with _lock:
        p = load_project(pid)
        fn(p)
        save_project(p)
        return p


def list_projects() -> list[dict]:
    out = []
    if DATA.exists():
        for d in DATA.iterdir():
            if (d / "project.json").exists():
                try:
                    p = load_project(d.name)
                    out.append({k: p.get(k) for k in
                                ("id", "title", "channel", "duration", "status", "created", "url")}
                               | {"clips": len(p["clips"])})
                except Exception:
                    pass
    out.sort(key=lambda x: x.get("created") or 0, reverse=True)
    return out


def source_path(p: dict) -> Path:
    if p.get("source_path"):
        return Path(p["source_path"])
    return pdir(p["id"]) / "source.mp4"


def load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            return default
    return default


def now() -> float:
    return time.time()


def fmt_time(t: float) -> str:
    t = max(0, int(t))
    h, m, s = t // 3600, t % 3600 // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"
