"""
gemini.py — the model layer.

Two provenance modes; the pipeline is identical downstream of both:

  live     a real Gemini Interactions call ran on this request
  cached   served from the on-disk response cache (a real call ran earlier)

The cache is keyed on (prompt sha, schema name, prompt version, model), so
rehearsals are free and a prompt edit invalidates exactly what it changed.
Cache files are committed: a fresh clone seeds instantly without burning calls.

Nothing here substitutes canned output for a failed live call. A live failure
with no cache entry raises and is surfaced in the UI.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Optional, Type

from pydantic import BaseModel

import contract

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "cache"
CACHE_DIR.mkdir(exist_ok=True)

_LOCK = threading.RLock()
_PROVENANCE = "live"          # weakest-link across the current run
_WARNINGS: list[str] = []


def api_key() -> str:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""


def has_key() -> bool:
    return bool(api_key())


def warn(msg: str) -> None:
    with _LOCK:
        if msg not in _WARNINGS:
            _WARNINGS.append(msg)


def drain_warnings() -> list[str]:
    with _LOCK:
        out = list(_WARNINGS)
        _WARNINGS.clear()
        return out


def begin_run() -> None:
    """Reset provenance to the strongest state; the run can only weaken it."""
    global _PROVENANCE
    with _LOCK:
        _PROVENANCE = "live" if has_key() else "cached"


def current_provenance() -> str:
    return _PROVENANCE


def _weaken(value: str) -> None:
    global _PROVENANCE
    order = {"live": 2, "cached": 1}
    with _LOCK:
        if order.get(value, 0) < order.get(_PROVENANCE, 0):
            _PROVENANCE = value


def _cache_path(prompt: str, schema_name: str) -> Path:
    material = json.dumps(
        {"p": prompt, "s": schema_name, "v": contract.PROMPT_VERSION, "m": contract.MODEL},
        sort_keys=True,
    )
    return CACHE_DIR / (hashlib.sha256(material.encode()).hexdigest()[:24] + ".json")


def _response_text(interaction) -> str:
    txt = getattr(interaction, "output_text", None)
    if txt:
        return txt
    outputs = getattr(interaction, "outputs", None)
    if outputs:
        last = outputs[-1]
        txt = getattr(last, "text", None)
        if txt:
            return txt
        content = getattr(last, "content", None)
        if content:
            joined = "".join(getattr(c, "text", "") or "" for c in content)
            if joined:
                return joined
    raise RuntimeError("could not read text off the interaction: " + ", ".join(sorted(dir(interaction))))


def _call_live(prompt: str, system: str, schema: Type[BaseModel]) -> str:
    from google import genai

    client = genai.Client(api_key=api_key())
    # input is a plain string, NOT a list (google-genai types it str | typed steps).
    kwargs = dict(
        model=contract.MODEL,
        input=prompt,
        response_format={
            "type": "text",
            "mime_type": "application/json",
            "schema": schema.model_json_schema(),
        },
        generation_config={
            "thinking_level": contract.THINKING_LEVEL,
            "max_output_tokens": contract.MAX_OUTPUT_TOKENS,
        },
        system_instruction=system,
    )
    try:
        interaction = client.interactions.create(**kwargs)
    except TypeError as exc:
        warn(f"interactions.create rejected system_instruction top-level ({exc}); prepending to input")
        kwargs.pop("system_instruction")
        kwargs["input"] = system + "\n\n" + prompt
        interaction = client.interactions.create(**kwargs)

    status = getattr(interaction, "status", None)
    status = getattr(status, "value", status)
    if status is not None and str(status) != "completed":
        warn(f"Gemini interaction status was {status!r}, not 'completed'; output may be partial")
    return _response_text(interaction)


def call(prompt: str, system: str, schema: Type[BaseModel], use_cache: bool = True) -> BaseModel:
    """One entry point: returns a validated schema instance.

    Order: cache hit (when allowed) -> live call -> (API down) cache -> raise.
    Invalid JSON from a live call retries once before raising.
    """
    path = _cache_path(prompt, schema.__name__)

    if use_cache and path.exists():
        _weaken("cached")
        return schema.model_validate_json(path.read_text(encoding="utf-8"))

    if not has_key():
        if path.exists():
            _weaken("cached")
            return schema.model_validate_json(path.read_text(encoding="utf-8"))
        raise RuntimeError(
            "No GEMINI_API_KEY set and no cache entry for this request. "
            "Set the key (or restore the committed cache) and retry."
        )

    last_exc: Optional[Exception] = None
    for attempt in (1, 2):
        try:
            raw = _call_live(prompt, system, schema)
            # strip accidental markdown fences before validating
            raw = raw.strip()
            if raw.startswith("```"):
                raw = raw.strip("`")
                raw = raw[raw.find("{"):]
            obj = schema.model_validate_json(raw)
            path.write_text(obj.model_dump_json(indent=1), encoding="utf-8")
            return obj
        except Exception as exc:  # noqa: BLE001 — surfaced below, never swallowed
            last_exc = exc
            warn(f"model call attempt {attempt} failed: {exc}")
    if path.exists():
        warn("live call failed twice; serving the cached response for this request")
        _weaken("cached")
        return schema.model_validate_json(path.read_text(encoding="utf-8"))
    raise RuntimeError(f"model call failed twice and no cache entry exists: {last_exc}")


def clear_cache() -> int:
    n = 0
    for p in CACHE_DIR.glob("*.json"):
        p.unlink()
        n += 1
    return n
