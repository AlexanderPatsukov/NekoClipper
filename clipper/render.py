"""Рендер вертикального шортса 1080x1920: раскладка кадра, субтитры по словам, заголовок."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from . import camdetect
from .core import (ASSETS, DEFAULT_LAYOUT, NO_WINDOW, _merge, ffbin, load_config, pdir, run_ffmpeg,
                   source_path)

OUT_W, OUT_H = 1080, 1920
_encoder_cache: dict[str, str] = {}


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def _clamp(v, lo, hi) -> float:
    return min(max(float(v), lo), hi)


def _region(r: dict, W: int, H: int) -> tuple[float, float, float, float]:
    x = _clamp(r.get("x", 0), 0, 0.98)
    y = _clamp(r.get("y", 0), 0, 0.98)
    w = _clamp(r.get("w", 1), 0.02, 1 - x)
    h = _clamp(r.get("h", 1), 0.02, 1 - y)
    return x * W, y * H, w * W, h * H


def _cover(reg, aspect: float, fx: float = 0.5, fy: float = 0.5) -> tuple[int, int, int, int]:
    """Кроп (x, y, w, h) внутри области reg под нужное соотношение сторон."""
    x, y, w, h = reg
    if w / h > aspect:
        cw, ch = h * aspect, h
    else:
        cw, ch = w, w / aspect
    cw, ch = _even(cw), _even(ch)
    return max(0, int(x + (w - cw) * fx)), max(0, int(y + (h - ch) * fy)), cw, ch


def resolve_layout(project: dict, clip: dict) -> dict:
    """Итоговая раскладка клипа: общая + своя, плюс автопоиск вебки на отрезке клипа."""
    L = _merge(_merge(DEFAULT_LAYOUT, project.get("layout") or {}), clip.get("layout") or {})
    if L["mode"] in ("split", "pip") and L.get("cam_source", "auto") == "auto":
        try:
            L["cam"] = camdetect.detect_cam(project, float(clip["start"]), float(clip["end"]),
                                            hint=(project.get("layout") or {}).get("cam"))
        except Exception:
            L["cam"] = None
    return L


def out_size(L: dict) -> tuple[int, int]:
    """Размер итогового кадра (по умолчанию 1080x1920)."""
    return (_even(_clamp(L.get("out_w") or OUT_W, 240, 3840)), _even(_clamp(L.get("out_h") or OUT_H, 240, 3840)))


def _inset(reg, crop: dict | None):
    """Обрезка области с краёв: crop = доли {l, t, r, b} от её размеров."""
    if not crop:
        return reg
    x, y, w, h = reg
    l, t, r, b = (_clamp(crop.get(k) or 0, 0, 0.9) for k in "ltrb")
    r, b = min(r, 0.92 - l), min(b, 0.92 - t)
    return x + w * l, y + h * t, w * (1 - l - r), h * (1 - t - b)


def plan(L: dict, W: int, H: int) -> dict:
    """Что и куда рисуем. Та же логика продублирована в web/app.js для живого превью."""
    OW, OH = out_size(L)
    A, sy = OW / OH, OH / 1920
    mode = L.get("mode", "split")
    fx, fy = _clamp(L.get("focus_x", 0.5), 0, 1), _clamp(L.get("focus_y", 0.5), 0, 1)
    game = _inset(_region(L.get("game") or {}, W, H), L.get("game_crop"))
    cam = None
    if mode in ("split", "pip") and L.get("cam_source", "auto") != "off" and L.get("cam"):
        cam = _region(L["cam"], W, H)
        z = _clamp(L.get("cam_zoom", 1.0), 1.0, 3.0)
        cam = (cam[0] + cam[2] * (1 - 1 / z) / 2, cam[1] + cam[3] * (1 - 1 / z) / 2, cam[2] / z, cam[3] / z)
        cam = _inset(cam, L.get("cam_crop"))
    cam_dy, game_dy = int(L.get("cam_dy") or 0), int(L.get("game_dy") or 0)
    items, bg, title_y = [], None, 90 * sy

    if mode in ("fill", "pip"):
        items.append({"src": _cover(game, A, fx, fy), "dst": (0, 0, OW, OH)})
        if cam:
            w = _even(OW * _clamp(L.get("pip_size", 0.45), 0.2, 0.9))
            h = min(_even(w * cam[3] / cam[2]), _even(OH * 0.6))
            x = int((OW - w) * _clamp(L.get("pip_x", 0.5), 0, 1))
            y = int((OH - h) * _clamp(L.get("pip_y", 0.05), 0, 1))
            items.append({"src": _cover(cam, w / h), "dst": (x, y, w, h), "border": 6, "cam": True})
            if y < 320 * sy:
                title_y = y + h + 40 * sy
    elif mode == "split":
        cam_h = 0
        if cam:
            r = float(L.get("cam_ratio") or 0)
            cam_h = _even(OH * _clamp(r, 0.12, 0.6)) if r > 0.01 \
                else _even(min(OW * cam[3] / cam[2], OH * 0.45))
        avail = OH - cam_h
        h0 = min(avail, OW * game[3] / game[2])
        game_h = min(avail, _even(h0 + (avail - h0) * _clamp(L.get("game_zoom", 0), 0, 1)))
        left = OH - cam_h - game_h
        y0 = _even(left * 0.62) if (L.get("title_overlay") and left >= 250 * sy) else (left // 4) * 2
        if left < 2:
            y0 = 0
        cam_y, game_y = (y0 + game_h, y0) if L.get("cam_pos") == "bottom" else (y0, y0 + cam_h)
        cam_y = int(_clamp(cam_y + cam_dy, 0, OH - cam_h)) if cam else cam_y
        game_y = int(_clamp(game_y + game_dy, 0, OH - game_h))
        items.append({"src": _cover(game, OW / game_h, fx, fy), "dst": (0, game_y, OW, game_h)})
        if cam:
            items.append({"src": _cover(cam, OW / cam_h), "dst": (0, cam_y, OW, cam_h), "cam": True})
        if left >= 2:
            bg = _cover(game, A, fx, fy)
        top_y = min(cam_y, game_y) if cam else game_y
        title_y = max(40 * sy, top_y - 215 * sy) if top_y >= 215 * sy else 90 * sy
    else:   # fit_blur
        zoom = _clamp(L.get("zoom", 1.0), 1.0, 3.0)
        aspect = max(A, (game[2] / zoom) / game[3])
        fg_h = min(OH, _even(OW / aspect))
        top = int(_clamp(((OH - fg_h) // 4) * 2 + game_dy, 0, OH - fg_h))
        items.append({"src": _cover(game, OW / fg_h, fx, fy), "dst": (0, top, OW, fg_h)})
        if fg_h < OH:
            bg = _cover(game, A, fx, fy)
        title_y = max(60 * sy, top - 250 * sy)

    # свободные окна: пользователь сам задал место и размер блока в кадре
    for it in items:
        box = L.get("cam_box" if it.get("cam") else "game_box")
        if not box:
            continue
        w = min(OW, _even(_clamp(box.get("w", 1), 0.05, 1) * OW))
        h = min(OH, _even(_clamp(box.get("h", 1), 0.03, 1) * OH))
        x = int(_clamp(box.get("x", 0) * OW, 0, OW - w))
        y = int(_clamp(box.get("y", 0) * OH, 0, OH - h))
        it["dst"] = (x, y, w, h)
        it["src"] = _cover(cam if it.get("cam") else game, w / h, 0.5, 0.5)
        bg = bg or _cover(game, A, fx, fy)
    # куски кадра: любая часть исходника в своём окне поверх всего
    for i, ex in enumerate(L.get("extras") or []):
        box = ex.get("box") or {}
        w = min(OW, _even(_clamp(box.get("w", 0.5), 0.03, 1) * OW))
        h = min(OH, _even(_clamp(box.get("h", 0.2), 0.02, 1) * OH))
        x = int(_clamp(box.get("x", 0) * OW, 0, OW - w))
        y = int(_clamp(box.get("y", 0) * OH, 0, OH - h))
        items.append({"src": _cover(_region(ex.get("src") or {}, W, H), w / h), "dst": (x, y, w, h), "extra": i})
    # слои: куски кадра и картинки, каждый в своё время (текстовые слои рисуются субтитрами)
    for lay in L.get("layers") or []:
        kind = lay.get("kind")
        if lay.get("hidden") or kind not in ("crop", "image") or (kind == "image" and not lay.get("asset")):
            continue
        box = lay.get("box") or {}
        w = min(OW, _even(_clamp(box.get("w", 0.3), 0.02, 1) * OW))
        h = min(OH, _even(_clamp(box.get("h", 0.1), 0.01, 1) * OH))
        x = int(_clamp(box.get("x", 0) * OW, -w + 2, OW - 2))
        y = int(_clamp(box.get("y", 0) * OH, -h + 2, OH - 2))
        it = {"dst": (x, y, w, h), "layer": lay.get("id"), "t": layer_time(lay),
              "opacity": _clamp(lay.get("opacity", 1), 0, 1), "fade": _clamp(lay.get("fade", 0), 0, 5)}
        if kind == "crop":
            it["src"] = _cover(_region(lay.get("src") or {}, W, H), w / h)
        else:
            it["img"] = lay["asset"]
        items.append(it)
    if L.get("title_pos") is not None:
        title_y = OH * _clamp(L["title_pos"], 0, 0.95)
    return {"bg": bg, "items": items, "title_y": int(title_y), "out": (OW, OH),
            "bg_dim": _clamp(L.get("bg_dim", 0.12), 0, 0.8)}


def layer_time(lay: dict) -> tuple[float, float | None]:
    """Когда показывать слой: секунды от начала клипа; конец None — до конца клипа."""
    s0 = max(0.0, float(lay.get("s") or 0))
    e = lay.get("e")
    return s0, (None if e is None else max(s0 + 0.05, float(e)))


def video_filter(pl: dict, dur: float = 1e6) -> str:
    """filter_complex по плану; видео на выходе помечено [v].
    Картинки слоёв — отдельные входы ffmpeg ([1:v], [2:v]… в порядке слоёв)."""
    items, bg = pl["items"], pl["bg"]
    OW, OH = pl["out"]
    n = len([it for it in items if not it.get("img")]) + (1 if bg else 0)
    labels = [f"[s{i}]" for i in range(n)]
    parts = [f"[0:v]split={n}{''.join(labels)}" if n > 1 else "[0:v]null[s0]"]
    crop = lambda s: f"crop={s[2]}:{s[3]}:{s[0]}:{s[1]}"
    rest = list(items)
    if bg:
        parts.append(f"{labels.pop()}{crop(bg)},scale={_even(OW / 4)}:{_even(OH / 4)},boxblur=8:2,"
                     f"scale={OW}:{OH}:flags=bilinear,eq=brightness=-{pl['bg_dim']:.2f}:saturation=1.15,setsar=1[base]")
    else:
        it = rest.pop(0)
        x, y, w, h = it["dst"]
        parts.append(f"{labels.pop(0)}{crop(it['src'])},scale={w}:{h}:flags=lanczos,setsar=1,"
                     f"pad={OW}:{OH}:{x}:{y}:black[base]")
    prev, li, img = "[base]", 0, 0
    for i, it in enumerate(rest):
        x, y, w, h = it["dst"]
        b = int(it.get("border") or 0)
        pad = f",pad={w + 2 * b}:{h + 2 * b}:{b}:{b}:white" if b else ""
        if it.get("img"):
            img += 1
            chain = f"[{img}:v]scale={w}:{h}:flags=lanczos,setsar=1,format=rgba"
        else:
            chain = f"{labels[li]}{crop(it['src'])},scale={w}:{h}:flags=lanczos,setsar=1{pad}"
            li += 1
        s0, e = it.get("t") or (0.0, None)
        e_eff = min(e, dur) if e is not None else dur
        op, fade = float(it.get("opacity", 1)), float(it.get("fade") or 0)
        if (op < 0.999 or fade > 0.01) and not it.get("img"):
            chain += ",format=rgba"
        if op < 0.999:
            chain += f",colorchannelmixer=aa={op:.3f}"
        if fade > 0.01:
            fd = min(fade, max(0.05, (e_eff - s0) / 2))
            chain += f",fade=t=in:st={s0:.3f}:d={fd:.3f}:alpha=1"
            if e_eff < 1e5:
                chain += f",fade=t=out:st={max(s0, e_eff - fd):.3f}:d={fd:.3f}:alpha=1"
        parts.append(f"{chain}[i{i}]")
        timed = s0 > 0.001 or e is not None
        en = f":enable='between(t,{s0:.3f},{e_eff:.3f})'" if timed else ""
        out = "[v]" if i == len(rest) - 1 else f"[o{i}]"
        parts.append(f"{prev}[i{i}]overlay={x - b}:{y - b}{en}{out}")
        prev = out
    if prev != "[v]":
        parts.append("[base]null[v]")
    return ";".join(parts)


# ---------------------------------------------------------------- субтитры

def group_words(words: list[dict], max_words: int = 3, max_chars: int = 18) -> list[list[dict]]:
    groups, cur = [], []
    for w in words:
        chars = sum(len(x["w"]) for x in cur) + len(cur)
        if cur and (len(cur) >= max_words or chars + len(w["w"]) > max_chars
                    or w["s"] - cur[-1]["e"] > 0.6 or cur[-1]["w"][-1:] in ".?!…"):
            groups.append(cur)
            cur = []
        cur.append(w)
    if cur:
        groups.append(cur)
    return groups


def _ass_time(t: float) -> str:
    cs = int(round(max(0.0, t) * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_color(hex_color: str) -> str:
    h = hex_color.lstrip("#")
    if len(h) != 6:
        h = "FFE500"
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def _clean(word: str) -> str:
    return re.sub(r"[{}\\]", "", word)


_NO_GLYPH = re.compile("[\U00010000-\U0010FFFF️‍]")
CHAT_COLORS = ["#FF6B6B", "#FFB347", "#FFE066", "#7CFC9A", "#5EEAD4", "#7DD3FC", "#A78BFA", "#F472B6", "#FDA4AF", "#C4F25D"]


def chat_color(user: str) -> str:
    return CHAT_COLORS[sum(ord(c) * (i + 1) for i, c in enumerate(user)) % len(CHAT_COLORS)]


def chat_key(m: dict) -> str:
    return f"{float(m['t']):.2f}|{m.get('user', '')}"


def _wrap(text: str, width: int) -> list[str]:
    """Перенос по словам на строки не длиннее width символов (так же считает превью)."""
    lines, cur = [], ""
    for word in text.split():
        while len(word) > width:
            if cur:
                lines.append(cur)
                cur = ""
            lines.append(word[:width])
            word = word[width:]
        if cur and len(cur) + 1 + len(word) > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    if cur:
        lines.append(cur)
    return lines


def chat_geometry(layout: dict, out: tuple[int, int]) -> dict:
    """Окно чата в пикселях шортса и метрика текста. Повторено в web/app.js."""
    OW, OH = out
    k = min(OW, OH) / 1080
    b = layout.get("chat_box") or {}
    w = _clamp(b.get("w", 0.66), 0.15, 1) * OW
    h = _clamp(b.get("h", 0.17), 0.05, 1) * OH
    x = _clamp(b.get("x", 0.04) * OW, 0, OW - w)
    y = _clamp(b.get("y", 0.56) * OH, 0, OH - h)
    size = max(10, int(_clamp(layout.get("chat_size", 34), 16, 90) * k))
    pad = int(size * 0.45)
    width = max(8, int((w - 2 * pad) / (size * 0.6)))
    lh = size * 1.25
    return {"x": int(x), "y": int(y), "w": int(w), "h": int(h), "size": size, "pad": pad,
            "chars": width, "lines": max(1, int((h - 2 * pad) / lh))}


def chat_blocks(msgs: list[dict], width: int) -> list[list[str]]:
    """Сообщение → строки: первая начинается с ника, не больше трёх строк."""
    out = []
    for m in msgs:
        user = _NO_GLYPH.sub("", m.get("user") or "").strip() or "?"
        text = re.sub(r"\s+", " ", _NO_GLYPH.sub("", m.get("text") or "")).strip()
        lines = _wrap(f"{user}: {text}", width)[:3] or [user + ":"]
        if len(_wrap(f"{user}: {text}", width)) > 3:
            lines[-1] = lines[-1][:max(1, width - 1)] + "…"
        out.append(lines)
    return out


def chat_frames(msgs: list[dict], start: float, end: float, layout: dict, out: tuple[int, int]):
    """Состояния окна чата: [(t0, t1, [сообщения сверху вниз])] во времени клипа."""
    geo = chat_geometry(layout, out)
    shift = float(layout.get("chat_shift") or 0)
    dur = end - start
    rel = sorted(((float(m["t"]) - shift - start, m) for m in msgs), key=lambda x: x[0])
    rel = [x for x in rel if -90 <= x[0] < dur]
    times = sorted({0.0} | {round(t, 2) for t, _ in rel if 0 < t < dur})
    frames = []
    for i, t0 in enumerate(times):
        t1 = times[i + 1] if i + 1 < len(times) else dur
        seen = [m for t, m in rel if t <= t0 + 1e-6]
        show, used = [], 0
        for m, lines in zip(reversed(seen), reversed(chat_blocks(seen, geo["chars"]))):
            if used + len(lines) > geo["lines"]:
                break
            show.insert(0, (m, lines))
            used += len(lines)
        frames.append((t0, t1, show))
    return geo, frames


def build_ass(words: list[dict], start: float, end: float, layout: dict, title: str,
              title_y: int, out: tuple[int, int] = (OUT_W, OUT_H), chat: list[dict] | None = None) -> str:
    OW, OH = out
    k = min(OW, OH) / 1080          # текст масштабируется вместе с кадром
    font, size = str(layout.get("font") or "Arial Black"), max(8, int((layout.get("sub_size") or 78) * k))
    hi, base = _ass_color(layout.get("sub_hi") or "#FFE500"), _ass_color(layout.get("sub_color") or "#FFFFFF")
    outline = int(round(_clamp(layout.get("sub_outline", 7), 0, 20) * k))
    t_size = max(8, int((layout.get("title_size") or 56) * k))
    t_fg, t_bg = _ass_color(layout.get("title_fg") or "#101010"), _ass_color(layout.get("title_bg") or "#FFFFFF")
    upper = bool(layout.get("uppercase", True))
    y = int(OH * _clamp(layout.get("sub_pos", 0.75), 0.03, 0.97))
    m = int(70 * k)
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {OW}
PlayResY: {OH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,{font},{size},{base[:-1]},{base[:-1]},&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,{outline},{max(1, int(3 * k)) if outline else 0},5,{m},{m},0,1
Style: Title,{font},{t_size},{t_fg[:-1]},{t_fg[:-1]},{t_bg[:-1]},{t_bg[:-1]},-1,0,0,0,100,100,0,0,3,{max(2, int(14 * k))},0,8,{m},{m},0,1
Style: LText,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,0,0,0,1
Style: LBox,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,3,10,0,5,0,0,0,1
Style: Chat,Arial,{max(10, int(_clamp(layout.get("chat_size", 34), 16, 90) * k))},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{max(1, round(2.2 * k, 1))},0,1,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    dur = end - start
    for li, lay in enumerate(layout.get("layers") or []):      # текстовые слои
        if lay.get("kind") != "text" or lay.get("hidden") or not str(lay.get("text") or "").strip():
            continue
        s0, e = layer_time(lay)
        e = min(dur, e if e is not None else dur)
        if e - s0 < 0.05:
            continue
        pos = lay.get("pos") or {}
        px, py = int(_clamp(pos.get("x", 0.5), 0, 1) * OW), int(_clamp(pos.get("y", 0.3), 0, 1) * OH)
        size = max(8, int(_clamp(lay.get("size", 80), 8, 400) * k))
        op = _clamp(lay.get("opacity", 1), 0, 1)
        style = lay.get("style") if lay.get("style") in ("outline", "box", "none") else "outline"
        a_txt = f"{int(255 * (1 - op)):02X}"
        tags = (f"\\an5\\pos({px},{py})\\fn{_clean(str(lay.get('font') or font))}\\fs{size}\\b{1 if lay.get('bold', True) else 0}"
                f"\\c{_ass_color(lay.get('color') or '#FFFFFF')}\\1a&H{a_txt}&\\shad0")
        if style == "box":
            a_bg = f"{int(255 * (1 - op * _clamp(lay.get('bg_op', 0.85), 0, 1))):02X}"
            tags += f"\\3c{_ass_color(lay.get('bg') or '#000000')}\\3a&H{a_bg}&\\bord{max(2, int(size * 0.28))}"
        elif style == "outline":
            tags += f"\\3c{_ass_color(lay.get('bg') or '#000000')}\\3a&H{a_txt}&\\bord{round(_clamp(lay.get('outline', 5), 0, 30) * k, 1)}"
        else:
            tags += "\\bord0"
        fd = int(_clamp(lay.get("fade", 0), 0, 5) * 1000)
        if fd:
            tags += f"\\fad({fd},{fd})"
        text = "\\N".join(_clean(x) for x in str(lay["text"]).splitlines())
        ev.append(f"Dialogue: {10 + li},{_ass_time(s0)},{_ass_time(e)},{'LBox' if style == 'box' else 'LText'},,0,0,0,,"
                  f"{{{tags}}}{text}")
    if layout.get("chat") and chat:
        geo, frames = chat_frames(chat, start, end, layout, out)
        x, y, w, h = geo["x"], geo["y"], geo["w"], geo["h"]
        bg = _clamp(layout.get("chat_bg", 0.45), 0, 1)
        if bg > 0.01:
            a = f"{int(255 * (1 - bg)):02X}"
            ev.append(f"Dialogue: 2,{_ass_time(0)},{_ass_time(end - start)},Chat,,0,0,0,,"
                      f"{{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&H000000&\\1a&H{a}&}}"
                      f"m {x} {y} l {x + w} {y} l {x + w} {y + h} l {x} {y + h}{{\\p0}}")
        for t0, t1, show in frames:
            if not show or t1 - t0 < 0.01:
                continue
            rows = []
            for msg, lines in show:
                user = _clean(_NO_GLYPH.sub("", msg.get("user") or "").strip() or "?")
                first = _clean(lines[0])
                if first.startswith(user + ":"):
                    first = f"{{\\c{_ass_color(chat_color(msg.get('user') or ''))}}}{user}:{{\\c&HFFFFFF&}}{first[len(user) + 1:]}"
                rows.append(first)
                rows += [_clean(s) for s in lines[1:]]
            ev.append(f"Dialogue: 3,{_ass_time(t0)},{_ass_time(t1)},Chat,,0,0,0,,"
                      f"{{\\an1\\pos({x + geo['pad']},{y + h - geo['pad']})}}" + "\\N".join(rows))
    if layout.get("title_overlay") and title.strip():
        ev.append(f"Dialogue: 1,{_ass_time(0)},{_ass_time(end - start)},Title,,0,0,0,,"
                  f"{{\\an8\\pos({OW // 2},{title_y})}}{_clean(title.strip())}")
    if layout.get("subtitles"):
        rel = [{"s": w["s"] - start, "e": w["e"] - start, "w": _clean(w["w"])}
               for w in words if w["e"] > start and w["s"] < end]
        groups = group_words(rel, int(_clamp(layout.get("sub_words", 3), 1, 6)))
        for gi, g in enumerate(groups):
            g_end = min(g[-1]["e"] + 0.25, groups[gi + 1][0]["s"] if gi + 1 < len(groups) else end - start)
            # длинные строки ужимаем, чтобы не вылезали за край кадра
            n_chars = sum(len(x["w"]) for x in g) + len(g) - 1
            fit = min(100, int(100 * 0.9 * OW / (max(1, n_chars) * size)))
            for wi, w in enumerate(g):
                t0 = w["s"] if wi else g[0]["s"]
                t1 = g[wi + 1]["s"] if wi + 1 < len(g) else g_end
                if t1 <= t0:
                    continue
                parts = []
                for j, x in enumerate(g):
                    txt = x["w"].upper() if upper else x["w"]
                    parts.append(f"{{\\c{hi}}}{txt}{{\\c{base}}}" if j == wi else txt)
                pop = (f"{{\\fscx{int(fit * .92)}\\fscy{int(fit * .92)}\\t(0,90,\\fscx{fit}\\fscy{fit})}}"
                       if wi == 0 else f"{{\\fscx{fit}\\fscy{fit}}}")
                ev.append(f"Dialogue: 0,{_ass_time(t0)},{_ass_time(t1)},Sub,,0,0,0,,"
                          f"{{\\an5\\pos({OW // 2},{y})}}{pop}{' '.join(parts)}")
    return head + "\n".join(ev) + "\n"


# ---------------------------------------------------------------- кодирование

CODECS = {"mp4": ["h264", "hevc", "av1"], "mov": ["h264", "hevc", "prores"],
          "mkv": ["h264", "hevc", "av1", "vp9"], "webm": ["vp9", "av1"]}
ENCODERS = {"h264": ("h264_nvenc", "libx264"), "hevc": ("hevc_nvenc", "libx265"), "av1": ("av1_nvenc", "libsvtav1"),
            "vp9": (None, "libvpx-vp9"), "prores": (None, "prores_ks")}
CODEC_NAME = {"h264": "H.264", "hevc": "H.265", "av1": "AV1", "vp9": "VP9", "prores": "ProRes"}
USED: dict[str, str] = {}       # чем закодирован клип — показывается в редакторе


def encoder_ok(name: str) -> bool:
    """Проверка, что кодировщик реально работает (у видеокарты может не быть, например, AV1)."""
    if name not in _encoder_cache:
        args = [ffbin("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                "-i", "color=black:s=640x360:d=0.2", "-c:v", name]
        if name == "prores_ks":
            args += ["-pix_fmt", "yuv422p10le"]
        p = subprocess.run(args + ["-f", "null", "-"], capture_output=True, creationflags=NO_WINDOW)
        _encoder_cache[name] = "ok" if p.returncode == 0 else "no"
    return _encoder_cache[name] == "ok"


def pick_encoder() -> str:          # для совместимости со старым кодом
    return "h264_nvenc" if encoder_ok("h264_nvenc") else "libx264"


def export_settings(L: dict) -> dict:
    """Нормализованные настройки экспорта: контейнер и кодек совместимы друг с другом."""
    cont = L.get("container") if L.get("container") in CODECS else "mp4"
    codec = L.get("vcodec") if L.get("vcodec") in CODECS[cont] else CODECS[cont][0]
    hw = L.get("hw") if L.get("hw") in ("auto", "gpu", "cpu") else "auto"
    if hw == "auto" and load_config()["render"].get("encoder") == "x264":
        hw = "cpu"
    return {"container": cont, "codec": codec, "hw": hw,
            "rate": "bitrate" if L.get("rate") == "bitrate" else "quality",
            "quality": int(_clamp(L.get("quality") or 21, 10, 40)),
            "bitrate": _clamp(L.get("bitrate") or 12, 0.5, 200),
            "speed": L.get("speed") if L.get("speed") in ("fast", "balanced", "quality") else "balanced",
            "abitrate": int(_clamp(L.get("abitrate") or 192, 64, 512))}


def video_args(X: dict) -> tuple[list[str], str]:
    """Аргументы ffmpeg для видео и человеческое описание («H.265 · видеокарта · MP4»)."""
    gpu, cpu = ENCODERS[X["codec"]]
    order = [cpu] if X["hw"] == "cpu" else [gpu, cpu]
    enc = next((e for e in order if e and encoder_ok(e)), None)
    if not enc:
        raise RuntimeError(f"ffmpeg не умеет кодировать {CODEC_NAME[X['codec']]} — выбери другой кодек")
    q, sp, br = X["quality"], ["fast", "balanced", "quality"].index(X["speed"]), X["bitrate"]
    by_rate = X["rate"] == "bitrate"
    rate = ["-b:v", f"{br:g}M", "-maxrate", f"{br * 1.5:g}M", "-bufsize", f"{br * 2:g}M"]
    if enc.endswith("_nvenc"):
        a = ["-c:v", enc, "-preset", ["p3", "p5", "p7"][sp], "-rc", "vbr"]
        a += rate if by_rate else ["-cq", str(q + (6 if enc == "av1_nvenc" else 0)), "-b:v", "0",
                                   "-maxrate", "60M", "-bufsize", "120M"]
    elif enc in ("libx264", "libx265"):
        a = ["-c:v", enc, "-preset", ["veryfast", "medium", "slow"][sp]]
        a += rate if by_rate else ["-crf", str(q + (4 if enc == "libx265" else 0))]
        if enc == "libx265":
            a += ["-x265-params", "log-level=error"]
    elif enc == "libsvtav1":
        a = ["-c:v", enc, "-preset", ["10", "7", "4"][sp]] + (["-b:v", f"{br:g}M"] if by_rate else ["-crf", str(q + 12)])
    elif enc == "libvpx-vp9":
        a = ["-c:v", enc, "-deadline", "good", "-cpu-used", ["5", "3", "1"][sp], "-row-mt", "1"]
        a += ["-b:v", f"{br:g}M"] if by_rate else ["-crf", str(q + 10), "-b:v", "0"]
    else:   # prores_ks: качество задаётся профилем (HQ)
        a = ["-c:v", enc, "-profile:v", "3", "-vendor", "apl0"]
    a += ["-pix_fmt", "yuv422p10le" if enc == "prores_ks" else "yuv420p"]
    if X["codec"] == "hevc" and X["container"] in ("mp4", "mov"):
        a += ["-tag:v", "hvc1"]         # чтобы играло на iPhone и в QuickTime
    if X["container"] in ("mp4", "mov"):
        a += ["-movflags", "+faststart"]
    desc = f"{CODEC_NAME[X['codec']]} · {'видеокарта' if enc.endswith('_nvenc') else 'процессор'} · {X['container'].upper()}"
    if by_rate and enc != "prores_ks":
        desc += f" · {br:g} Мбит/с"
    return a, desc


def audio_args(X: dict) -> list[str]:
    if X["codec"] == "prores":
        return ["-c:a", "pcm_s16le"]
    if X["container"] == "webm":
        return ["-c:a", "libopus", "-b:a", f"{X['abitrate']}k"]
    return ["-c:a", "aac", "-b:a", f"{X['abitrate']}k"]


def clip_words(pid: str, start: float, end: float, edits: dict | None = None) -> list[dict]:
    """Слова на отрезке. edits — правки пользователя: {"время начала слова": "новый текст"}, пустой текст скрывает слово."""
    f = pdir(pid) / "transcript.json"
    if not f.exists():
        return []
    out = []
    for seg in json.loads(f.read_text("utf-8"))["segments"]:
        if seg["end"] < start or seg["start"] > end:
            continue
        out += [w for w in seg.get("words") or [] if w["e"] > start and w["s"] < end]
    if edits:
        fixed = []
        for w in out:
            key = f"{w['s']:.2f}"
            if key in edits:
                if str(edits[key]).strip():
                    fixed.append({**w, "w": str(edits[key]).strip()})
            else:
                fixed.append(w)
        out = fixed
    return out


def audio_regions(audio: dict | None, start: float, end: float) -> list[dict]:
    """Звуковые правки клипа во времени клипа: [{s, e, type: bleep|mute|gain, gain}]."""
    out = []
    for r in (audio or {}).get("regions") or []:
        try:
            s, e = max(float(r["s"]), start) - start, min(float(r["e"]), end) - start
        except (KeyError, TypeError, ValueError):
            continue
        if e - s < 0.02:
            continue
        kind = r.get("type") if r.get("type") in ("bleep", "mute", "gain") else "bleep"
        out.append({"s": s, "e": e, "type": kind,
                    "gain": _clamp(r.get("gain", 0.4), 0, 4) if kind == "gain" else 0.0})
    return out


def audio_filter(audio: dict | None, start: float, end: float, normalize: bool) -> str | None:
    """Цепочка звука для filter_complex (выход [a]) или None, если правок нет."""
    regs = audio_regions(audio, start, end)
    vol = _clamp((audio or {}).get("vol", 1.0), 0, 3)
    if not regs and abs(vol - 1) < 0.01:
        return None
    # asetnsamples: loudnorm отдаёт хвост одним длинным куском, а громкость считается раз на кусок
    fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetnsamples=n=1024:p=0"
    expr = f"{vol:.3f}" + "".join(f"*(1+({r['gain']:.3f}-1)*between(t,{r['s']:.3f},{r['e']:.3f}))" for r in regs)
    chain = "[0:a:0]" + ("loudnorm=I=-14:TP=-1.5:LRA=11," if normalize else "") + f"{fmt},volume='{expr}':eval=frame"
    bleeps = [r for r in regs if r["type"] == "bleep"]
    if not bleeps:
        return chain + ",alimiter=limit=0.95[a]"
    on = "+".join(f"between(t,{r['s']:.3f},{r['e']:.3f})" for r in bleeps)
    return (f"{chain}[am];sine=frequency=1000:sample_rate=48000:duration={end - start:.3f},{fmt},"
            f"volume='1.3*gt({on},0)':eval=frame[bl];"      # sine сам по себе тихий (-18 дБ)
            f"[am][bl]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]")


def censor_words(words: list[dict], audio: dict | None) -> list[dict]:
    """Слова, попавшие под «пик», в субтитрах закрываются звёздочками."""
    bl = [r for r in (audio or {}).get("regions") or [] if r.get("type", "bleep") == "bleep"]
    if not bl:
        return words
    out = []
    for w in words:
        mid = (w["s"] + w["e"]) / 2
        if any(float(r["s"]) <= mid <= float(r["e"]) for r in bl):
            core = w["w"].strip()
            w = {**w, "w": core[:1] + "*" * max(2, len(core.rstrip(".,!?…")) - 1)}
        out.append(w)
    return out


def clip_chat(pid: str, start: float, end: float, hidden: list | None = None) -> list[dict]:
    """Сообщения чата около клипа (с запасом назад — окно чата не пустое с первой секунды)."""
    f = pdir(pid) / "chat.json"
    if not f.exists():
        return []
    hide = set(hidden or [])
    msgs = json.loads(f.read_text("utf-8"))
    return [{**m, "key": chat_key(m)} for m in msgs
            if start - 90 <= float(m["t"]) <= end + 30 and chat_key(m) not in hide and (m.get("text") or "").strip()]


def safe_name(title: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", title).strip(" .")
    return re.sub(r"\s+", " ", name)[:70] or "clip"


def _video_encoder(quality: int) -> list[str]:
    return video_args(export_settings({"quality": quality}))[0]


def _free_name(out_dir: Path, pattern: str, name: str, ext: str = "mp4") -> Path:
    """Удаляет прошлые файлы клипа; если какой-то занят плеером — пишем рядом под новым именем."""
    for old in out_dir.glob(pattern):
        try:
            old.unlink(missing_ok=True)
        except OSError:
            pass
    out, n = out_dir / f"{name}.{ext}", 2
    while out.exists():
        out = out_dir / f"{name} ({n}).{ext}"
        n += 1
    return out


def render_clip(project: dict, clip: dict, progress=None) -> Path:
    pid = project["id"]
    src = source_path(project)
    if not src.exists():
        raise RuntimeError("Исходное видео не найдено")
    W, H = int(project["width"]), int(project["height"])
    start, end = float(clip["start"]), float(clip["end"])
    dur = end - start
    if dur <= 0.5:
        raise RuntimeError("Клип слишком короткий")
    layout = resolve_layout(project, clip)
    pl = plan(layout, W, H)

    out_dir = pdir(pid) / "clips"
    out_dir.mkdir(exist_ok=True)
    X = export_settings(layout)
    out = _free_name(out_dir, f"*[[]{clip['id']}[]]*.*", f"{safe_name(clip.get('title') or 'clip')} [{clip['id']}]",
                     X["container"])

    graph = video_filter(pl, dur)
    last = "[v]"
    ass_name = f"{clip['id']}.ass"
    ass = build_ass(censor_words(clip_words(pid, start, end, clip.get("sub_edits")), clip.get("audio")),
                    start, end, layout, clip.get("title") or "", pl["title_y"], pl["out"],
                    chat=clip_chat(pid, start, end, clip.get("chat_hidden")) if layout.get("chat") else None)
    if "Dialogue:" in ass:
        (out_dir / ass_name).write_text(ass, "utf-8-sig")
        graph += f";[v]ass={ass_name}[vs]"
        last = "[vs]"

    rc = load_config()["render"]
    src_fps = float(project.get("fps") or 30)
    fps = float(layout.get("fps") or 0) or min(src_fps, float(rc["max_fps"]))
    args = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src)]
    for it in pl["items"]:          # картинки слоёв — по входу на каждую, в том же порядке, что в графе
        if it.get("img"):
            img = ASSETS / Path(it["img"]).name
            if not img.exists():
                raise RuntimeError(f"Картинка слоя не найдена: {img.name} — загрузи её заново")
            args += ["-loop", "1", "-t", f"{dur:.3f}", "-i", str(img)]
    args += ["-filter_complex", graph, "-map", last]
    if project.get("has_audio", True):
        af = audio_filter(clip.get("audio"), start, end, bool(rc.get("normalize_audio")))
        if af:      # пик / тишина / громкость по участкам
            args[args.index("-filter_complex") + 1] = graph + ";" + af
            args += ["-map", "[a]"] + audio_args(X) + ["-ar", "48000"]
        else:
            args += ["-map", "0:a:0"] + audio_args(X) + ["-ar", "48000"]
            if rc.get("normalize_audio"):
                args += ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"]
    vargs, USED[clip["id"]] = video_args(X)
    args += vargs + ["-r", f"{fps:g}", out.name]
    try:
        run_ffmpeg(args, dur, progress, cwd=str(out_dir))
    finally:
        (out_dir / ass_name).unlink(missing_ok=True)
    return out


def resolve_layout_export(project: dict, clip: dict) -> dict:
    """Настройки экспорта клипа без автопоиска вебки (для вырезки как есть)."""
    return _merge(_merge(DEFAULT_LAYOUT, project.get("layout") or {}), clip.get("layout") or {})


def render_plain(project: dict, clip: dict, progress=None) -> Path:
    """Просто вырезает отрезок из стрима как есть: исходный кадр, без раскладки, текста и обработки звука."""
    src = source_path(project)
    if not src.exists():
        raise RuntimeError("Исходное видео не найдено")
    start, end = float(clip["start"]), float(clip["end"])
    dur = end - start
    out_dir = pdir(project["id"]) / "clips"
    out_dir.mkdir(exist_ok=True)
    X = export_settings(resolve_layout_export(project, clip))
    out = _free_name(out_dir, f"*[[]{clip['id']}-orig[]]*.*",
                     f"{safe_name(clip.get('title') or 'clip')} (оригинал) [{clip['id']}-orig]", X["container"])
    args = ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src), "-map", "0:v:0"]
    if project.get("has_audio", True):
        args += ["-map", "0:a:0"] + audio_args(X)
    args += video_args(X)[0] + [out.name]
    run_ffmpeg(args, dur, progress, cwd=str(out_dir))
    return out
