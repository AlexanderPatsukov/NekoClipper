"""Фоновые задачи: анализ стрима и рендер клипов."""
from __future__ import annotations

import queue
import shutil
import threading
import traceback
from pathlib import Path

from . import highlights, ingest, render
from .core import (load_config, load_project, new_id, now, pdir, probe, save_project, source_path,
                   update_project)

jobs: dict[str, dict] = {}
_queues = {"analyze": queue.Queue(), "render": queue.Queue()}
_started = False


def _job(kind: str, pid: str, **extra) -> dict:
    j = {"id": new_id("j"), "kind": kind, "pid": pid, "status": "queued", "stage": "В очереди",
         "progress": 0.0, "error": None, "created": now(), **extra}
    jobs[j["id"]] = j
    _queues["render" if kind == "render" else "analyze"].put(j)
    _start()
    return j


def _start() -> None:
    global _started
    if _started:
        return
    _started = True
    for name in _queues:
        threading.Thread(target=_worker, args=(name,), daemon=True).start()


def _worker(name: str) -> None:
    while True:
        j = _queues[name].get()
        j["status"] = "running"
        try:
            if j["kind"] == "render":
                _run_render(j)
            elif j["kind"] == "redownload":
                _run_redownload(j)
            else:
                _run_analyze(j)
            j["status"], j["progress"], j["stage"] = "done", 1.0, "Готово"
        except Exception as e:
            traceback.print_exc()
            j["status"], j["error"] = "error", str(e)
            try:
                if j["kind"] == "render" and j.get("plain"):
                    pass
                elif j["kind"] == "render":
                    _set_clip(j["pid"], j["cid"], status="error", error=str(e))
                elif j["kind"] == "redownload":
                    pass
                else:
                    update_project(j["pid"], lambda p: p.update(status="error", error=str(e)))
            except Exception:
                pass


def _stage(j: dict, text: str, base: float, span: float):
    j["stage"], j["progress"] = text, base

    def cb(frac: float):
        j["progress"] = base + span * max(0.0, min(1.0, frac))
    return cb


# ---------------------------------------------------------------- анализ

def create_project(url: str = "", path: str = "", auto_render: bool = False) -> dict:
    if path:
        src = Path(path.strip().strip('"'))
        if not src.exists():
            raise ValueError("Файл не найден: " + str(src))
        info = {"id": new_id("file_"), "title": src.stem, "channel": "", "duration": 0}
    else:
        info = ingest.fetch_info(url.strip())
        if info["live_status"] == "is_upcoming":
            raise ValueError("Стрим ещё не начался")
    pid = info["id"]
    try:
        p = load_project(pid)
    except FileNotFoundError:
        p = {"id": pid, "title": info["title"], "channel": info["channel"], "url": url.strip(),
             "source_path": str(src) if path else "", "duration": info["duration"],
             "status": "queued", "created": now(), "clips": [], "warnings": [],
             "layout": load_config().get("last_layout") or {}}
        save_project(p)
    _job("analyze", pid, auto_render=auto_render)
    return p


def redownload(pid: str, dl: dict) -> dict:
    return _job("redownload", pid, dl=dl)


def _run_redownload(j: dict) -> None:
    p = load_project(j["pid"])
    ingest.redownload(p["url"], p["id"], j["dl"], _stage(j, "Перекачиваю видео", 0.0, 0.97))
    shutil.rmtree(pdir(p["id"]) / "thumbs", ignore_errors=True)     # кадры шкалы — от старого видео
    info = probe(source_path(p))
    update_project(p["id"], lambda p: p.update({k: info[k] for k in ("width", "height", "fps") if k in info}))


def resume(pid: str) -> dict:
    return _job("analyze", pid, auto_render=False)


def reanalyze(pid: str) -> dict:
    """Заново найти моменты (скачанное видео и расшифровка переиспользуются)."""
    return _job("analyze", pid, auto_render=False, fresh=True)


def _run_analyze(j: dict) -> None:
    pid = j["pid"]
    p = update_project(pid, lambda p: p.update(status="processing", error=None, warnings=[]))

    if not p.get("source_path"):
        ingest.download(p["url"], pid, _stage(j, "Скачиваю стрим", 0.0, 0.3))
    src = source_path(p)
    info = probe(src)
    p = update_project(pid, lambda p: p.update(info))

    wav = ingest.extract_audio(src, pid, info["duration"], _stage(j, "Извлекаю звук", 0.3, 0.05)) \
        if info["has_audio"] else None
    segs = ingest.transcribe(wav, pid, info["duration"], _stage(j, "Распознаю речь", 0.35, 0.3)) if wav else []

    _stage(j, "Считаю громкость и активность чата", 0.65, 0.03)
    import numpy as np
    loud = ingest.loudness_curve(wav) if wav else np.full(int(info["duration"]) + 1, -60.0)
    chat = ingest.load_chat(pid)
    sig = highlights.build_signals(pid, info["duration"], loud, chat, segs)

    warnings: list[str] = []
    clips = highlights.find_highlights(p, segs, sig, _stage(j, "Ищу лучшие моменты (LLM)", 0.68, 0.32),
                                       warnings.append)

    def apply(p):
        manual = [c for c in p["clips"] if c.get("source") == "manual" or c.get("status") == "rendered"]
        p["clips"] = manual + [c for c in clips
                               if all(highlights._overlap(c, m) < 0.6 for m in manual)]
        p.update(status="ready", warnings=warnings, chat_messages=len(chat), words=sum(len(s["words"]) for s in segs))
    p = update_project(pid, apply)

    if j.get("auto_render"):
        for c in p["clips"]:
            if c["status"] != "rendered":
                queue_render(pid, c["id"])


# ---------------------------------------------------------------- рендер

def _set_clip(pid: str, cid: str, **fields) -> None:
    def apply(p):
        for c in p["clips"]:
            if c["id"] == cid:
                c.update(fields)
    update_project(pid, apply)


def queue_render(pid: str, cid: str, plain: bool = False) -> dict:
    for j in jobs.values():
        if (j["kind"] == "render" and j.get("cid") == cid and bool(j.get("plain")) == plain
                and j["status"] in ("queued", "running")):
            return j
    if not plain:
        _set_clip(pid, cid, status="queued", error=None)
    return _job("render", pid, cid=cid, plain=plain)


def _run_render(j: dict) -> None:
    p = load_project(j["pid"])
    clip = next((c for c in p["clips"] if c["id"] == j["cid"]), None)
    if not clip:
        raise RuntimeError("Клип удалён")
    if j.get("plain"):      # вырезка как есть — статус шортса не трогаем
        out = render.render_plain(p, clip, _stage(j, f"Вырезаю: {clip['title']}", 0.0, 1.0))
        _set_clip(p["id"], clip["id"], file_plain=out.name)
        return
    _set_clip(p["id"], clip["id"], status="rendering")
    out = render.render_clip(p, clip, _stage(j, f"Рендер: {clip['title']}", 0.0, 1.0))
    _set_clip(p["id"], clip["id"], status="rendered", file=out.name, rendered_at=now(), stale=False,
              encoded=render.USED.pop(clip["id"], ""))


def delete_project(pid: str) -> None:
    shutil.rmtree(pdir(pid), ignore_errors=True)
