"""Dynamic playbook storage used by the ACE engine.

The playbook acts as a continuously evolving dataset that keeps track of user
inputs, generated responses, scores, and reflections.  It is designed to mimic
"fine-tuning" in a no-GPU environment by incrementally learning from new
examples and curations performed by human operators.
"""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


def _utcnow_str() -> str:
    return datetime.utcnow().strftime(ISO_FORMAT)


@dataclass
class PlaybookEntry:
    """Single interaction stored inside the playbook."""

    id: str
    user_input: str
    response: str
    score: float
    reflections: List[str] = field(default_factory=list)
    status: str = "pending"
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_utcnow_str)
    updated_at: str = field(default_factory=_utcnow_str)
    dataset_pair: Dict[str, str] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.dataset_pair:
            self.dataset_pair = {"input": self.user_input, "output": self.response}

    def touch(self) -> None:
        self.updated_at = _utcnow_str()

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "PlaybookEntry":
        return cls(**payload)


class Playbook:
    """Container that stores and manages :class:`PlaybookEntry` objects."""

    def __init__(self, storage_path: str = "ace_playbook.json", autosave: bool = True):
        self.storage_path = Path(storage_path)
        self.autosave = autosave
        self._lock = threading.Lock()
        self._entries: List[PlaybookEntry] = []
        self._load()

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------
    def _load(self) -> None:
        if not self.storage_path.exists():
            return
        with self.storage_path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        self._entries = [PlaybookEntry.from_dict(item) for item in payload]

    def _save(self) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        with self.storage_path.open("w", encoding="utf-8") as fh:
            json.dump([entry.to_dict() for entry in self._entries], fh, ensure_ascii=False, indent=2)

    def save(self) -> None:
        with self._lock:
            self._save()

    # ------------------------------------------------------------------
    # CRUD operations
    # ------------------------------------------------------------------
    def append_entry(
        self,
        user_input: str,
        response: str,
        score: float,
        *,
        reflections: Optional[Iterable[str]] = None,
        status: str = "accepted",
        metadata: Optional[Dict[str, Any]] = None,
        notes: Optional[Iterable[str]] = None,
    ) -> PlaybookEntry:
        """Create a new entry and persist it to disk."""

        entry = PlaybookEntry(
            id=str(uuid.uuid4()),
            user_input=user_input,
            response=response,
            score=float(score),
            reflections=list(reflections or []),
            status=status,
            metadata=dict(metadata or {}),
            notes=list(notes or []),
        )
        with self._lock:
            self._entries.append(entry)
            if self.autosave:
                self._save()
        return entry

    def get_entry(self, entry_id: str) -> Optional[PlaybookEntry]:
        with self._lock:
            for entry in self._entries:
                if entry.id == entry_id:
                    return entry
        return None

    def update_entry(
        self,
        entry_id: str,
        *,
        response: Optional[str] = None,
        score: Optional[float] = None,
        reflections: Optional[Iterable[str]] = None,
        status: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        note: Optional[str] = None,
    ) -> Optional[PlaybookEntry]:
        """Update an existing entry. Returns the updated entry or ``None``."""

        with self._lock:
            target = self.get_entry(entry_id)
            if not target:
                return None
            if response is not None:
                target.response = response
                target.dataset_pair["output"] = response
            if score is not None:
                target.score = float(score)
            if reflections is not None:
                target.reflections = list(reflections)
            if status is not None:
                target.status = status
            if metadata is not None:
                target.metadata.update(metadata)
            if note:
                target.notes.append(note)
            target.touch()
            if self.autosave:
                self._save()
            return target

    def mark_failed(self, entry_id: str, reason: str) -> Optional[PlaybookEntry]:
        return self.update_entry(entry_id, status="failed", note=reason)

    def force_path(self, entry_id: str, corrected_response: str, note: Optional[str] = None) -> Optional[PlaybookEntry]:
        """Forcefully override the response to keep the playbook on track."""

        return self.update_entry(entry_id, response=corrected_response, status="corrected", note=note)

    # ------------------------------------------------------------------
    # Analytics & exporting
    # ------------------------------------------------------------------
    def to_pairs(self, status_filter: Optional[Iterable[str]] = None) -> List[Dict[str, str]]:
        """Return dataset pairs suitable for lightweight fine-tuning workflows."""

        statuses = set(status_filter or ["accepted", "corrected"])
        with self._lock:
            return [entry.dataset_pair for entry in self._entries if entry.status in statuses]

    def recent_summary(self, limit: int = 5) -> str:
        """Summarise recent playbook decisions for prompt conditioning."""

        with self._lock:
            items = self._entries[-limit:]
        if not items:
            return ""
        chunks = []
        for entry in items:
            summary = (
                f"User: {entry.user_input}\n"
                f"Response: {entry.response}\n"
                f"Score: {entry.score:.2f}\n"
                f"Status: {entry.status}\n"
            )
            if entry.reflections:
                summary += "Reflections: " + " | ".join(entry.reflections)
            chunks.append(summary)
        return "\n---\n".join(chunks)

    def __len__(self) -> int:  # pragma: no cover - simple passthrough
        with self._lock:
            return len(self._entries)

    def __iter__(self):  # pragma: no cover - simple passthrough
        with self._lock:
            return iter(list(self._entries))

