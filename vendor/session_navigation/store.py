"""Compatibility shim: SQLite-backed context store."""
from __future__ import annotations

from session_navigation.model import _item_id
from session_navigation.sqlite_store import SQLiteContextStore

# Backwards-compatible alias for older callers/tests.
MemoryContextStore = SQLiteContextStore

__all__ = ["SQLiteContextStore", "MemoryContextStore", "_item_id"]
