"""Flask-based service wrapper that exposes the ACE engine over HTTP."""

from __future__ import annotations

from pathlib import Path
from threading import RLock
from typing import Dict, Optional

from flask import Blueprint, Flask, jsonify, request

from .ace_module import ACEEngine
from .configuration import (
    ROLE_NAMES,
    RoleSettings,
    ServiceSettings,
    SettingsStore,
    load_prompt_messages,
)
from .playbook import Playbook

PROMPT_KEYS = {
    "generator": ("generator_prompt",),
    "scorer": ("scorer_prompt", "curator_prompt"),
    "reflector": ("reflector_prompt",),
}


class ACEServiceState:
    """Container that keeps service settings and cached playbooks."""

    def __init__(self, settings: ServiceSettings) -> None:
        self._store = SettingsStore(settings)
        self._playbooks: Dict[str, Playbook] = {}
        self._lock = RLock()

    @property
    def settings(self) -> ServiceSettings:
        return self._store.settings

    def current_config(self) -> Dict[str, object]:
        return self.settings.to_dict()

    def update_settings(self, payload: Dict[str, object], *, persist: bool = True) -> Dict[str, object]:
        settings = self._store.update(payload, persist=persist)
        if "playbook_path" in payload:
            self._ensure_playbook(settings.playbook_path)
        return settings.to_dict()

    def reload_from_file(self) -> Dict[str, object]:
        current = self.settings
        if not current.config_path:
            raise RuntimeError("Cannot reload configuration because no config_path is set")
        settings = ServiceSettings.from_file(current.config_path)
        self._store = SettingsStore(settings)
        self._ensure_playbook(settings.playbook_path)
        return settings.to_dict()

    def _ensure_playbook(self, path: str) -> Playbook:
        with self._lock:
            playbook = self._playbooks.get(path)
            if playbook is None:
                playbook = Playbook(path)
                self._playbooks[path] = playbook
            return playbook

    def run_interaction(
        self,
        *,
        user_input: str,
        prompt_paths: Dict[str, Optional[str]],
        playbook_path: Optional[str] = None,
        metadata: Optional[Dict[str, object]] = None,
        min_score: Optional[float] = None,
    ) -> Dict[str, object]:
        settings = self.settings
        generator_cfg = self._build_model_config(settings.generator, prompt_paths.get("generator"))
        scorer_cfg = self._build_model_config(settings.scorer, prompt_paths.get("scorer"))
        reflector_cfg = self._build_model_config(settings.reflector, prompt_paths.get("reflector"))
        playbook_target = playbook_path or settings.playbook_path
        playbook = self._ensure_playbook(playbook_target)
        engine = ACEEngine.from_model_configs(
            generator_cfg,
            scorer_cfg,
            reflector_cfg,
            playbook=playbook,
            config=settings.ace_config(),
        )
        result = engine.process_interaction(
            user_input,
            metadata=metadata,
            min_score=min_score,
        )
        result["playbook_path"] = playbook_target
        return result

    def _build_model_config(self, role_settings: RoleSettings, override_path: Optional[str]):
        prompt_path = override_path
        if not prompt_path:
            prompt_path = role_settings.prompt_path
        messages = load_prompt_messages(prompt_path) if prompt_path else None
        return role_settings.to_model_config(messages=messages)


def create_blueprint(state: ACEServiceState) -> Blueprint:
    blueprint = Blueprint("ace", __name__, url_prefix="/ACE")

    @blueprint.route("/health", methods=["GET"])
    def health() -> object:
        return {"status": "ok"}

    @blueprint.route("/config", methods=["GET"])
    def get_config() -> object:
        return state.current_config()

    @blueprint.route("/config", methods=["PUT"])
    def update_config() -> object:
        payload = request.get_json(force=True, silent=True) or {}
        persist_value = payload.pop("persist", True)
        if isinstance(persist_value, str):
            persist = persist_value.lower() not in {"false", "0", "no"}
        else:
            persist = bool(persist_value)
        try:
            updated = state.update_settings(payload, persist=persist)
            return updated
        except Exception as exc:  # pragma: no cover - defensive response
            response = jsonify({"error": str(exc)})
            response.status_code = 400
            return response

    @blueprint.route("/config/reload", methods=["POST"])
    def reload_config() -> object:
        try:
            updated = state.reload_from_file()
            return updated
        except Exception as exc:  # pragma: no cover - defensive response
            response = jsonify({"error": str(exc)})
            response.status_code = 400
            return response

    @blueprint.route("/chat", methods=["POST"])
    def chat() -> object:
        payload = request.get_json(force=True, silent=True) or {}
        user_input = payload.get("user_input")
        if not isinstance(user_input, str) or not user_input.strip():
            response = jsonify({"error": "`user_input` must be a non-empty string"})
            response.status_code = 400
            return response

        prompt_paths: Dict[str, Optional[str]] = {}
        for role in ROLE_NAMES:
            for key in PROMPT_KEYS.get(role, (f"{role}_prompt",)):
                if key in payload and payload[key] is not None:
                    prompt_paths[role] = str(payload[key])

        playbook_path = payload.get("playbook")
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None
        min_score = payload.get("min_score")
        if min_score is not None:
            try:
                min_score = float(min_score)
            except (TypeError, ValueError):
                response = jsonify({"error": "`min_score` must be numeric"})
                response.status_code = 400
                return response

        try:
            result = state.run_interaction(
                user_input=user_input,
                prompt_paths=prompt_paths,
                playbook_path=playbook_path,
                metadata=metadata,
                min_score=min_score,
            )
            return result
        except FileNotFoundError as exc:
            response = jsonify({"error": str(exc)})
            response.status_code = 404
            return response
        except Exception as exc:  # pragma: no cover - defensive guard
            response = jsonify({"error": str(exc)})
            response.status_code = 500
            return response

    return blueprint


def create_app(settings: ServiceSettings | str | Path | None = None) -> Flask:
    """Create a configured Flask app exposing the ACE HTTP API."""

    if isinstance(settings, (str, Path)):
        settings = ServiceSettings.from_file(settings)
    elif settings is None:
        # Minimal sensible defaults using placeholder providers
        settings = ServiceSettings.from_dict(
            {
                "generator": {"provider": "deepseek", "model": "deepseek-chat"},
                "scorer": {"provider": "deepseek", "model": "deepseek-chat"},
                "reflector": {"provider": "deepseek", "model": "deepseek-chat"},
            }
        )
    state = ACEServiceState(settings)
    state._ensure_playbook(settings.playbook_path)

    app = Flask(__name__)
    app.register_blueprint(create_blueprint(state))
    app.config["ACE_STATE"] = state
    return app


__all__ = [
    "ACEServiceState",
    "create_app",
    "create_blueprint",
]
