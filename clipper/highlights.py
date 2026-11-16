"""Поиск лучших моментов: громкость + чат + речь + LLM-редактор."""
from __future__ import annotations

import json
import re

import numpy as np

from . import llm
from .core import fmt_time, load_config, new_id, pdir

LAUGH = re.compile(r"(?:а?ха){2,}|(?:хе){2,}|ахах|лол|кек|ору\b|жесть|офиге|охре|капец|пипец|"
                   r"\bлюто|\bимба|ничего себе|да ладно|что это|\bнет{2,}|\bwtf\b|\bomg\b|"
                   r"holy|no way|let'?s go|\blol\b|\blmao\b|insane|clutch", re.I)

SYSTEM = ("Ты — опытный редактор, который нарезает стримы на вирусные вертикальные шортсы "
          "(YouTube Shorts, TikTok). Ты выбираешь только те моменты, которые зацепят зрителя, "
          "не видевшего стрим. Отвечаешь строго JSON без пояснений.")


def clean_title(raw) -> str:
    """Чистит заголовок от модели: без кавычек и эмодзи; пустышки вроде «...» отбрасываются."""
    t = re.sub(r"[^\w\s.,!?:;%№#&+()\-–—'’/]", "", str(raw or ""))
    t = re.sub(r"\s+", " ", t).strip(" .,;:-–—")
    return t if len(re.findall(r"[^\W\d_]", t)) >= 3 else ""


def _z(x: np.ndarray) -> np.ndarray:
    med = np.median(x)
    mad = np.median(np.abs(x - med)) * 1.4826
    if mad < 1e-6:
        mad = x.std() + 1e-6
    return np.clip((x - med) / mad, -2.0, 8.0)


def _smooth(x: np.ndarray, k: int) -> np.ndarray:
    return np.convolve(x, np.ones(k) / k, mode="same")


def make_lines(segs: list[dict]) -> list[dict]:
    """Режет речь на короткие фразы по пунктуации и паузам (границы будущих клипов)."""
    lines, cur = [], []

    def flush():
        if cur:
            lines.append({"start": cur[0]["s"], "end": cur[-1]["e"],
                          "text": " ".join(w["w"] for w in cur)})
            cur.clear()

    for seg in segs:
        words = seg.get("words") or [{"s": seg["start"], "e": seg["end"], "w": seg["text"]}]
        for w in words:
            if cur and (w["s"] - cur[-1]["e"] > 0.8 or w["e"] - cur[0]["s"] > 12):
                flush()
            cur.append(w)
            if w["w"][-1:] in ".?!…":
                flush()
        flush()
    return lines


def build_signals(pid: str, duration: float, loud: np.ndarray, chat: list[dict],
                  segs: list[dict]) -> dict:
    n = max(2, int(duration) + 1)
    if len(loud) < n:
        loud = np.concatenate([loud, np.full(n - len(loud), loud.min() if len(loud) else -60.0)])
    loud = loud[:n].astype(np.float64)

    prev = np.concatenate([[loud[0]], np.convolve(loud, np.ones(20) / 20, mode="full")[: n - 1]])
    audio = np.maximum(0.5 * _z(loud) + 0.5 * _z(loud - prev), -1.0)

    chat_sig = np.zeros(n)
    has_chat = len(chat) >= 15
    if has_chat:
        counts = np.zeros(n + 20)
        for m in chat:
            t = int(m["t"])
            if 0 <= t < n + 20:
                counts[t] += 1
        cs = np.concatenate([[0], np.cumsum(counts)])
        # чат реагирует с задержкой: момент T обсуждают в T+2…T+14
        rate = np.array([cs[min(t + 14, n + 20)] - cs[min(t + 2, n + 20)] for t in range(n)])
        chat_sig = np.clip((rate - rate.mean()) / (rate.std() + 1e-6), -1.0, 8.0)

    wps, excl = np.zeros(n), np.zeros(n)
    for seg in segs:
        for w in seg.get("words") or []:
            t = int(w["s"])
            if t < n:
                wps[t] += 1
                if "!" in w["w"] or LAUGH.search(w["w"]):
                    excl[t] += 1
        t = int(seg["start"])
        if t < n:
            excl[t] += len(LAUGH.findall(seg["text"])) * 0.5
    speech = _z(_smooth(wps, 5)) if wps.sum() > 30 else np.zeros(n)

    score = audio + (1.3 * chat_sig if has_chat else 0) + 0.35 * speech + 0.6 * _smooth(excl, 5) * 5
    score = _smooth(score, 5)
    sig = {"has_chat": has_chat, "audio": audio, "chat": chat_sig, "score": score}
    (pdir(pid) / "signals.json").write_text(json.dumps({
        "has_chat": has_chat,
        "audio": [round(float(v), 2) for v in audio],
        "chat": [round(float(v), 2) for v in chat_sig],
        "score": [round(float(v), 2) for v in score],
    }), "utf-8")
    return sig


def _peaks(score: np.ndarray, count: int, sep: int = 40) -> list[int]:
    s = score.copy()
    floor = np.median(score) + 0.5 * score.std()
    out = []
    for _ in range(count):
        p = int(np.argmax(s))
        if s[p] < floor:
            break
        out.append(p)
        s[max(0, p - sep): p + sep] = -1e9
    return out


def _overlap(a: dict, b: dict) -> float:
    inter = min(a["end"], b["end"]) - max(a["start"], b["start"])
    return max(0.0, inter) / max(1e-6, min(a["end"] - a["start"], b["end"] - b["start"]))


def _fit(c: dict, lines: list[dict], score: np.ndarray, duration: float, hl: dict) -> None:
    """Подгоняет длину клипа и привязывает края к границам фраз."""
    lo, hi = float(hl["min_len"]), float(hl["max_len"])
    s, e = c["start"], c["end"]
    if e - s > hi:
        cs = np.concatenate([[0], np.cumsum(score)])
        best, best_v = int(s), -1e18
        for t in range(int(s), max(int(s) + 1, int(e - hi) + 1)):
            v = cs[min(len(score), int(t + hi))] - cs[min(len(score), t)]
            if v > best_v:
                best, best_v = t, v
        s, e = float(best), best + hi
    if e - s < lo:
        need = lo - (e - s)
        s, e = s - need * 0.65, e + need * 0.35
    s, e = max(0.0, s), min(duration, e)
    starts = [l["start"] for l in lines if s - 4 <= l["start"] <= s + 3]
    if starts:
        s = min(starts, key=lambda v: abs(v - s))
    ends = [l["end"] for l in lines if e - 3 <= l["end"] <= e + 5 and l["end"] > s + lo * 0.8]
    if ends:
        e = min(ends, key=lambda v: abs(v - e))
    s, e = max(0.0, s - 0.2), min(duration, e + 0.4)
    if e - s > hi + 1.5:
        e = s + hi
    c["start"], c["end"] = round(s, 2), round(e, 2)


def _text(lines: list[dict], s: float, e: float) -> str:
    return " ".join(l["text"] for l in lines if l["end"] > s and l["start"] < e)


def _scan_with_llm(meta: dict, lines: list[dict], sig: dict, per_chunk: int, hl: dict,
                   progress, warn) -> list[dict]:
    score = sig["score"]
    hot = np.percentile(score, 90)
    chunks, cur, chars = [], [], 0
    for i, l in enumerate(lines):
        if cur and (chars > 5000 or l["end"] - lines[cur[0]]["start"] > 480):
            chunks.append(cur)
            cur, chars = [], 0
        cur.append(i)
        chars += len(l["text"]) + 14
    if cur:
        chunks.append(cur)

    found = []
    for ci, idxs in enumerate(chunks):
        rows = []
        for i in idxs:
            l = lines[i]
            a, b = int(l["start"]), min(len(score), int(l["end"]) + 1)
            marks = ""
            if b > a and score[a:b].max() >= hot:
                marks += "🔥"
            if sig["has_chat"] and b > a and sig["chat"][a:b].max() >= 2:
                marks += "💬"
            rows.append(f"{i} [{fmt_time(l['start'])}] {marks} {l['text']}".replace("  ", " "))
        user = (
            f"Стрим: «{meta.get('title', '')}», канал {meta.get('channel', '')}.\n"
            f"Ниже фрагмент расшифровки. Формат строки: номер [время] метки текст. "
            f"Метка 🔥 — в этот момент на стриме громко/эмоционально, 💬 — чат резко оживился.\n\n"
            + "\n".join(rows) +
            f"\n\nНайди до {per_chunk} лучших моментов для шортсов: смешное, эмоции, неожиданные повороты, "
            f"фейлы и победы, дерзкие или цепляющие высказывания, законченные мини-истории. "
            f"Момент должен быть понятен без контекста, начинаться с начала мысли и заканчиваться на её "
            f"завершении, длиться {hl['min_len']}–{hl['max_len']} секунд. Скучную болтовню не бери — "
            f"лучше вернуть меньше моментов или пустой список [].\n"
            f"Для каждого момента укажи номера первой и последней строки, цепляющий заголовок до 55 символов "
            f"на языке стрима (без кликбейт-вранья, без кавычек и эмодзи), оценку вирусности 1–10 и короткую причину.\n"
            f'Ответ — только JSON-массив: [{{"from": 12, "to": 18, "title": "…", "score": 8, "reason": "…"}}]'
        )
        try:
            items = llm.chat_json(SYSTEM, user)
            if isinstance(items, dict):
                items = items.get("moments") or items.get("items") or [items]
            for it in items or []:
                try:
                    a, b = int(it["from"]), int(it["to"])
                except Exception:
                    continue
                if a > b or a < idxs[0] - 2 or b > idxs[-1] + 2:
                    continue
                if not clean_title(it.get("title")):   # модель вернула шаблон-пустышку
                    continue
                a, b = max(a, 0), min(b, len(lines) - 1)
                found.append({"start": lines[a]["start"], "end": lines[b]["end"],
                              "title": clean_title(it.get("title")),
                              "llm": float(np.clip(float(it.get("score") or 5) / 10, 0.1, 1.0)),
                              "reason": str(it.get("reason") or "").strip(), "src": "llm"})
        except llm.LLMError as e:
            warn(f"LLM: фрагмент {ci + 1}/{len(chunks)} пропущен — {e}")
            if "недоступна" in str(e):
                break
        if progress:
            progress((ci + 1) / len(chunks) * 0.85)
    return found


def _rate_with_llm(meta: dict, cands: list[dict], lines: list[dict], warn) -> None:
    todo = [c for c in cands if not c.get("title") and len(c["text"]) >= 15]
    for i in range(0, len(todo), 4):
        batch = todo[i:i + 4]
        blocks = "\n\n".join(f"### id={j} ({int(c['end'] - c['start'])} с, с {fmt_time(c['start'])})\n{c['text'][:1500]}"
                             for j, c in enumerate(batch))
        user = (
            f"Стрим: «{meta.get('title', '')}», канал {meta.get('channel', '')}.\n"
            f"Автоматика нашла эмоциональные всплески (громкость, реакция чата). Ниже расшифровка каждого момента.\n\n"
            f"{blocks}\n\nДля каждого момента придумай цепляющий заголовок шортса до 55 символов на языке стрима (без кавычек и эмодзи), "
            f"оцени вирусность 1–10 (скучное — низко) и дай короткую причину.\n"
            f'Ответ — только JSON-массив: [{{"id": 0, "title": "…", "score": 7, "reason": "…"}}]'
        )
        try:
            for it in llm.chat_json(SYSTEM, user) or []:
                try:
                    c = batch[int(it["id"])]
                except Exception:
                    continue
                c["title"] = clean_title(it.get("title"))
                c["llm"] = float(np.clip(float(it.get("score") or 4) / 10, 0.1, 1.0))
                c["reason"] = str(it.get("reason") or "").strip()
        except llm.LLMError as e:
            warn(f"LLM: не удалось оценить часть моментов — {e}")
            return


def find_highlights(meta: dict, segs: list[dict], sig: dict, progress=None, warn=print) -> list[dict]:
    cfg = load_config()
    hl = cfg["highlights"]
    duration = float(meta["duration"])
    count = int(hl.get("count") or 0) or int(np.clip(round(duration / 300), 6, 24))
    count = max(1, min(count, int(duration / (hl["min_len"] * 1.5)) or 1))
    score = sig["score"]
    lines = make_lines(segs)
    use_llm = llm.available(cfg["llm"])
    if cfg["llm"].get("enabled") and not use_llm:
        warn("LLM недоступна — моменты выбраны только по громкости, чату и речи.")

    cands: list[dict] = []
    if use_llm and lines:
        cands += _scan_with_llm(meta, lines, sig, 3, hl, progress, warn)

    target = float(hl["target_len"])
    for p in _peaks(score, count * 2):
        c = {"start": p - target * 0.62, "end": p + target * 0.38, "src": "signal",
             "reason": "Всплеск громкости" + (" и чата" if sig["has_chat"] and sig["chat"][p] > 1.5 else "")}
        c["start"], c["end"] = max(0.0, c["start"]), min(duration, c["end"])
        if all(_overlap(c, o) < 0.3 for o in cands):
            cands.append(c)

    ref = max(1e-6, float(np.percentile(score, 99.7)))
    for c in cands:
        _fit(c, lines, score, duration, hl)
        a, b = int(c["start"]), max(int(c["start"]) + 1, min(len(score), int(c["end"]) + 1))
        c["sig"] = float(np.clip(score[a:b].max() / ref, 0, 1))
        c["text"] = _text(lines, c["start"], c["end"])

    if use_llm:
        _rate_with_llm(meta, cands, lines, warn)
    if progress:
        progress(0.97)

    for c in cands:
        c["score"] = round(100 * (0.55 * c.get("llm", 0.4 if c["text"] else 0.3) + 0.45 * c["sig"]))
        if not c.get("title"):
            words = c["text"].split()
            c["title"] = (" ".join(words[:7]) + ("…" if len(words) > 7 else "")) if words \
                else f"Момент на {fmt_time(c['start'])}"

    cands.sort(key=lambda c: c["score"], reverse=True)
    kept: list[dict] = []
    for c in cands:
        if c["end"] - c["start"] < 5:
            continue
        if all(_overlap(c, k) < 0.25 for k in kept):
            kept.append(c)
        if len(kept) >= count:
            break

    return [{"id": new_id("c"), "start": c["start"], "end": c["end"], "title": c["title"][:80],
             "reason": c.get("reason", ""), "score": c["score"], "source": c["src"],
             "text": c["text"][:400], "layout": None, "status": "draft", "file": None}
            for c in kept]
