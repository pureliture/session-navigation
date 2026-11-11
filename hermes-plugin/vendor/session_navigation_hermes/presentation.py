"""Human-supervision display metadata for the Hermes adapter (A-plan).

The engine stores items, but it has no wall-clock "compacted at" time and no
compact order. This module keeps that *display-only* metadata in process
memory, scope-bound, and never duplicates original bodies:

- ``compaction_order``: per-scope counter of compact transitions (newest first
  when listed). Not a stable ID.
- ``compacted_at``: UTC wall-clock of the latest compact transition. A re-compact
  of an already-compacted item keeps the earlier timestamp; a compact after an
  restore refreshes it (it is a new transition).
- ``original_bytes_size``: UTF-8 size of the original at compact time.
- ``summary_line``: derived from the stored excerpt lines, never from a
  new model call.

Everything here is best-effort: entries missing for an item simply list
with ``null`` display fields instead of invented values. Callers prune
expired entries against the engine's live item ids on each tool access.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

MAX_SUMMARY_LINE_CHARS = 160


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z")


def numeric_reference(text: str) -> int | None:
    """Parse a display-number reference ("2", "2번", "#2") into an int.

    Returns None when the text is not purely a number reference, in which
    case the caller treats it as an exact item id. ``item_...`` ids can
    never collide with this pattern because they contain letters.
    """
    if not isinstance(text, str):
        return None
    collapsed = "".join(text.split())
    if collapsed.startswith("#"):
        collapsed = collapsed[1:]
    if collapsed.endswith("번"):
        collapsed = collapsed[:-1]
    if not collapsed or not collapsed.isdigit():
        return None
    return int(collapsed)


def summary_line_from_excerpts(excerpt_lines: Iterable[str]) -> str:
    """First non-empty excerpt line, whitespace-collapsed, length-capped."""
    for line in excerpt_lines:
        collapsed = " ".join(str(line).split())
        if collapsed:
            return collapsed[:MAX_SUMMARY_LINE_CHARS]
    return ""


@dataclass
class Presentation:
    """Display-only metadata for one compacted item."""

    item_id: str
    compaction_order: int
    compacted_at: str
    original_bytes_size: int
    last_visibility: str = "hidden"


class PresentationRegistry:
    """Scope-keyed, thread-safe display metadata (process memory only)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, dict[str, Presentation]] = {}
        self._next_order: dict[str, int] = {}
        self._views: dict[str, list[tuple[int, str]]] = {}

    def record_compacted(
        self,
        scope_key: str,
        item_id: str,
        original_bytes_size: int,
    ) -> None:
        """Record a compact transition; refresh only after a visible period."""
        with self._lock:
            entries = self._entries.setdefault(scope_key, {})
            existing = entries.get(item_id)
            if existing is not None and existing.last_visibility == "hidden":
                existing.original_bytes_size = original_bytes_size
                return
            order = self._next_order.get(scope_key, 0) + 1
            self._next_order[scope_key] = order
            entries[item_id] = Presentation(
                item_id=item_id,
                compaction_order=order,
                compacted_at=_utc_now_iso(),
                original_bytes_size=original_bytes_size,
                last_visibility="hidden",
            )

    def mark_visible(self, scope_key: str, item_id: str) -> None:
        """Record an restore; the compact timestamp and order are retained."""
        with self._lock:
            entry = self._entries.get(scope_key, {}).get(item_id)
            if entry is not None:
                entry.last_visibility = "visible"

    def record_view(
        self, scope_key: str, numbered_items: list[tuple[int, str]]
    ) -> None:
        """Remember the numbering of the most recent list result.

        Display numbers are re-issued per list call, and this snapshot is
        what a later "N번" reference resolves against. It is replaced only
        by the next list call, so a user who saw numbers 1..N keeps those
        meanings even after some of the items are restored.
        """
        with self._lock:
            self._views[scope_key] = list(numbered_items)

    def resolve_reference(
        self, scope_key: str, text: str
    ) -> tuple[str | None, str | None]:
        """Resolve a tool argument to an item id: (item_id, error).

        Exact ids pass through unchanged. A pure number resolves against
        the last list result for the scope and fails closed: with no list
        shown yet the answer is ``no_recent_list``; a number the last list
        did not issue is ``unknown_display_number``. The registry never
        guesses a target.
        """
        number = numeric_reference(text)
        if number is None:
            return text, None
        with self._lock:
            view = self._views.get(scope_key)
        if view is None:
            return None, "no_recent_list"
        for issued_number, item_id in view:
            if issued_number == number:
                return item_id, None
        return None, "unknown_display_number"

    def prune(self, scope_key: str, live_item_ids: set[str]) -> int:
        """Drop entries whose engine item no longer exists (expired/evicted)."""
        with self._lock:
            entries = self._entries.get(scope_key)
            if not entries:
                return 0
            stale = [key for key in entries if key not in live_item_ids]
            for key in stale:
                del entries[key]
            return len(stale)

    def snapshot(self) -> dict[str, dict[str, Presentation]]:
        """Copy for assertions; never used for output on the hot path."""
        with self._lock:
            return {
                scope: dict(entries) for scope, entries in self._entries.items()
            }


def _sort_key(item: dict[str, Any]) -> tuple[int, int, int, str]:
    compacted = item.get("visibility") == "hidden"
    order = item.get("compaction_order")
    known = isinstance(order, int)
    return (
        0 if compacted else 1,
        0 if known else 1,
        -order if known else 0,
        str(item.get("item_id", "")),
    )


def decorate_items(
    items: list[dict[str, Any]],
    snapshot: dict[str, Presentation],
) -> list[dict[str, Any]]:
    """Add display fields, sort (newest compact first), and number the compacted.

    Restored records keep their display metadata (so the history stays
    readable) but carry ``display_number: None`` and sort after compacted
    items. Unknown-order entries sort last by item id; no value is ever
    invented.
    """
    decorated: list[dict[str, Any]] = []
    for item in items:
        entry = snapshot.get(str(item.get("item_id", "")))
        item = dict(item)
        item["original_bytes_size"] = (
            entry.original_bytes_size if entry is not None else None
        )
        item["compacted_at"] = entry.compacted_at if entry is not None else None
        item["compaction_order"] = entry.compaction_order if entry is not None else None
        item["display_number"] = None
        item["summary_line"] = summary_line_from_excerpts(
            item.get("excerpt_lines") or [])
        decorated.append(item)
    decorated.sort(key=_sort_key)
    number = 0
    for item in decorated:
        if item.get("visibility") == "hidden":
            number += 1
            item["display_number"] = number
    return decorated
