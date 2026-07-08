"""
sglang_caps.py
==============
Fetches live model capabilities from the SGLang /v1/models endpoint once
and caches the result so every generator always uses the real context length.

Usage:
    from sglang_caps import get_model_max_context

    max_ctx = get_model_max_context()       # e.g. 8192
    safe    = max_ctx - estimated_input - 256

Why not hardcode?
    The same code runs against different SGLang deployments:
      • 7B-AWQ  → 8192 tokens (--context-length 8192)
      • 14B-AWQ → configurable
      • 32B-AWQ → often 4096 on single GPU
    Hardcoding the wrong value causes 400 "Requested token count exceeds
    model's maximum context length" errors on every single request.
"""

from __future__ import annotations

import logging
import os
import re
import time
from typing import Optional

logger = logging.getLogger(__name__)

_DEFAULT_FALLBACK = 32768
_cached: Optional[int] = None
_cached_model_id: Optional[str] = None


def _base_url() -> str:
    """Return the SGLang root URL (no /v1 suffix)."""
    raw = (
        os.getenv("SGLANG_HEAVY_URL") or
        os.getenv("SGLANG_CHAT_URL") or
        "http://localhost:8000/v1"
    )
    # Strip trailing /v1 or /v1/ so we can build canonical paths
    return re.sub(r"/v1/?$", "", raw.rstrip("/"))


def get_model_max_context(fallback: int = _DEFAULT_FALLBACK) -> int:
    """
    Return the serving model's declared context length.

    Fetches GET /v1/models on the first call (with 3 retries / 5 s timeout
    each), caches the result, and returns it synchronously on all subsequent
    calls.  If the endpoint is unreachable the `fallback` value is cached and
    returned so callers always receive a valid integer.
    """
    global _cached, _cached_model_id

    if _cached is not None:
        return _cached

    url = f"{_base_url()}/v1/models"

    for attempt in range(1, 4):
        try:
            import requests  # local import — keeps startup clean if unused
            resp = requests.get(url, timeout=5)
            resp.raise_for_status()
            data = resp.json()
            model = (data.get("data") or [{}])[0]
            max_len = model.get("max_model_len")
            if max_len:
                _cached = int(max_len)
                _cached_model_id = model.get("id")
                logger.info(
                    f"[SGLang Caps] model={_cached_model_id}  "
                    f"max_context={_cached} tokens"
                )
                return _cached
            raise ValueError("max_model_len missing from /v1/models response")

        except Exception as exc:
            logger.warning(
                f"[SGLang Caps] fetch attempt {attempt}/3 failed: {exc}"
            )
            if attempt < 3:
                time.sleep(attempt)  # 1 s, 2 s back-off

    logger.warning(
        f"[SGLang Caps] Could not reach SGLang; using fallback "
        f"context={fallback}"
    )
    _cached = fallback
    return _cached


def get_model_id() -> Optional[str]:
    """Return the model id string, or None if not yet fetched."""
    return _cached_model_id
