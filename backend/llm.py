"""Selectable answer models.

Routing, tool calls and citation verification stay on the default DeepSeek
model. The selected model is only used for the final answer generation, so a
local model without reliable JSON/tool-calling support can still be used.
"""
import os
import time
from dataclasses import dataclass

import httpx
from openai import OpenAI


DEFAULT_DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
CACHE_SECONDS = 30
_cached_specs = None
_cached_at = 0.0


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    provider: str
    model: str
    base_url: str
    api_key: str
    extra_body: dict | None = None
    configured: bool = True

    def public(self):
        return {
            "id": self.id,
            "label": self.label,
            "provider": self.provider,
            "model": self.model,
            "local": self.provider == "ollama",
            "configured": self.configured,
        }


def _deepseek_spec():
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        return None
    model = DEFAULT_DEEPSEEK_MODEL
    return ModelSpec(
        id="deepseek-flash",
        label=f"DeepSeek · {model}",
        provider="deepseek",
        model=model,
        base_url=os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/"),
        api_key=api_key,
        extra_body={"thinking": {"type": "disabled"}},
    )


def _ollama_specs():
    root = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
    names = []
    try:
        response = httpx.get(f"{root}/api/tags", timeout=1.5)
        if response.is_success:
            names = [
                item.get("name") or item.get("model")
                for item in response.json().get("models", [])
                if item.get("name") or item.get("model")
            ]
    except Exception:
        names = []
    env_model = os.getenv("OLLAMA_MODEL", "").strip()
    if env_model and env_model not in names:
        names.append(env_model)
    return [
        ModelSpec(
            id=f"ollama:{name}",
            label=f"本地 · {name}",
            provider="ollama",
            model=name,
            base_url=f"{root}/v1",
            api_key="ollama",
        )
        for name in names
    ]


def _qwen_specs():
    api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    if not api_key:
        return []
    model = os.getenv("QWEN_MODEL", "qwen-plus").strip() or "qwen-plus"
    return [ModelSpec(
        id=f"qwen:{model}",
        label=f"通义千问 · {model}",
        provider="qwen",
        model=model,
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key=api_key,
    )]


def _openai_specs():
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    model = os.getenv("OPENAI_MODEL", "").strip()
    if not api_key or not model:
        return []
    return [ModelSpec(
        id=f"openai:{model}",
        label=f"OpenAI · {model}",
        provider="openai",
        model=model,
        base_url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
        api_key=api_key,
    )]


def _moonshot_specs():
    api_key = os.getenv("MOONSHOT_API_KEY", "").strip()
    model = os.getenv("MOONSHOT_MODEL", "").strip()
    if not api_key or not model:
        return []
    return [ModelSpec(
        id=f"moonshot:{model}",
        label=f"Kimi · {model}",
        provider="moonshot",
        model=model,
        base_url="https://api.moonshot.cn/v1",
        api_key=api_key,
    )]


def _custom_specs():
    base_url = os.getenv("CUSTOM_LLM_BASE_URL", "").strip()
    model = os.getenv("CUSTOM_LLM_MODEL", "").strip()
    if not base_url or not model:
        return []
    return [ModelSpec(
        id=f"custom:{model}",
        label=os.getenv("CUSTOM_LLM_LABEL", f"自定义 · {model}"),
        provider="custom",
        model=model,
        base_url=base_url.rstrip("/"),
        api_key=os.getenv("CUSTOM_LLM_API_KEY", "custom"),
    )]


def all_specs():
    global _cached_specs, _cached_at
    now = time.monotonic()
    if _cached_specs is not None and now - _cached_at < CACHE_SECONDS:
        return _cached_specs
    specs = [spec for spec in [_deepseek_spec()] if spec]
    specs.extend(_qwen_specs())
    specs.extend(_moonshot_specs())
    specs.extend(_openai_specs())
    specs.extend(_custom_specs())
    specs.extend(_ollama_specs())
    _cached_specs, _cached_at = specs, now
    return specs


def _placeholders(specs):
    providers = {spec.provider for spec in specs}
    candidates = [
        ("qwen", "qwen:qwen-plus", "通义千问 Plus", "qwen-plus", "DASHSCOPE_API_KEY"),
        ("moonshot", "moonshot:kimi", "Kimi（Moonshot）", "moonshot-v1-8k", "MOONSHOT_API_KEY"),
        ("openai", "openai:gpt", "OpenAI GPT", "gpt-4o-mini", "OPENAI_API_KEY"),
        ("ollama", "ollama:local", "本地 Ollama", os.getenv("OLLAMA_MODEL", "qwen2.5:7b"), "启动 Ollama"),
    ]
    return [
        ModelSpec(
            id=model_id, label=label, provider=provider, model=model,
            base_url="", api_key="", configured=False,
        )
        for provider, model_id, label, model, _hint in candidates
        if provider not in providers
    ]


def available_models():
    specs = all_specs()
    return [spec.public() for spec in specs] + [spec.public() for spec in _placeholders(specs)]


def resolve_model(model_id=None):
    if model_id and model_id.startswith("ollama:"):
        name = model_id.split(":", 1)[1].strip()
        if name:
            root = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
            return ModelSpec(
                id=model_id, label=f"本地 · {name}", provider="ollama",
                model=name, base_url=f"{root}/v1", api_key="ollama",
            )
    specs = all_specs()
    if model_id:
        for spec in specs:
            if spec.id == model_id:
                return spec
    deepseek = _deepseek_spec()
    if deepseek:
        return deepseek
    if specs:
        return specs[0]
    return None


def client_for(spec):
    if spec is None:
        raise RuntimeError("模型未配置。请设置 DEEPSEEK_API_KEY 或本地 Ollama。")
    return OpenAI(api_key=spec.api_key, base_url=spec.base_url, timeout=60.0, max_retries=0)
