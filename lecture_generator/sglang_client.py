"""
SGLang client for the lecture generator.
Uses the LLM Provider Manager with fallback: SGLang → Grok → Gemini → Ollama
"""
import json
import logging
from typing import Optional, Type

from pydantic import BaseModel

from lecture_generator import config

logger = logging.getLogger(__name__)

# Import Provider Manager
try:
    from server.rag_service.llm_provider_manager import get_llm_manager
    _PROVIDER_MANAGER_AVAILABLE = True
except ImportError:
    _PROVIDER_MANAGER_AVAILABLE = False
    logger.warning("Provider Manager not available, falling back to legacy client")

# Legacy clients for backward compatibility
_sglang_client = None
_gemini_client = None


def _get_sglang():
    """Return (or create) the SGLang OpenAI-compatible client (legacy)."""
    global _sglang_client
    if _sglang_client is not None:
        return _sglang_client
    if not config.SGLANG_ENABLED:
        return None
    try:
        from openai import OpenAI
        _sglang_client = OpenAI(base_url=config.LG_URL, api_key="EMPTY")
        logger.info("SGLang client ready  url=%s  model=%s", config.LG_URL, config.LG_MODEL)
    except ImportError:
        logger.error("openai package not installed. Run: pip install openai")
        _sglang_client = None
    return _sglang_client


def _get_gemini():
    """Return Gemini client only if admin has validated the key (legacy)."""
    global _gemini_client
    if _gemini_client is not None:
        return _gemini_client
    if not (config.GEMINI_API_VALIDATED and config.GEMINI_API_KEY):
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=config.GEMINI_API_KEY)
        _gemini_client = genai.GenerativeModel(config.GEMINI_MODEL)
        logger.info("Gemini fallback ready  model=%s", config.GEMINI_MODEL)
    except ImportError:
        logger.warning("google-generativeai not installed — Gemini fallback unavailable")
        _gemini_client = None
    return _gemini_client


# ── Health check ───────────────────────────────────────────────────────

def check_health() -> bool:
    """Ping the first healthy provider."""
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            provider = manager.get_healthy_provider()
            return provider is not None
        except Exception as exc:
            logger.warning("Provider Manager health check failed: %s", exc)
    
    # Legacy fallback
    client = _get_sglang()
    if client is None:
        return False
    try:
        client.models.list()
        return True
    except Exception as exc:
        logger.warning("SGLang health check failed: %s", exc)
        return False


# ── Core generation call ───────────────────────────────────────────────

def generate(
    system: str,
    user: str,
    params: Optional[dict] = None,
) -> Optional[str]:
    """
    Plain text generation via Provider Manager (SGLang → Grok → Gemini → Ollama).
    Returns the response string or None if all providers fail.
    """
    p = params or config.NOTE_PARAMS
    messages = [
        {"role": "system", "content": system},
        {"role": "user",   "content": user},
    ]

    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            result = manager.generate(
                messages=messages,
                model=config.LG_MODEL,
                temperature=p.get("temperature", 0.25),
                max_tokens=p.get("max_tokens", 3500),
            )
            if result:
                return result.strip()
        except Exception as exc:
            logger.warning("Provider Manager generation failed: %s — trying legacy fallback", exc)

    # Legacy fallback: SGLang → Gemini
    # ── 1. SGLang (primary) ───────────────────────────────────────────
    client = _get_sglang()
    if client:
        try:
            resp = client.chat.completions.create(
                model=config.LG_MODEL,
                messages=messages,
                temperature=p.get("temperature", 0.25),
                max_tokens=p.get("max_tokens", 3500),
            )
            content = resp.choices[0].message.content
            if content:
                return content.strip()
        except Exception as exc:
            logger.warning("SGLang generation failed: %s — trying fallback", exc)

    # ── 2. Gemini (admin-validated only) ─────────────────────────────
    gemini = _get_gemini()
    if gemini:
        try:
            full_prompt = f"{system}\n\n{user}"
            resp = gemini.generate_content(full_prompt)
            return resp.text.strip()
        except Exception as exc:
            logger.error("Gemini fallback also failed: %s", exc)

    logger.error("No LLM available. Ensure at least one provider is configured.")
    return None


def generate_structured(
    system: str,
    user: str,
    schema_model: Type[BaseModel],
    schema_name: str = "response_schema",
    params: Optional[dict] = None,
) -> Optional[dict]:
    """
    Constrained JSON generation using Provider Manager with fallback.
    Returns a validated dict on success, or None on failure.
    """
    p = params or config.SCHEMA_PARAMS

    # Use Provider Manager if available
    if _PROVIDER_MANAGER_AVAILABLE:
        try:
            manager = get_llm_manager()
            result = manager.generate_structured(
                system_prompt=system,
                user_prompt=user,
                schema=schema_model.model_json_schema(),
                model=config.LG_MODEL,
                temperature=p.get("temperature", 0.1),
                max_tokens=p.get("max_tokens", 4000),
            )
            if result:
                return result
        except Exception as exc:
            logger.warning("Provider Manager structured generation failed: %s — trying legacy", exc)

    # Legacy fallback
    messages = [
        {"role": "system", "content": f"{system}\nAlways output valid JSON matching the required schema."},
        {"role": "user",   "content": user},
    ]

    # ── 1. SGLang with constrained JSON schema (primary) ─────────────
    client = _get_sglang()
    if client:
        # Try with increasing token budgets (handles truncation on first attempt)
        for max_tok in [p.get("max_tokens", 4000), 6000, 8000]:
            try:
                resp = client.chat.completions.create(
                    model=config.LG_MODEL,
                    messages=messages,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name":   schema_name,
                            "schema": schema_model.model_json_schema(),
                            "strict": True,
                        },
                    },
                    temperature=p.get("temperature", 0.1),
                    max_tokens=max_tok,
                )
                raw = resp.choices[0].message.content
                finish = resp.choices[0].finish_reason
                if finish == "length":
                    # Response was truncated — retry with higher budget
                    logger.warning(
                        "SGLang response truncated at %d tokens, retrying with %d",
                        max_tok, min(max_tok + 2000, 8000),
                    )
                    if max_tok >= 8000:
                        break  # Can't go higher, fall through to Gemini
                    continue
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                logger.warning(
                    "SGLang JSON parse error (truncated response?): %s — retrying", exc
                )
                continue
            except Exception as exc:
                logger.warning("SGLang structured generation failed: %s — trying fallback", exc)
                break

    # ── 2. Gemini fallback (plain generation + JSON parse) ───────────
    gemini = _get_gemini()
    if gemini:
        try:
            schema_hint = json.dumps(schema_model.model_json_schema(), indent=2)
            full_prompt = (
                f"{system}\n\n"
                f"Return ONLY valid JSON matching this schema:\n{schema_hint}\n\n"
                f"{user}"
            )
            resp = gemini.generate_content(full_prompt)
            text = resp.text.strip()
            # Strip markdown code fences if present
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            return json.loads(text.strip())
        except Exception as exc:
            logger.error("Gemini structured fallback failed: %s", exc)

    logger.error("No LLM available for structured generation.")
    return None
