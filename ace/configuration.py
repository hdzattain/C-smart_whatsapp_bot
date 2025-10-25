"""Configuration helpers for the ACE service."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from .model_providers import ModelConfig
from .ace_module import ACEConfig


def _expand_env(value: Any) -> Any:
    """Recursively expand environment variables within a structure."""

    if isinstance(value, str):
        return os.path.expandvars(value)
    if isinstance(value, dict):
        return {key: _expand_env(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_expand_env(item) for item in value)
    return value


@dataclass
class RoleSettings:
    provider: str
    model: str
    options: Dict[str, Any] = field(default_factory=dict)
    prompt_path: Optional[str] = None

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "RoleSettings":
        data = dict(payload)
        return cls(
            provider=data.pop("provider"),
            model=data.pop("model"),
            options=data.pop("options", {}),
            prompt_path=data.pop("prompt_path", None),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "provider": self.provider,
            "model": self.model,
            "options": self.options,
            "prompt_path": self.prompt_path,
        }

    def to_model_config(self, messages: Optional[Iterable[Tuple[str, str]]] = None) -> ModelConfig:
        return ModelConfig(
            provider=self.provider,
            model=self.model,
            options=_expand_env(self.options),
            messages=list(messages) if messages else None,
        )


@dataclass
class ServiceSettings:
    generator: RoleSettings
    scorer: RoleSettings
    reflector: RoleSettings
    playbook_path: str = "ace_playbook.json"
    min_score: float = 0.7
    max_reflection_steps: int = 2
    config_path: Optional[Path] = None

    @classmethod
    def from_dict(
        cls, payload: Dict[str, Any], *, config_path: Optional[str | Path] = None
    ) -> "ServiceSettings":
        data = dict(payload)
        generator = RoleSettings.from_dict(data.pop("generator"))
        scorer = RoleSettings.from_dict(data.pop("scorer"))
        reflector = RoleSettings.from_dict(data.pop("reflector"))
        return cls(
            generator=generator,
            scorer=scorer,
            reflector=reflector,
            playbook_path=data.pop("playbook_path", "ace_playbook.json"),
            min_score=float(data.pop("min_score", 0.7)),
            max_reflection_steps=int(data.pop("max_reflection_steps", 2)),
            config_path=Path(config_path) if config_path else None,
        )

    @classmethod
    def from_file(cls, path: str | Path) -> "ServiceSettings":
        with Path(path).open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return cls.from_dict(payload, config_path=path)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "generator": self.generator.to_dict(),
            "scorer": self.scorer.to_dict(),
            "reflector": self.reflector.to_dict(),
            "playbook_path": self.playbook_path,
            "min_score": self.min_score,
            "max_reflection_steps": self.max_reflection_steps,
        }

    def save(self, path: Optional[str | Path] = None) -> None:
        target = Path(path or self.config_path or "ace_service_config.json")
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            json.dump(self.to_dict(), handle, ensure_ascii=False, indent=2)
        self.config_path = target

    def ace_config(self) -> ACEConfig:
        return ACEConfig(min_score=self.min_score, max_reflection_steps=self.max_reflection_steps)


class SettingsStore:
    """Thread-safe store for mutable service settings."""

    def __init__(self, settings: ServiceSettings) -> None:
        self._settings = settings
        self._lock = RLock()

    @property
    def settings(self) -> ServiceSettings:
        with self._lock:
            return ServiceSettings.from_dict(
                self._settings.to_dict(), config_path=self._settings.config_path
            )

    def update(self, payload: Dict[str, Any], *, persist: bool = True) -> ServiceSettings:
        with self._lock:
            merged = self._settings.to_dict()
            for key, value in payload.items():
                if key in ROLE_NAMES and isinstance(value, dict):
                    current_role = getattr(self._settings, key).to_dict()
                    updated_role = dict(current_role)
                    for role_key, role_value in value.items():
                        if role_key == "options" and isinstance(role_value, dict):
                            merged_options = dict(current_role.get("options", {}))
                            merged_options.update(role_value)
                            updated_role["options"] = merged_options
                        else:
                            updated_role[role_key] = role_value
                    merged[key] = updated_role
                else:
                    merged[key] = value
            self._settings = ServiceSettings.from_dict(
                merged, config_path=self._settings.config_path
            )
            if persist:
                self._settings.save()
            return self._settings


def _normalise_messages(messages: Sequence[Dict[str, Any]]) -> List[Tuple[str, str]]:
    output: List[Tuple[str, str]] = []
    for item in messages:
        role = item.get("role")
        content = item.get("content")
        if role is None or content is None:
            raise ValueError("Each message must include 'role' and 'content' fields")
        output.append((str(role), str(content)))
    return output


def load_prompt_messages(path: str | Path) -> List[Tuple[str, str]]:
    """Load chat prompt messages from a JSON/YAML file."""

    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {file_path}")

    suffix = file_path.suffix.lower()
    with file_path.open("r", encoding="utf-8") as handle:
        if suffix in {".yaml", ".yml"}:
            try:
                import yaml  # type: ignore
            except ImportError as exc:  # pragma: no cover - optional dependency
                raise ImportError(
                    "PyYAML is required to load YAML prompt files. Install `pyyaml`."
                ) from exc
            payload = yaml.safe_load(handle)
        else:
            payload = json.load(handle)

    if isinstance(payload, dict):
        if "messages" in payload:
            return _normalise_messages(payload["messages"])
        raise ValueError("Prompt file dict must include a 'messages' key")
    if isinstance(payload, list):
        return _normalise_messages(payload)
    raise ValueError("Prompt file must be a list or dict containing messages")


ROLE_NAMES = ("generator", "scorer", "reflector")


__all__ = [
    "RoleSettings",
    "ServiceSettings",
    "SettingsStore",
    "load_prompt_messages",
    "ROLE_NAMES",
]
