"""Автопоиск вебки: ищем прямоугольник, границы которого держатся на месте весь отрезок.

Игра внутри кадра постоянно меняется, а рамка вебки — нет: на её сторонах перепад яркости
виден почти в каждом кадре и по всей длине стороны. Перебираем прямоугольники из таких
устойчивых линий и берём лучший.
"""
from __future__ import annotations

import json
import subprocess

import numpy as np

from .core import NO_WINDOW, ffbin, pdir, source_path

DW = 960            # ширина кадров для анализа
N_FRAMES = 24
EDGE_THR = 9        # минимальный перепад яркости на границе
MIN_SIDE = 0.5      # доля «кадры × длина стороны», где граница видна


def _frames(src, start: float, dur: float, W: int, H: int) -> np.ndarray:
    dh = int(round(DW * H / W / 2)) * 2
    dur = max(1.0, min(dur, 120.0))
    cmd = [ffbin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}",
           "-i", str(src), "-an", "-vf", f"fps={N_FRAMES / dur:.4f},scale={DW}:{dh}:flags=area,format=gray",
           "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW).stdout
    n = len(raw) // (DW * dh)
    if n < 4:
        return np.zeros((0, dh, DW), dtype=np.int16)
    return np.frombuffer(raw[: n * DW * dh], dtype=np.uint8).reshape(n, dh, DW).astype(np.int16)


def _lines(P: np.ndarray, min_len: int, top: int = 28) -> list[int]:
    """Номера столбцов P, где есть устойчивый отрезок границы длиной от min_len."""
    cs = np.concatenate([np.zeros((1, P.shape[1])), np.cumsum(P, axis=0)])
    best = ((cs[min_len:] - cs[:-min_len]) / min_len).max(axis=0)
    out = []
    for i in np.argsort(best)[::-1]:
        if best[i] < MIN_SIDE or len(out) >= top:
            break
        if all(abs(int(i) - o) > 3 for o in out):
            out.append(int(i))
    return out


def find_cam(frames: np.ndarray, hint: dict | None = None) -> tuple[dict | None, float]:
    if len(frames) < 4:
        return None, 0.0
    n, h, w = frames.shape
    # Pv[y, x] — доля кадров с вертикальной границей между столбцами x-1 и x; Ph — то же для строк
    Pv = np.zeros((h, w + 1))
    Pv[:, 1:w] = (np.abs(frames[:, :, 1:] - frames[:, :, :-1]) > EDGE_THR).mean(axis=0)
    Ph = np.zeros((h + 1, w))
    Ph[1:h, :] = (np.abs(frames[:, 1:, :] - frames[:, :-1, :]) > EDGE_THR).mean(axis=0)
    # граница после уменьшения кадра может размазаться на соседний пиксель
    Pv[:, 1:-1] = np.maximum(Pv[:, 1:-1], np.maximum(Pv[:, :-2], Pv[:, 2:]))
    Ph[1:-1, :] = np.maximum(Ph[1:-1, :], np.maximum(Ph[:-2, :], Ph[2:, :]))

    xs = sorted(set(_lines(Pv, int(h * 0.1)) + [0, w]))
    ys = sorted(set(_lines(Ph.T, int(w * 0.08)) + [0, h]))
    cv = np.concatenate([np.zeros((1, w + 1)), np.cumsum(Pv, axis=0)])      # сумма по y
    ch = np.concatenate([np.zeros((h + 1, 1)), np.cumsum(Ph, axis=1)], axis=1)  # сумма по x

    # «живость» картинки: вебка шумит и двигается от кадра к кадру, плашки интерфейса — нет
    live = frames.astype(np.float32).std(axis=0)
    li = np.zeros((h + 1, w + 1))
    li[1:, 1:] = live.cumsum(axis=0).cumsum(axis=1)
    hx = (hint["x"] * w, hint["y"] * h, (hint["x"] + hint["w"]) * w, (hint["y"] + hint["h"]) * h) if hint else None

    best, best_score = None, 0.0
    for i, x0 in enumerate(xs):
        for x1 in xs[i + 1:]:
            rw = x1 - x0
            if not 0.12 * w <= rw <= 0.55 * w:
                continue
            for j, y0 in enumerate(ys):
                for y1 in ys[j + 1:]:
                    rh = y1 - y0
                    if not 0.12 * h <= rh <= 0.6 * h or not 0.7 <= rw / rh <= 2.4:
                        continue
                    if rw == w or rh == h:
                        continue
                    vert = [(cv[y1, x] - cv[y0, x]) / rh for x in (x0, x1) if 0 < x < w]
                    hor = [(ch[y, x1] - ch[y, x0]) / rw for y in (y0, y1) if 0 < y < h]
                    if not vert or not hor:
                        continue
                    weakest = min(vert + hor)
                    if weakest < MIN_SIDE:
                        continue
                    liveness = (li[y1, x1] - li[y0, x1] - li[y1, x0] + li[y0, x0]) / (rw * rh)
                    if liveness < 1.2:
                        continue
                    score = (weakest + 0.04 * (len(vert) + len(hor)) + 0.25 * (rw * rh) / (w * h)
                             + min(0.2, liveness / 50))
                    if hx:      # вебка обычно стоит там же, где была в прошлых клипах
                        iw = min(x1, hx[2]) - max(x0, hx[0])
                        ih = min(y1, hx[3]) - max(y0, hx[1])
                        if iw > 0 and ih > 0:
                            iou = iw * ih / (rw * rh + (hx[2] - hx[0]) * (hx[3] - hx[1]) - iw * ih)
                            score += 0.35 * iou
                    if score > best_score:
                        best_score, best = score, (x0, y0, rw, rh)
    if not best:
        return None, 0.0
    x0, y0, rw, rh = best
    # внутри вебки должно быть изображение, а не плашка одного цвета
    if frames[:, y0:y0 + rh, x0:x0 + rw].std() < 6:
        return None, 0.0
    return ({"x": round(x0 / w, 4), "y": round(y0 / h, 4), "w": round(rw / w, 4), "h": round(rh / h, 4)},
            round(float(best_score), 3))


def detect_cam(project: dict, start: float, end: float, force: bool = False,
               hint: dict | None = None) -> dict | None:
    """Вебка на отрезке [start, end] или None. Результат кэшируется в cam_cache.json."""
    cache_file = pdir(project["id"]) / "cam_cache.json"
    try:
        cache = json.loads(cache_file.read_text("utf-8"))
    except Exception:
        cache = {}
    key = f"{start:.1f}-{end:.1f}"
    if key in cache and not force:
        return cache[key]
    frames = _frames(source_path(project), start, end - start, int(project["width"]), int(project["height"]))
    cam, _ = find_cam(frames, hint)
    cache[key] = cam
    if len(cache) > 400:
        cache = dict(list(cache.items())[-300:])
    cache_file.write_text(json.dumps(cache), "utf-8")
    return cam
