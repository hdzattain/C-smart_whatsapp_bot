"""Utility helpers for building ACE-compatible LangChain runnables.

This module exposes a lightweight factory that can spin up generator, scorer,
and reflector chains on top of popular model providers.  The resulting chains
all consume the structured payload emitted by :class:`ace.ace_module.ACEEngine`
(`input`, `playbook`, `reflection`, etc.) so that users can quickly switch
between different back-ends without having to handcraft new LangChain graphs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from importlib import import_module
from typing import Any, Dict, Iterable, Sequence, Tuple

try:  # pragma: no cover - optional dependency imports
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.prompts import ChatPromptTemplate
except ImportError as exc:  # pragma: no cover - provide clearer guidance
    raise ImportError(
        "LangChain core components are required. Install `langchain-core` or `langchain`"
    ) from exc


MessageSpec = Sequence[Tuple[str, str]]


@dataclass
class ModelConfig:
    """Configuration used to instantiate a LangChain chat model.

    Parameters
    ----------
    provider:
        Identifier of the model provider.  Built-in shortcuts: ``"deepseek"`` /
        ``"deepseek-chat"``, ``"ollama"`` for local deployments, and
        ``"huggingface"`` / ``"huggingface-api"`` for HuggingFace Inference
        Endpoints.
    model:
        Model name passed straight to the provider implementation.
    options:
        Additional keyword arguments forwarded to the underlying LangChain
        constructor (e.g. temperature, base_url, request_timeout).
    messages:
        Optional set of prompt messages.  When omitted a sensible default prompt
        is supplied depending on whether the chain is a generator, scorer, or
        reflector.
    """

    provider: str
    model: str
    options: Dict[str, Any] = field(default_factory=dict)
    messages: Sequence[Tuple[str, str]] | None = None


def _import_class(path: str, name: str) -> Any:
    module = import_module(path)
    try:
        return getattr(module, name)
    except AttributeError as exc:  # pragma: no cover - defensive guard
        raise ImportError(f"Class {name} not found in module {path}") from exc


def _load_chat_model(config: ModelConfig):
    provider = config.provider.lower()
    if provider in {"deepseek", "deepseek-chat"}:
        cls = _import_class("langchain_community.chat_models.deepseek", "ChatDeepSeek")
    elif provider == "ollama":
        cls = _import_class("langchain_community.chat_models.ollama", "ChatOllama")
    elif provider in {"huggingface", "huggingface-api", "huggingface_hub"}:
        cls = _import_class("langchain_community.chat_models.huggingface", "ChatHuggingFace")
    else:  # pragma: no cover - uncovered provider branch
        raise ValueError(
            "Unsupported provider. Choose from 'deepseek', 'ollama', or 'huggingface'."
        )
    return cls(model=config.model, **config.options)


DEFAULT_MESSAGES: Dict[str, MessageSpec] = {
    "generator": [
        (
            "system",
            "你是一名可靠的行业专家，会参考历史 playbook 内容和反思来改进回答。",
        ),
        (
            "human",
            "{input}\n\n历史经验：{playbook}\n\n反思：{reflection}",
        ),
    ],
    "scorer": [
        (
            "system",
            "请根据准确性、完整性和语气为候选回复打分，仅输出 0 到 1 之间的小数。",
        ),
        (
            "human",
            "用户问题：{input}\n候选回复：{response}\n历史经验：{playbook}",
        ),
    ],
    "reflector": [
        (
            "system",
            "请指出回复可以改进的方向，使用简洁的要点描述。",
        ),
        (
            "human",
            "用户问题：{input}\n候选回复：{response}\n得分：{score}\n历史经验：{playbook}",
        ),
    ],
}


def _build_chain(role: str, config: ModelConfig):
    llm = _load_chat_model(config)
    messages: Iterable[Tuple[str, str]] = config.messages or DEFAULT_MESSAGES[role]
    prompt = ChatPromptTemplate.from_messages(list(messages))
    return prompt | llm | StrOutputParser()


def create_generator_chain(config: ModelConfig):
    """Return a runnable that generates answers using the requested provider."""

    return _build_chain("generator", config)


def create_scorer_chain(config: ModelConfig):
    """Return a runnable that emits scores in ``[0, 1]`` for the ACE engine."""

    return _build_chain("scorer", config)


def create_reflector_chain(config: ModelConfig):
    """Return a runnable that produces reflection hints for the ACE loop."""

    return _build_chain("reflector", config)


__all__ = [
    "ModelConfig",
    "create_generator_chain",
    "create_scorer_chain",
    "create_reflector_chain",
]
