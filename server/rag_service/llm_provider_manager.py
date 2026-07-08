"""
LLM Provider Manager with Multi-Provider Fallback

Priority Order:
1. SGLang (Primary)
2. Grok (Secondary)
3. Gemini (Tertiary)
4. Ollama (Final local fallback)

Provides health checks, retry logic, timeout handling, and automatic failover.
"""

import os
import json
import time
import logging
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, List, Callable
from dataclasses import dataclass
from enum import Enum

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None

try:
    import google.generativeai as genai
except ImportError:
    genai = None

try:
    from groq import Groq
except ImportError:
    Groq = None

try:
    import requests
except ImportError:
    requests = None

logger = logging.getLogger(__name__)


class ProviderType(Enum):
    SGLANG = "sglang"
    GROK = "grok"
    GROQ = "groq"
    GEMINI = "gemini"
    OLLAMA = "ollama"


@dataclass
class ProviderConfig:
    name: str
    enabled: bool = True
    timeout: int = 30
    max_retries: int = 2
    retry_delay: float = 1.0


@dataclass
class HealthCheckResult:
    provider: ProviderType
    healthy: bool
    latency_ms: float
    error: Optional[str] = None


class BaseProvider(ABC):
    """Abstract base class for LLM providers."""

    def __init__(self, config: ProviderConfig):
        self.config = config
        self._client = None

    @abstractmethod
    def health_check(self) -> HealthCheckResult:
        """Check if provider is available and responsive."""
        pass

    @abstractmethod
    def generate(
        self,
        messages: List[Dict[str, str]],
        model: str,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        """Generate completion from messages."""
        pass

    @abstractmethod
    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: str,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        """Generate structured JSON output using schema."""
        pass


class SGLangProvider(BaseProvider):
    """SGLang provider using OpenAI-compatible API."""

    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.base_url = os.getenv("SGLANG_HEAVY_URL", "http://localhost:8000/v1")
        self.default_model = os.getenv("SGLANG_HEAVY_MODEL", "Qwen/Qwen2.5-7B-Instruct-AWQ")

    def _get_client(self) -> OpenAI:
        if self._client is None:
            if OpenAI is None:
                raise ImportError("openai package not installed")
            self._client = OpenAI(base_url=self.base_url, api_key="EMPTY", timeout=self.config.timeout)
        return self._client

    def health_check(self) -> HealthCheckResult:
        start = time.time()
        try:
            client = self._get_client()
            models = client.models.list()
            latency = (time.time() - start) * 1000
            healthy = len(models.data) > 0
            return HealthCheckResult(
                provider=ProviderType.SGLANG,
                healthy=healthy,
                latency_ms=latency,
                error=None if healthy else "No models available"
            )
        except Exception as e:
            latency = (time.time() - start) * 1000
            return HealthCheckResult(
                provider=ProviderType.SGLANG,
                healthy=False,
                latency_ms=latency,
                error=str(e)
            )

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        model = model or self.default_model
        last_error = None

        for attempt in range(self.config.max_retries + 1):
            try:
                client = self._get_client()
                params = {
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                }
                if response_format:
                    params["response_format"] = response_format

                resp = client.chat.completions.create(**params)
                content = resp.choices[0].message.content
                if content:
                    return content
                last_error = "Empty response"
            except Exception as e:
                last_error = str(e)
                if "length" in str(e).lower() or "max_tokens" in str(e).lower():
                    max_tokens = int(max_tokens * 1.5)
                    continue
            if attempt < self.config.max_retries:
                time.sleep(self.config.retry_delay * (attempt + 1))

        logger.error(f"SGLang generation failed after {self.config.max_retries + 1} attempts: {last_error}")
        return None

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        model = model or self.default_model
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]

        response_format = {
            "type": "json_schema",
            "json_schema": {
                "name": schema.get("title", "response"),
                "schema": schema,
                "strict": True
            }
        }

        content = self.generate(messages, model, temperature, max_tokens, response_format)
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                return self._repair_json(content)
        return None

    def _repair_json(self, content: str) -> Optional[Dict]:
        """Attempt to repair truncated or malformed JSON."""
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        try:
            if content.count("{") > content.count("}"):
                content = content + "}" * (content.count("{") - content.count("}"))
            return json.loads(content)
        except json.JSONDecodeError:
            return None


class GrokProvider(BaseProvider):
    """Grok (xAI) provider using OpenAI-compatible API."""

    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.api_key = os.getenv("GROK_API_KEY")
        self.base_url = os.getenv("GROK_URL", "https://api.x.ai/v1")
        self.default_model = os.getenv("GROK_MODEL", "grok-2-latest")

    def _get_client(self) -> OpenAI:
        if self._client is None:
            if OpenAI is None:
                raise ImportError("openai package not installed")
            if not self.api_key:
                raise ValueError("GROK_API_KEY not configured")
            self._client = OpenAI(base_url=self.base_url, api_key=self.api_key, timeout=self.config.timeout)
        return self._client

    def health_check(self) -> HealthCheckResult:
        start = time.time()
        try:
            if not self.api_key:
                return HealthCheckResult(ProviderType.GROK, False, 0, "GROK_API_KEY not configured")
            client = self._get_client()
            models = client.models.list()
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GROK, True, latency)
        except Exception as e:
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GROK, False, latency, str(e))

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        if not self.api_key:
            logger.warning("Grok API key not configured")
            return None

        model = model or self.default_model
        for attempt in range(self.config.max_retries + 1):
            try:
                client = self._get_client()
                params = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
                if response_format:
                    params["response_format"] = response_format
                resp = client.chat.completions.create(**params)
                content = resp.choices[0].message.content
                if content:
                    return content
            except Exception as e:
                if attempt == self.config.max_retries:
                    logger.error(f"Grok generation failed: {e}")
                else:
                    time.sleep(self.config.retry_delay)
        return None

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        content = self.generate(
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            model, temperature, max_tokens,
            {"type": "json_schema", "json_schema": {"name": schema.get("title", "response"), "schema": schema, "strict": True}}
        )
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                pass
        return None


class GroqProvider(BaseProvider):
    """GroqCloud provider using Groq SDK."""

    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.api_key = os.getenv("GROQ_API_KEY", "")
        self.default_model = os.getenv("GROQ_MODEL_NAME", "llama-3.3-70b-versatile")

    def _get_client(self):
        if self._client is None:
            if Groq is None:
                raise ImportError("groq package not installed")
            if not self.api_key:
                raise ValueError("GROQ_API_KEY not configured")
            self._client = Groq(api_key=self.api_key)
        return self._client

    def health_check(self) -> HealthCheckResult:
        start = time.time()
        try:
            if not self.api_key:
                return HealthCheckResult(ProviderType.GROQ, False, 0, "GROQ_API_KEY not configured")
            client = self._get_client()
            models = client.models.list()
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GROQ, True, latency)
        except Exception as e:
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GROQ, False, latency, str(e))

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        if not self.api_key:
            logger.warning("Groq API key not configured")
            return None

        model = model or self.default_model
        for attempt in range(self.config.max_retries + 1):
            try:
                client = self._get_client()
                params = {"model": model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
                if response_format:
                    if response_format.get("type") == "json_schema":
                        params["response_format"] = {"type": "json_object"}
                resp = client.chat.completions.create(**params)
                content = resp.choices[0].message.content
                if content:
                    return content
            except Exception as e:
                if attempt == self.config.max_retries:
                    logger.error(f"Groq generation failed: {e}")
                else:
                    time.sleep(self.config.retry_delay)
        return None

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        content = self.generate(
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            model, temperature, max_tokens,
            {"type": "json_schema", "json_schema": {"name": schema.get("title", "response"), "schema": schema}}
        )
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                pass
        return None


class GeminiProvider(BaseProvider):
    """Google Gemini provider."""

    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.default_model = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

    def _configure_genai(self):
        if genai is None:
            raise ImportError("google-generativeai package not installed")
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY not configured")
        genai.configure(api_key=self.api_key)

    def health_check(self) -> HealthCheckResult:
        start = time.time()
        try:
            if not self.api_key:
                return HealthCheckResult(ProviderType.GEMINI, False, 0, "GEMINI_API_KEY not configured")
            self._configure_genai()
            model = genai.GenerativeModel(self.default_model)
            model.generate_content("test", generation_config={"max_output_tokens": 5})
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GEMINI, True, latency)
        except Exception as e:
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.GEMINI, False, latency, str(e))

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        if not self.api_key:
            return None

        model_name = model or self.default_model
        self._configure_genai()
        gm = genai.GenerativeModel(model_name)

        prompt_parts = []
        for m in messages:
            role = "user" if m["role"] == "user" else "model"
            prompt_parts.append(f"{role}: {m['content']}")

        gen_config = {"temperature": temperature, "max_output_tokens": max_tokens}
        if response_format:
            gen_config["response_mime_type"] = "application/json"

        for attempt in range(self.config.max_retries + 1):
            try:
                resp = gm.generate_content(prompt_parts, generation_config=gen_config)
                if resp.text:
                    return resp.text
            except Exception as e:
                if attempt == self.config.max_retries:
                    logger.error(f"Gemini generation failed: {e}")
                else:
                    time.sleep(self.config.retry_delay)
        return None

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        self._configure_genai()
        model_name = model or self.default_model
        gm = genai.GenerativeModel(model_name)

        gen_config = {
            "temperature": temperature,
            "max_output_tokens": max_tokens,
            "response_mime_type": "application/json",
            "response_schema": schema
        }

        for attempt in range(self.config.max_retries + 1):
            try:
                resp = gm.generate_content([system_prompt, user_prompt], generation_config=gen_config)
                if resp.text:
                    return json.loads(resp.text)
            except Exception as e:
                if attempt == self.config.max_retries:
                    logger.error(f"Gemini structured generation failed: {e}")
                else:
                    time.sleep(self.config.retry_delay)
        return None


class OllamaProvider(BaseProvider):
    """Ollama local provider."""

    def __init__(self, config: ProviderConfig):
        super().__init__(config)
        self.base_url = os.getenv("OLLAMA_URL", "http://localhost:11434")
        self.default_model = os.getenv("OLLAMA_MODEL", "qwen2.5:7b-instruct")

    def _check_model_installed(self) -> bool:
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=5)
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                return any(self.default_model in m.get("name", "") for m in models)
        except Exception:
            pass
        return False

    def health_check(self) -> HealthCheckResult:
        start = time.time()
        try:
            if requests is None:
                return HealthCheckResult(ProviderType.OLLAMA, False, 0, "requests package not installed")
            resp = requests.get(f"{self.base_url}/api/tags", timeout=5)
            latency = (time.time() - start) * 1000
            if resp.status_code != 200:
                return HealthCheckResult(ProviderType.OLLAMA, False, latency, f"HTTP {resp.status_code}")
            models = resp.json().get("models", [])
            if not any(self.default_model in m.get("name", "") for m in models):
                return HealthCheckResult(ProviderType.OLLAMA, False, latency, f"Model {self.default_model} not installed")
            return HealthCheckResult(ProviderType.OLLAMA, True, latency)
        except Exception as e:
            latency = (time.time() - start) * 1000
            return HealthCheckResult(ProviderType.OLLAMA, False, latency, str(e))

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        model_name = model or self.default_model
        prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages)

        payload = {
            "model": model_name,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature, "num_predict": max_tokens}
        }
        if response_format and response_format.get("type") == "json_schema":
            payload["format"] = response_format["json_schema"]["schema"]

        for attempt in range(self.config.max_retries + 1):
            try:
                resp = requests.post(f"{self.base_url}/api/generate", json=payload, timeout=self.config.timeout)
                if resp.status_code == 200:
                    return resp.json().get("response", "").strip()
            except Exception as e:
                if attempt == self.config.max_retries:
                    logger.error(f"Ollama generation failed: {e}")
                else:
                    time.sleep(self.config.retry_delay)
        return None

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        content = self.generate(
            [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_prompt}],
            model, temperature, max_tokens,
            {"type": "json_schema", "json_schema": {"name": schema.get("title", "response"), "schema": schema}}
        )
        if content:
            try:
                return json.loads(content)
            except json.JSONDecodeError:
                pass
        return None


class LLMProviderManager:
    """
    Manages multiple LLM providers with automatic fallback.

    Usage:
        manager = LLMProviderManager()
        provider = manager.get_healthy_provider()
        result = provider.generate_structured(system, user, schema, model="...")
    """

    def __init__(self, priority: Optional[List[str]] = None):
        self.priority = priority or self._get_priority_from_env()
        self.providers: Dict[ProviderType, BaseProvider] = {}
        self._healthy_provider: Optional[BaseProvider] = None
        self._health_cache: Dict[ProviderType, HealthCheckResult] = {}
        self._cache_ttl = 60
        self._last_check = 0

        self._init_providers()

    def _get_priority_from_env(self) -> List[str]:
        priority_str = os.getenv("LLM_PROVIDER_PRIORITY", "groq,gemini,grok,ollama,sglang")
        return [p.strip().lower() for p in priority_str.split(",") if p.strip()]

    def _init_providers(self):
        configs = {
            ProviderType.SGLANG: ProviderConfig("sglang", True, 30, 2, 1.0),
            ProviderType.GROK: ProviderConfig("grok", True, 30, 2, 1.0),
            ProviderType.GROQ: ProviderConfig("groq", True, 30, 2, 1.0),
            ProviderType.GEMINI: ProviderConfig("gemini", True, 30, 2, 1.0),
            ProviderType.OLLAMA: ProviderConfig("ollama", True, 300, 1, 2.0),
        }

        for pname in self.priority:
            pname_lower = pname.lower()
            ptype = next((pt for pt in ProviderType if pt.value == pname_lower), None)
            if not ptype:
                continue

            try:
                if ptype == ProviderType.SGLANG:
                    self.providers[ptype] = SGLangProvider(configs[ptype])
                elif ptype == ProviderType.GROK:
                    self.providers[ptype] = GrokProvider(configs[ptype])
                elif ptype == ProviderType.GROQ:
                    self.providers[ptype] = GroqProvider(configs[ptype])
                elif ptype == ProviderType.GEMINI:
                    self.providers[ptype] = GeminiProvider(configs[ptype])
                elif ptype == ProviderType.OLLAMA:
                    self.providers[ptype] = OllamaProvider(configs[ptype])
                logger.info(f"[LLM] Initialized provider: {ptype.value}")
            except Exception as e:
                logger.warning(f"[LLM] Failed to initialize {ptype.value}: {e}")

    def check_all_health(self, force: bool = False) -> Dict[ProviderType, HealthCheckResult]:
        now = time.time()
        if not force and (now - self._last_check) < self._cache_ttl and self._health_cache:
            return self._health_cache

        logger.info("[LLM] Starting health checks...")
        results = {}

        for ptype in [ProviderType[p.upper()] for p in self.priority if p.upper() in [pt.name for pt in ProviderType]]:
            if ptype not in self.providers:
                continue
            provider = self.providers[ptype]
            logger.info(f"[LLM] Trying {ptype.value}...")
            result = provider.health_check()
            results[ptype] = result
            self._health_cache[ptype] = result

            if result.healthy:
                logger.info(f"[LLM] ✅ {ptype.value} connected ({result.latency_ms:.0f}ms)")
            else:
                logger.warning(f"[LLM] ❌ {ptype.value} unavailable: {result.error}")

        self._last_check = now
        return results

    def get_healthy_provider(self, force_refresh: bool = False) -> Optional[BaseProvider]:
        if self._healthy_provider and not force_refresh:
            return self._healthy_provider

        results = self.check_all_health(force_refresh)
        for ptype in [ProviderType[p.upper()] for p in self.priority if p.upper() in [pt.name for pt in ProviderType]]:
            if ptype in results and results[ptype].healthy:
                self._healthy_provider = self.providers.get(ptype)
                if self._healthy_provider:
                    logger.info(f"[LLM] Using {ptype.value} for remaining pipeline.")
                    return self._healthy_provider

        self._log_all_failures(results)
        return None

    def _log_all_failures(self, results: Dict[ProviderType, HealthCheckResult]):
        logger.error("[LLM] No LLM provider is available.")
        logger.error("[LLM] Checked:")
        for ptype in [ProviderType[p.upper()] for p in self.priority if p.upper() in [pt.name for pt in ProviderType]]:
            status = "✅" if results.get(ptype, HealthCheckResult(ptype, False, 0)).healthy else "❌"
            err = results.get(ptype)
            err_msg = f" ({err.error})" if err and err.error else ""
            logger.error(f"[LLM]   {status} {ptype.value}{err_msg}")
        logger.error("[LLM] Please configure at least one provider.")

    def generate(
        self,
        messages: List[Dict[str, str]],
        model: Optional[str] = None,
        temperature: float = 0.3,
        max_tokens: int = 4000,
        response_format: Optional[Dict] = None,
        **kwargs
    ) -> Optional[str]:
        provider = self.get_healthy_provider()
        if not provider:
            raise RuntimeError("No LLM provider available")
        return provider.generate(messages, model, temperature, max_tokens, response_format, **kwargs)

    def generate_structured(
        self,
        system_prompt: str,
        user_prompt: str,
        schema: Dict,
        model: Optional[str] = None,
        temperature: float = 0.1,
        max_tokens: int = 4000
    ) -> Optional[Dict]:
        provider = self.get_healthy_provider()
        if not provider:
            raise RuntimeError("No LLM provider available")
        return provider.generate_structured(system_prompt, user_prompt, schema, model, temperature, max_tokens)

    def get_provider_status(self) -> Dict[str, Any]:
        results = self.check_all_health()
        return {
            "priority": self.priority,
            "providers": {
                ptype.value: {
                    "healthy": result.healthy,
                    "latency_ms": result.latency_ms,
                    "error": result.error
                }
                for ptype, result in results.items()
            },
            "selected": self._healthy_provider.config.name if self._healthy_provider else None
        }


_manager_instance: Optional[LLMProviderManager] = None


def get_llm_manager() -> LLMProviderManager:
    """Get singleton LLM Provider Manager instance."""
    global _manager_instance
    if _manager_instance is None:
        _manager_instance = LLMProviderManager()
    return _manager_instance


def reset_llm_manager():
    """Reset the singleton (useful for testing)."""
    global _manager_instance
    _manager_instance = None