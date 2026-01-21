"""LangChain ACE module for iterative agent improvement.

This package bundles a high-level orchestration engine that wires together
multiple LangChain runnables—typically an LLM generator, a scoring model, and a
reflection model—into a self-improving workflow. It also exposes a lightweight
"playbook" store used to accumulate interaction data for subsequent refinement
or manual curation.
"""

from .ace_module import ACEEngine
from .model_providers import (
    ModelConfig,
    create_generator_chain,
    create_reflector_chain,
    create_scorer_chain,
)
from .playbook import Playbook, PlaybookEntry
from .configuration import (
    RoleSettings,
    ServiceSettings,
    SettingsStore,
    load_prompt_messages,
)
from .service import ACEServiceState, create_app, create_blueprint

__all__ = [
    "ACEEngine",
    "Playbook",
    "PlaybookEntry",
    "ModelConfig",
    "create_generator_chain",
    "create_scorer_chain",
    "create_reflector_chain",
    "RoleSettings",
    "ServiceSettings",
    "SettingsStore",
    "load_prompt_messages",
    "ACEServiceState",
    "create_app",
    "create_blueprint",
]
