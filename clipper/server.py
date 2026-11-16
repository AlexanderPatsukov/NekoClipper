"""Веб-интерфейс и API (FastAPI)."""
from __future__ import annotations

import os
import subprocess
import sys

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import camdetect, llm, pipeline, render
from .core import (ASSETS, DEFAULT_LAYOUT, NO_WINDOW, ROOT, _merge, ffbin, list_projects, load_config, load_json,
                   load_project, new_id, pdir, save_config, source_path, update_project)

app = FastAPI(title="NekoClipper")
WEB = ROOT / "web"


def _project(pid: str) -> dict:
    try:
        return load_project(pid)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, "Проект не найден")


def _jobs(pid: str | None = None) -> list[dict]:
    return [j for j in pipeline.jobs.values()
            if (pid is None or j["pid"] == pid) and j["status"] in ("queued", "running")]


@app.exception_handler(Exception)
async def on_error(_, exc: Exception):
    return JSONResponse({"detail": str(exc)}, status_code=500)


@app.get("/")
def index():
    # версия в адресе = время изменения файла: после обновления браузер точно берёт свежие стили и скрипт
    html = (WEB / "index.html").read_text("utf-8")
    for name in ("app.js", "style.css", "i18n.js"):
        html = html.replace(f"/static/{name}\"", f"/static/{name}?v={int((WEB / name).stat().st_mtime)}\"")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- настройки

@app.get("/api/config")
def get_config():
    return load_config()


@app.put("/api/config")
def put_config(cfg: dict = Body(...)):
    return save_config(cfg)


@app.post("/api/llm/test")
def llm_test(cfg: dict = Body(default=None)):
    c = _merge(load_config()["llm"], cfg or {})
    try:
        models = llm.list_models(c)
        answer = llm.chat("Отвечай одним словом.", "Скажи «работает».", c, max_tokens=1500)
        return {"ok": True, "models": models, "model": llm.resolve_model(c), "answer": answer[-200:]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------- проекты

@app.get("/api/projects")
def projects():
    return {"projects": list_projects(), "jobs": _jobs()}


@app.post("/api/projects")
def add_project(body: dict = Body(...)):
    src = (body.get("source") or "").strip()
    if not src:
        raise HTTPException(400, "Укажи ссылку на стрим или путь к файлу")
    is_url = src.lower().startswith(("http://", "https://"))
    try:
        p = pipeline.create_project(url=src if is_url else "", path="" if is_url else src,
                                    auto_render=bool(body.get("auto_render")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return p


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = _project(pid)
    p["jobs"] = _jobs(pid)
    return p


@app.delete("/api/projects/{pid}")
def del_project(pid: str):
    _project(pid)
    if _jobs(pid):
        raise HTTPException(409, "Проект сейчас обрабатывается")
    pipeline.delete_project(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/redownload")
def redownload(pid: str, body: dict = Body(...)):
    p = _project(pid)
    if not p.get("url"):
        raise HTTPException(400, "Это локальный файл — перекачивать нечего")
    if _jobs(pid):
        raise HTTPException(409, "Проект сейчас обрабатывается — дождись окончания")
    dl = {"max_height": int(body.get("max_height") or 0), "fps": int(body.get("fps") or 60),
          "codec": body.get("codec") or "auto"}
    return pipeline.redownload(pid, dl)


@app.post("/api/projects/{pid}/resume")
def resume(pid: str):
    """Продолжить прерванное скачивание/анализ: недокачанные куски (.part) подхватываются."""
    _project(pid)
    if _jobs(pid):
        return {"ok": True}
    return pipeline.resume(pid)


@app.post("/api/projects/{pid}/reanalyze")
def reanalyze(pid: str):
    _project(pid)
    if any(j["kind"] == "analyze" for j in _jobs(pid)):
        raise HTTPException(409, "Анализ уже идёт")
    return pipeline.reanalyze(pid)


@app.get("/api/projects/{pid}/video")
def video(pid: str):
    src = source_path(_project(pid))
    if not src.exists():
        raise HTTPException(404, "Видео ещё не скачано")
    return FileResponse(src, media_type="video/mp4")


@app.get("/api/projects/{pid}/thumb")
def thumb(pid: str, t: float = 0):
    """Кадр стрима в момент t (маленькая картинка для шкалы редактора), кэшируется на диске."""
    import uuid
    src = source_path(_project(pid))
    if not src.exists():
        raise HTTPException(404, "Видео ещё не скачано")
    ms = int(round(max(0.0, t) * 1000))
    d = pdir(pid) / "thumbs"
    d.mkdir(exist_ok=True)
    f = d / f"{ms}.jpg"
    if not f.exists():
        tmp = d / f"{ms}.{uuid.uuid4().hex[:6]}.tmp.jpg"
        subprocess.run([ffbin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{ms / 1000:.3f}", "-i", str(src),
                        "-frames:v", "1", "-vf", "scale=-2:96", "-q:v", "6", str(tmp)], capture_output=True, creationflags=NO_WINDOW)
        if not tmp.exists():
            raise HTTPException(404, "Кадр не найден")
        os.replace(tmp, f)
    return FileResponse(f, media_type="image/jpeg", headers={"Cache-Control": "max-age=604800"})


@app.get("/api/projects/{pid}/signals")
def signals(pid: str):
    return load_json(pdir(pid) / "signals.json", {"audio": [], "chat": [], "score": [], "has_chat": False})


@app.get("/api/projects/{pid}/words")
def words(pid: str, start: float = 0, end: float = 1e9):
    _project(pid)
    return render.clip_words(pid, start, end)


@app.put("/api/projects/{pid}/layout")
def put_layout(pid: str, layout: dict = Body(...)):
    return update_project(pid, lambda p: p.update(layout=_merge(DEFAULT_LAYOUT, layout)))["layout"]


@app.post("/api/projects/{pid}/open")
def open_folder(pid: str):
    d = pdir(pid) / "clips"
    d.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        os.startfile(str(d))
    else:
        subprocess.Popen(["xdg-open", str(d)])
    return {"ok": True}


# ---------------------------------------------------------------- клипы

EDITABLE = ("start", "end", "title", "layout", "sub_edits", "audio", "chat_hidden")


IMG_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}


@app.post("/api/assets")
async def upload_asset(request: Request, name: str = "image.png"):
    """Загрузка картинки/логотипа (тело запроса — сам файл). Одинаковые файлы не дублируются."""
    import hashlib
    ext = os.path.splitext(name)[1].lower()
    if ext not in IMG_TYPES:
        raise HTTPException(400, "Нужна картинка: PNG, JPG, WEBP или GIF")
    data = await request.body()
    if not data or len(data) > 30 * 1024 * 1024:
        raise HTTPException(400, "Файл пустой или больше 30 МБ")
    ASSETS.mkdir(parents=True, exist_ok=True)
    fname = hashlib.sha1(data).hexdigest()[:16] + ext
    (ASSETS / fname).write_bytes(data)
    return {"asset": fname, "name": name}


@app.get("/api/assets/{fname}")
def get_asset(fname: str):
    f = ASSETS / os.path.basename(fname)
    if not f.exists() or f.suffix.lower() not in IMG_TYPES:
        raise HTTPException(404, "Картинка не найдена")
    return FileResponse(f, media_type=IMG_TYPES[f.suffix.lower()])


@app.post("/api/projects/{pid}/apply_layout")
def apply_layout(pid: str, body: dict = Body(...)):
    """Пресет: основной для новых клипов (project + config) и/или сразу на все клипы проекта."""
    lay = body.get("layout") or {}
    to_all = bool(body.get("all"))

    def apply(p):
        p["layout"] = _merge(DEFAULT_LAYOUT, lay)
        if to_all:
            for c in p["clips"]:
                c["layout"] = dict(lay)
                if c.get("status") == "rendered":
                    c["stale"] = True
    update_project(pid, apply)
    save_config(load_config() | {"last_layout": lay})
    return {"ok": True}


@app.get("/api/projects/{pid}/chat")
def chat(pid: str, start: float = 0, end: float = 1e9):
    _project(pid)
    return render.clip_chat(pid, start, end)


@app.post("/api/projects/{pid}/fetch_chat")
def fetch_chat(pid: str):
    """Докачать чат стрима для уже скачанного проекта."""
    p = _project(pid)
    if not p.get("url"):
        raise HTTPException(400, "Это локальный файл — чата у него нет")
    from . import ingest
    n = ingest.fetch_chat(p["url"], pid)
    return {"count": n}


@app.middleware("http")
async def no_stale_static(request, call_next):
    """Интерфейс всегда свежий: после обновления программы не нужен Ctrl+F5."""
    resp = await call_next(request)
    if request.url.path.startswith("/static/"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/projects/{pid}/wave")
def wave_peaks(pid: str, start: float = 0, end: float = 60, n: int = 800):
    """Пики громкости на отрезке — форма волны для звуковой дорожки редактора."""
    import wave

    import numpy as np
    f = pdir(pid) / "audio.wav"
    if not f.exists():
        return {"start": start, "end": end, "peaks": []}
    with wave.open(str(f), "rb") as w:
        sr, total = w.getframerate(), w.getnframes()
        a, b = max(0, int(start * sr)), min(total, int(end * sr))
        if b <= a:
            return {"start": start, "end": end, "peaks": []}
        w.setpos(a)
        data = np.abs(np.frombuffer(w.readframes(b - a), dtype=np.int16).astype(np.int32))
    n = max(50, min(int(n), 4000, len(data)))
    step = len(data) // n
    peaks = data[:step * n].reshape(n, step).max(axis=1) / 32768
    return {"start": a / sr, "end": (a + step * n) / sr, "peaks": [round(float(v), 3) for v in peaks]}
_fonts: list[str] = []


@app.get("/api/fonts")
def fonts():
    """Установленные в системе шрифты (ими же рисует субтитры ffmpeg)."""
    global _fonts
    if not _fonts:
        names = {"Arial Black", "Impact", "Arial", "Verdana", "Tahoma"}
        if sys.platform == "win32":
            import winreg
            for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
                try:
                    with winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts") as k:
                        for i in range(winreg.QueryInfoKey(k)[1]):
                            name = winreg.EnumValue(k, i)[0].split(" (")[0]
                            for part in name.split(" & "):
                                part = part.strip()
                                if part and not part.startswith("@"):
                                    names.add(part)
                except OSError:
                    pass
        _fonts = sorted(names, key=str.lower)
    return _fonts


@app.post("/api/projects/{pid}/clips")
def add_clip(pid: str, body: dict = Body(...)):
    p = _project(pid)
    s, e = float(body["start"]), float(body["end"])
    if e - s < 1 or s < 0 or e > p["duration"] + 1:
        raise HTTPException(400, "Неверный диапазон клипа")
    clip = {"id": new_id("c"), "start": round(s, 2), "end": round(e, 2),
            "title": (body.get("title") or "Мой клип").strip(), "reason": "", "score": None,
            "source": "manual", "text": " ".join(w["w"] for w in render.clip_words(pid, s, e))[:400],
            "layout": body.get("layout"), "status": "draft", "file": None}
    update_project(pid, lambda p: p["clips"].append(clip))
    return clip


@app.put("/api/projects/{pid}/clips/{cid}")
def edit_clip(pid: str, cid: str, body: dict = Body(...)):
    found = {}

    def apply(p):
        for c in p["clips"]:
            if c["id"] == cid:
                before = {k: c.get(k) for k in EDITABLE}
                for k in EDITABLE:
                    if k in body:
                        c[k] = body[k]
                c["start"], c["end"] = round(float(c["start"]), 2), round(float(c["end"]), 2)
                if c["end"] - c["start"] < 1:
                    raise HTTPException(400, "Клип короче секунды")
                if c.get("status") == "rendered" and before != {k: c.get(k) for k in EDITABLE}:
                    c["stale"] = True       # готовый файл больше не соответствует настройкам
                if body.get("remember") and c.get("layout"):
                    p["layout"] = _merge(DEFAULT_LAYOUT, c["layout"])
                found.update(c)
    update_project(pid, apply)
    if not found:
        raise HTTPException(404, "Клип не найден")
    if body.get("remember") and found.get("layout"):
        # запоминаем раскладку и для новых стримов
        save_config(load_config() | {"last_layout": found["layout"]})
    return found


@app.post("/api/projects/{pid}/detect_cam")
def detect_cam(pid: str, body: dict = Body(...)):
    p = _project(pid)
    if not p.get("width"):
        raise HTTPException(409, "Видео ещё не скачано")
    cam = camdetect.detect_cam(p, float(body["start"]), float(body["end"]), force=bool(body.get("force")),
                               hint=(p.get("layout") or {}).get("cam"))
    return {"cam": cam}


@app.delete("/api/projects/{pid}/clips/{cid}")
def del_clip(pid: str, cid: str):
    def apply(p):
        for c in p["clips"]:
            if c["id"] == cid:
                for name in (c.get("file"), c.get("file_plain")):
                    try:
                        if name:
                            (pdir(pid) / "clips" / name).unlink(missing_ok=True)
                    except OSError:
                        pass
        p["clips"] = [c for c in p["clips"] if c["id"] != cid]
    update_project(pid, apply)
    return {"ok": True}


@app.post("/api/projects/{pid}/clips/{cid}/render")
def render_clip(pid: str, cid: str, plain: int = 0):
    p = _project(pid)
    if not any(c["id"] == cid for c in p["clips"]):
        raise HTTPException(404, "Клип не найден")
    return pipeline.queue_render(pid, cid, plain=bool(plain))


@app.post("/api/projects/{pid}/render_all")
def render_all(pid: str, body: dict = Body(default={})):
    p = _project(pid)
    todo = [c for c in p["clips"] if body.get("force") or c["status"] not in ("rendered", "queued", "rendering")]
    for c in todo:
        pipeline.queue_render(pid, c["id"])
    return {"queued": len(todo)}


@app.get("/api/projects/{pid}/clips/{cid}/file")
def clip_file(pid: str, cid: str, download: int = 0, plain: int = 0):
    p = _project(pid)
    c = next((c for c in p["clips"] if c["id"] == cid), None)
    name = (c or {}).get("file_plain" if plain else "file")
    if not name:
        raise HTTPException(404, "Клип ещё не отрендерен")
    c = {**c, "file": name}
    f = pdir(pid) / "clips" / c["file"]
    if not f.exists():
        raise HTTPException(404, "Файл клипа не найден")
    mt = {".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm"}.get(f.suffix.lower(), "video/mp4")
    return FileResponse(f, media_type=mt, filename=c["file"] if download else None,
                        headers={"Cache-Control": "no-store"})


app.mount("/static", StaticFiles(directory=WEB), name="static")
