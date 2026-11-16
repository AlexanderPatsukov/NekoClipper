"""Клиент для любого OpenAI-совместимого сервера (локальная модель или API по ключу)."""
from __future__ import annotations

import json
import re

import requests

from .core import load_config


class LLMError(RuntimeError):
    pass


def _headers(cfg: dict) -> dict:
    h = {"Content-Type": "application/json"}
    if cfg.get("api_key"):
        h["Authorization"] = f"Bearer {cfg['api_key']}"
    return h


def list_models(cfg: dict | None = None) -> list[str]:
    cfg = cfg or load_config()["llm"]
    r = requests.get(cfg["base_url"].rstrip("/") + "/models", headers=_headers(cfg), timeout=10)
    r.raise_for_status()
    return [m["id"] for m in r.json().get("data", [])]


def resolve_model(cfg: dict) -> str:
    if cfg.get("model"):
        return cfg["model"]
    models = list_models(cfg)
    if not models:
        raise LLMError("Сервер не вернул ни одной модели")
    return models[0]


def available(cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()["llm"]
    if not cfg.get("enabled"):
        return False
    try:
        resolve_model(cfg)
        return True
    except Exception:
        return False


def chat(system: str, user: str, cfg: dict | None = None, max_tokens: int | None = None) -> str:
    cfg = cfg or load_config()["llm"]
    body = {
        "model": resolve_model(cfg),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": cfg.get("temperature", 0.4),
        "max_tokens": max_tokens or cfg.get("max_tokens", 6000),
    }
    try:
        r = requests.post(cfg["base_url"].rstrip("/") + "/chat/completions", headers=_headers(cfg),
                          data=json.dumps(body).encode("utf-8"), timeout=cfg.get("timeout", 600))
    except requests.RequestException as e:
        raise LLMError(f"LLM недоступна: {e}") from e
    if r.status_code >= 400:
        raise LLMError(f"LLM вернула {r.status_code}: {r.text[:300]}")
    msg = r.json()["choices"][0]["message"]
    content = msg.get("content") or ""
    # «думающие» модели: рассуждения либо в отдельном поле, либо в <think>
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    if not content:
        content = (msg.get("reasoning_content") or "").strip()
    return content


def extract_json(text: str):
    """Достаёт последний корректный JSON-массив/объект из ответа модели."""
    text = re.sub(r"```(?:json)?", "", text)
    best = None
    for opener, closer in (("[", "]"), ("{", "}")):
        starts = [i for i, ch in enumerate(text) if ch == opener]
        for s in reversed(starts):
            depth, in_str, esc = 0, False, False
            for i in range(s, len(text)):
                ch = text[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            val = json.loads(text[s:i + 1])
                            if best is None or s < best[0]:
                                best = (s, val)
                        except Exception:
                            pass
                        break
        if best is not None:
            return best[1]
    raise LLMError("В ответе модели нет JSON")


def chat_json(system: str, user: str, cfg: dict | None = None, retries: int = 1):
    last = None
    for _ in range(retries + 1):
        try:
            return extract_json(chat(system, user, cfg))
        except LLMError as e:
            last = e
    raise last
