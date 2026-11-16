"""Запуск: python -m clipper            — веб-интерфейс
           python -m clipper <ссылка|файл> [--render]  — нарезка из консоли."""
from __future__ import annotations

import argparse
import sys
import threading
import time
import webbrowser


def main() -> None:
    ap = argparse.ArgumentParser(prog="clipper", description="Нарезка стримов на шортсы")
    ap.add_argument("source", nargs="?", help="ссылка на стрим (YouTube/Twitch) или путь к видео")
    ap.add_argument("--render", action="store_true", help="сразу отрендерить все найденные клипы")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    from .core import ensure_ffmpeg
    try:
        ensure_ffmpeg()         # на новом компьютере скачает ffmpeg сам
    except RuntimeError as e:
        print("ОШИБКА:", e)
        sys.exit(1)

    if not a.source:
        import uvicorn
        url = f"http://127.0.0.1:{a.port}"
        print(f"NekoClipper: {url}")
        if not a.no_browser:
            threading.Timer(1.2, lambda: webbrowser.open(url)).start()
        uvicorn.run("clipper.server:app", host="127.0.0.1", port=a.port, log_level="warning")
        return

    from . import pipeline
    from .core import load_project, pdir
    is_url = a.source.lower().startswith(("http://", "https://"))
    p = pipeline.create_project(url=a.source if is_url else "", path="" if is_url else a.source,
                                auto_render=a.render)
    last = ""
    while True:
        active = [j for j in pipeline.jobs.values() if j["status"] in ("queued", "running")]
        failed = [j for j in pipeline.jobs.values() if j["status"] == "error"]
        for j in active[:1]:
            line = f"{j['stage']} — {j['progress'] * 100:.0f}%"
            if line != last:
                print(line, flush=True)
                last = line
        if not active:
            break
        time.sleep(1)
    p = load_project(p["id"])
    for w in p.get("warnings") or []:
        print("!", w)
    for j in failed:
        print("ОШИБКА:", j["error"])
    print(f"\n{p['title']} — найдено клипов: {len(p['clips'])}")
    for c in p["clips"]:
        print(f"  [{c['score']}] {c['start']:8.1f}–{c['end']:8.1f}  {c['title']}  ({c['status']})")
    print("Папка с клипами:", pdir(p["id"]) / "clips")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
