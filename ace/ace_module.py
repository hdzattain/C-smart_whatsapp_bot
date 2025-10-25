"""Implementation of an ACE (Align, Critique, Evolve) engine built on LangChain."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterable, Optional, Protocol, Union

from .playbook import Playbook, PlaybookEntry
from .model_providers import (
    ModelConfig,
    create_generator_chain,
    create_reflector_chain,
    create_scorer_chain,
)

try:  # pragma: no cover - import compatibility
    from langchain_core.messages import BaseMessage
except ImportError:  # pragma: no cover - fallback for older langchain versions
    class BaseMessage:  # type: ignore
        """Fallback stub when LangChain is not installed."""

        def __init__(self, content: str):
            self.content = content


try:  # pragma: no cover
    from langchain_core.runnables import Runnable
except ImportError:  # pragma: no cover - fallback for older langchain versions
    class Runnable(Protocol):  # type: ignore[misc]
        def invoke(self, input: Any, config: Optional[Dict[str, Any]] = None) -> Any:
            ...


RunnableLike = Union[Runnable, Callable[[Any], Any]]


def _invoke(runnable: RunnableLike, payload: Dict[str, Any]) -> Any:
    if hasattr(runnable, "invoke"):
        return runnable.invoke(payload)
    return runnable(payload)


def _ensure_text(result: Any) -> str:
    if result is None:
        return ""
    if isinstance(result, BaseMessage):
        return str(result.content)
    if isinstance(result, list):
        return "\n".join(_ensure_text(item) for item in result)
    if isinstance(result, dict):
        for key in ("text", "output", "content", "answer", "response"):
            if key in result:
                return str(result[key])
    return str(result)


def _ensure_list(value: Any) -> Iterable[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item) for item in value]
    return [str(value)]


def _normalise_score(raw: Any) -> float:
    if raw is None:
        return 0.0
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, dict):
        for key in ("score", "value", "probability", "confidence"):
            if key in raw:
                return float(raw[key])
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return 0.0


@dataclass
class ACEConfig:
    min_score: float = 0.7
    max_reflection_steps: int = 2


class ACEEngine:
    """Coordinates generator, scoring, and reflection models via LangChain."""

    def __init__(
        self,
        generator: RunnableLike,
        scorer: RunnableLike,
        reflector: RunnableLike,
        playbook: Optional[Playbook] = None,
        *,
        config: Optional[ACEConfig] = None,
    ) -> None:
        self.generator = generator
        self.scorer = scorer
        self.reflector = reflector
        self.playbook = playbook or Playbook()
        self.config = config or ACEConfig()

    @classmethod
    def from_model_configs(
        cls,
        generator: ModelConfig,
        scorer: ModelConfig,
        reflector: ModelConfig,
        *,
        playbook: Optional[Playbook] = None,
        config: Optional[ACEConfig] = None,
    ) -> "ACEEngine":
        """Instantiate the engine directly from :class:`ModelConfig` objects."""

        generator_chain = create_generator_chain(generator)
        scorer_chain = create_scorer_chain(scorer)
        reflector_chain = create_reflector_chain(reflector)
        return cls(
            generator_chain,
            scorer_chain,
            reflector_chain,
            playbook=playbook,
            config=config,
        )

    # ------------------------------------------------------------------
    # Core workflow
    # ------------------------------------------------------------------
    def process_interaction(
        self,
        user_input: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
        min_score: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Run the ACE loop for a single user input and persist the outcome."""

        threshold = min_score if min_score is not None else self.config.min_score
        context = self.playbook.recent_summary()
        reflections = []
        response_text = _ensure_text(
            _invoke(
                self.generator,
                {
                    "input": user_input,
                    "playbook": context,
                },
            )
        )
        score = self._score(user_input, response_text, context)

        step = 0
        while score < threshold and step < self.config.max_reflection_steps:
            reflection = _ensure_text(
                _invoke(
                    self.reflector,
                    {
                        "input": user_input,
                        "response": response_text,
                        "score": score,
                        "playbook": context,
                    },
                )
            )
            if reflection:
                reflections.extend(_ensure_list(reflection))
            response_text = _ensure_text(
                _invoke(
                    self.generator,
                    {
                        "input": user_input,
                        "playbook": context,
                        "reflection": "\n".join(reflections),
                    },
                )
            )
            score = self._score(user_input, response_text, context)
            step += 1

        status = "accepted" if score >= threshold else "pending"
        entry = self.playbook.append_entry(
            user_input,
            response_text,
            score,
            reflections=reflections,
            status=status,
            metadata=metadata,
        )

        return {
            "response": response_text,
            "score": score,
            "reflections": reflections,
            "status": status,
            "entry_id": entry.id,
        }

    def _score(self, user_input: str, response: str, context: str) -> float:
        raw_score = _invoke(
            self.scorer,
            {
                "input": user_input,
                "response": response,
                "playbook": context,
            },
        )
        return max(0.0, min(1.0, _normalise_score(raw_score)))

    # ------------------------------------------------------------------
    # Feedback utilities
    # ------------------------------------------------------------------
    def record_feedback(
        self,
        entry_id: str,
        *,
        score: Optional[float] = None,
        reflections: Optional[Iterable[str]] = None,
        note: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Optional[PlaybookEntry]:
        """Update the stored playbook entry based on human feedback."""

        payload: Dict[str, Any] = {}
        if score is not None:
            payload["score"] = score
        if reflections is not None:
            payload["reflections"] = reflections
        if note is not None:
            payload["note"] = note
        if status is not None:
            payload["status"] = status
        return self.playbook.update_entry(entry_id, **payload)

    def force_correction(self, entry_id: str, corrected_response: str, note: Optional[str] = None) -> PlaybookEntry:
        """Manually override a response to keep the playbook aligned."""

        entry = self.playbook.force_path(entry_id, corrected_response, note)
        if not entry:
            raise ValueError(f"No playbook entry found for id={entry_id}")
        return entry

    def export_pairs(self, *, statuses: Optional[Iterable[str]] = None) -> Iterable[Dict[str, str]]:
        """Return dataset pairs for downstream lightweight fine-tuning."""

        return self.playbook.to_pairs(statuses)

