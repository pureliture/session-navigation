"""SQLite-backed context store with version CAS and fork support."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from session_navigation.db import (
    DBError,
    DBFullError,
    open_db,
    resolve_path,
    wal_supported,
)
from session_navigation.model import (
    ContextItem,
    MutationResult,
    Scope,
    _item_id,
)

__all__ = ["SQLiteContextStore"]


def _scope_key(scope: Any) -> str:
    if isinstance(scope, Scope):
        return scope.scope_key()
    if hasattr(scope, "scope_key") and callable(scope.scope_key):
        return str(scope.scope_key())
    return str(scope)


def _row_to_item(row: sqlite3.Row) -> ContextItem:
    excerpt_raw = row["excerpt_lines"]
    try:
        excerpt_lines = tuple(json.loads(excerpt_raw)) if excerpt_raw else ()
    except (json.JSONDecodeError, TypeError):
        excerpt_lines = ()
    inv_snapshot_raw = row["invocation_snapshot"]
    try:
        invocation_snapshot = json.loads(inv_snapshot_raw) if inv_snapshot_raw else None
    except (json.JSONDecodeError, TypeError):
        invocation_snapshot = None
    context_hint_raw = row["context_hint"]
    try:
        context_hint = json.loads(context_hint_raw) if context_hint_raw else None
    except (json.JSONDecodeError, TypeError):
        context_hint = None
    return ContextItem(
        item_id=row["item_id"],
        tool_call_id=row["tool_call_id"] or "",
        content_sha256=row["content_sha256"] or "",
        original=row["original"] or "",
        compacted=row["compacted"] or "",
        excerpt_lines=excerpt_lines,
        visibility=row["visibility"] or "hidden",
        version=int(row["version"] or 1),
        expires_at=0.0,
        tool_name=row["tool_name"],
        compaction_source=row["compaction_source"] or "rule",
        invocation_snapshot=invocation_snapshot,
        invocation_digest=row["invocation_digest"],
        context_hint=context_hint,
        invocation_options_omitted=bool(row["invocation_options_omitted"]),
        result_position=int(row["result_position"] or 0),
        created_at=float(row["created_at"] or 0.0),
        updated_at=float(row["updated_at"] or 0.0),
    )


class ForkCounts:
    """Counts returned by fork_scope, supporting tuple and mapping access."""

    def __init__(self, items: int, identities: int, units: int, calls: int) -> None:
        self.items = items
        self.identities = identities
        self.units = units
        self.calls = calls
        self._values = (items, identities, units, calls)

    def __iter__(self):
        return iter(self._values)

    def __len__(self) -> int:
        return 4

    def __getitem__(self, key):
        names = ("items", "identities", "units", "calls")
        if isinstance(key, int):
            return self._values[key]
        if isinstance(key, str):
            if key in names:
                return getattr(self, key)
            # allow singular/plural-ish aliases
            aliases = {"item": "items", "identity": "identities", "unit": "units", "call": "calls"}
            if key in aliases:
                return getattr(self, aliases[key])
        raise KeyError(key)

    def __eq__(self, other):
        if isinstance(other, ForkCounts):
            return self._values == other._values
        if isinstance(other, (tuple, list)):
            return self._values == tuple(other)
        if isinstance(other, dict):
            return {
                "items": self.items,
                "identities": self.identities,
                "units": self.units,
                "calls": self.calls,
            } == other
        return NotImplemented

    def __repr__(self) -> str:
        return f"ForkCounts(items={self.items}, identities={self.identities}, units={self.units}, calls={self.calls})"

    def to_dict(self) -> dict[str, int]:
        return {
            "items": self.items,
            "identities": self.identities,
            "units": self.units,
            "calls": self.calls,
        }


class SQLiteContextStore:
    """SQLite-backed, durable context store with version CAS."""

    def __init__(
        self,
        path: Any = None,
        *,
        db_path: Any = None,
        state_path: Any = None,
        path_override: Any = None,
        **_kwargs: Any,
    ) -> None:
        resolved = path if path is not None else None
        if resolved is None:
            resolved = db_path if db_path is not None else None
        if resolved is None:
            resolved = state_path if state_path is not None else None
        if resolved is None:
            resolved = path_override if path_override is not None else None
        self.path = resolve_path(resolved)
        self._lock = threading.RLock()
        self._pending: dict[tuple[str, str], tuple[object, str]] = {}
        self._conn = open_db(self.path)

    @property
    def connection(self) -> sqlite3.Connection:
        return self._conn

    def visible_content(self, scope: Any, tool_call_id: str, content: str, *, now: float | None = None) -> str:
        for item in self.items(scope):
            if item.tool_call_id == tool_call_id and content in (item.original, item.compacted):
                return item.compacted if item.visibility == "hidden" else item.original
        return content

    def compact(self, *, affinity: Any, tool_call_id: str, original: str, tool_name: str | None = None,
                now: float | None = None, choice: Any = None, invocation: dict[str, Any] | None = None,
                context: dict[str, str] | None = None, reservation: object | None = None,
                input_digest: str | None = None, options_omitted: bool = False, **kwargs: Any) -> Any:
        from session_navigation.engine import SessionNavigationEngine
        from session_navigation.model import ToolResultRecord, compute_invocation_digest, compute_sha256
        scope = affinity
        inv = invocation if invocation is not None else {"tool_name": tool_name, "arguments": {}}
        digest = input_digest
        if digest is None:
            digest = compute_invocation_digest(inv) if invocation is not None else compute_invocation_digest({"tool_name": tool_name, "arguments": {}})
        record = ToolResultRecord(
            call_id=tool_call_id,
            content=original,
            content_sha256=compute_sha256(original),
            invocation=inv,
            invocation_digest=digest,
            status="ok",
        )
        engine = SessionNavigationEngine(store=self)
        return engine.compact_sync(scope, record, options_omitted=options_omitted)

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:
                pass

    def _is_full(self, exc: BaseException) -> bool:
        message = str(exc).lower()
        if "full" in message or "disk" in message:
            return True
        code = getattr(exc, "sqlite_errorcode", None)
        if code in (13,):
            return True
        return False

    def _handle_db_error(self, exc: BaseException) -> str:
        if self._is_full(exc):
            return "db_full"
        return "db_error"

    # ---------- items ----------
    def get(self, scope: Any, item_id: str) -> ContextItem | None:
        sk = _scope_key(scope)
        with self._lock:
            try:
                row = self._conn.execute(
                    "SELECT * FROM items WHERE scope_key=? AND item_id=?",
                    (sk, item_id),
                ).fetchone()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            if row is None:
                return None
            return _row_to_item(row)

    def items(self, scope: Any) -> tuple[ContextItem, ...]:
        sk = _scope_key(scope)
        with self._lock:
            try:
                rows = self._conn.execute(
                    "SELECT * FROM items WHERE scope_key=? ORDER BY created_at, item_id",
                    (sk,),
                ).fetchall()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            return tuple(_row_to_item(r) for r in rows)

    def all_items(self) -> list[ContextItem]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM items").fetchall()
            return [_row_to_item(r) for r in rows]

    def list_scopes(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT scope_key, COUNT(*) AS n FROM (
                    SELECT scope_key, tool_call_id AS cid FROM items
                    UNION
                    SELECT scope_key, tool_call_id AS cid FROM units WHERE kind = 'tool_result'
                )
                WHERE cid IS NOT NULL AND cid != ''
                GROUP BY scope_key
                ORDER BY scope_key
                """
            ).fetchall()
            return [{"scope_key": r["scope_key"], "items": int(r["n"])} for r in rows]


    def put(
        self,
        scope: Any,
        item: ContextItem,
        *,
        reservation: object | None = None,
        expected_version: int | None = None,
    ) -> MutationResult:
        sk = _scope_key(scope)
        with self._lock:
            try:
                row = self._conn.execute(
                    "SELECT * FROM items WHERE scope_key=? AND item_id=?",
                    (sk, item.item_id),
                ).fetchone()
                existing = _row_to_item(row) if row is not None else None

                if reservation is not None:
                    pending_entry = self._pending.get((sk, item.item_id))
                    if pending_entry is None or pending_entry[0] is not reservation:
                        return MutationResult(ok=False, error="reservation_invalid")

                if existing is None:
                    pass  # insert path below; no CAS needed
                elif expected_version is not None:
                    # Atomic CAS: the UPDATE below carries WHERE version=? and the
                    # rowcount decides; the pre-read only builds the conflict payload.
                    if existing.version != expected_version:
                        return MutationResult(ok=False, error="version_conflict", item=existing)
                else:
                    expected_version = existing.version
                now_ts = time.time()
                created_at = existing.created_at if existing is not None else (item.created_at or now_ts)
                import hashlib as _h
                content_sha = item.content_sha256 or _h.sha256(item.original.encode("utf-8")).hexdigest()
                values = (
                    sk, item.item_id, item.tool_call_id, int(item.result_position or 0),
                    content_sha, item.invocation_digest if item.invocation_digest is not None else "",
                    item.original, item.compacted, json.dumps(list(item.excerpt_lines)),
                    item.visibility, int(item.version or 1), item.tool_name,
                    item.compaction_source,
                    json.dumps(item.invocation_snapshot) if item.invocation_snapshot is not None else None,
                    json.dumps(item.context_hint) if item.context_hint is not None else None,
                    1 if item.invocation_options_omitted else 0, created_at, now_ts,
                )
                if existing is not None and expected_version is not None:
                    cur = self._conn.execute(
                        """UPDATE items SET tool_call_id=?, result_position=?, content_sha256=?,
                           invocation_digest=?, original=?, compacted=?, excerpt_lines=?,
                           visibility=?, version=?, tool_name=?, compaction_source=?,
                           invocation_snapshot=?, context_hint=?, invocation_options_omitted=?,
                           updated_at=?
                           WHERE scope_key=? AND item_id=? AND version=?""",
                        (values[2], values[3], values[4], values[5], values[6], values[7],
                         values[8], values[9], values[10], values[11], values[12],
                         values[13], values[14], values[15], values[17], sk, item.item_id, int(expected_version)),
                    )
                    if cur.rowcount == 0:
                        self._conn.rollback()
                        current = self._conn.execute(
                            "SELECT * FROM items WHERE scope_key=? AND item_id=?",
                            (sk, item.item_id)).fetchone()
                        return MutationResult(ok=False, error="version_conflict",
                                              item=_row_to_item(current) if current else existing)
                else:
                    self._conn.execute(
                        """
                        INSERT INTO items (
                            scope_key, item_id, tool_call_id, result_position, content_sha256,
                            invocation_digest, original, compacted, excerpt_lines, visibility,
                            version, tool_name, compaction_source, invocation_snapshot, context_hint,
                            invocation_options_omitted, created_at, updated_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(scope_key,item_id) DO UPDATE SET
                            tool_call_id=excluded.tool_call_id,
                            result_position=excluded.result_position,
                            content_sha256=excluded.content_sha256,
                            invocation_digest=excluded.invocation_digest,
                            original=excluded.original,
                            compacted=excluded.compacted,
                            excerpt_lines=excluded.excerpt_lines,
                            visibility=excluded.visibility,
                            version=excluded.version,
                            tool_name=excluded.tool_name,
                            compaction_source=excluded.compaction_source,
                            invocation_snapshot=excluded.invocation_snapshot,
                            context_hint=excluded.context_hint,
                            invocation_options_omitted=excluded.invocation_options_omitted,
                            updated_at=excluded.updated_at
                        """,
                        values,
                    )
                # identities fence upsert
                self._conn.execute(
                    """
                    INSERT INTO identities (
                        scope_key, tool_call_id, content_sha256, invocation_digest, result_position,
                        item_id, version, updated_at
                    ) VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(scope_key,tool_call_id,content_sha256,invocation_digest,result_position)
                    DO UPDATE SET item_id=excluded.item_id, version=excluded.version, updated_at=excluded.updated_at
                    """,
                    (
                        sk,
                        item.tool_call_id,
                        content_sha,
                        item.invocation_digest if item.invocation_digest is not None else "",
                        int(item.result_position or 0),
                        item.item_id,
                        int(item.version or 1),
                        now_ts,
                    ),
                )
                self._conn.commit()
                updated_item = ContextItem(
                    **{
                        **item.__dict__,
                        "content_sha256": content_sha,
                        "created_at": created_at,
                        "updated_at": now_ts,
                    }
                )
                return MutationResult(ok=True, item=updated_item)
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                code = self._handle_db_error(exc)
                return MutationResult(ok=False, error=code)

    def restore(
        self,
        scope: Any,
        item_id: str,
        *,
        expected_version: int | None = None,
    ) -> MutationResult:
        sk = _scope_key(scope)
        with self._lock:
            try:
                row = self._conn.execute(
                    "SELECT * FROM items WHERE scope_key=? AND item_id=?",
                    (sk, item_id),
                ).fetchone()
                if row is None:
                    return MutationResult(ok=False, error="not_found")
                existing = _row_to_item(row)
                if expected_version is not None and existing.version != expected_version:
                    return MutationResult(ok=False, error="version_conflict", item=existing)
                now_ts = time.time()
                new_version = existing.version + 1 if existing.visibility != "visible" else existing.version
                # If expected_version provided, increment from that
                if expected_version is not None:
                    new_version = expected_version + 1 if existing.visibility != "visible" else existing.version
                if existing.visibility != "visible":
                    if expected_version is not None:
                        cur = self._conn.execute(
                            "UPDATE items SET visibility='visible', version=?, updated_at=? WHERE scope_key=? AND item_id=? AND version=?",
                            (new_version, now_ts, sk, item_id, int(expected_version)),
                        )
                        if cur.rowcount == 0:
                            self._conn.rollback()
                            current = self._conn.execute(
                                "SELECT * FROM items WHERE scope_key=? AND item_id=?",
                                (sk, item_id)).fetchone()
                            return MutationResult(ok=False, error="version_conflict",
                                                  item=_row_to_item(current) if current else existing)
                    else:
                        self._conn.execute(
                            "UPDATE items SET visibility='visible', version=?, updated_at=? WHERE scope_key=? AND item_id=?",
                            (new_version, now_ts, sk, item_id),
                        )
                    self._conn.commit()
                    existing = ContextItem(
                        **{**existing.__dict__, "visibility": "visible", "version": new_version, "updated_at": now_ts}
                    )
                return MutationResult(ok=True, item=existing)
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                return MutationResult(ok=False, error=self._handle_db_error(exc))

    def reserve(
        self,
        scope: Any,
        item_id: str,
        digest: str | None = None,
    ) -> tuple[object | None, str | None]:
        sk = _scope_key(scope)
        with self._lock:
            key = (sk, item_id)
            # check existing item
            try:
                row = self._conn.execute(
                    "SELECT 1 FROM items WHERE scope_key=? AND item_id=?", (sk, item_id)
                ).fetchone()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            if row is not None:
                return None, "already_exists"
            if key in self._pending:
                return None, "in_progress"
            if len(self._pending) >= 4:
                return None, "pending_full"
            token = object()
            self._pending[key] = (token, digest or "")
            return token, None

    def release(self, scope: Any, item_id: str, token: object) -> None:
        sk = _scope_key(scope)
        with self._lock:
            key = (sk, item_id)
            entry = self._pending.get(key)
            if entry is not None and entry[0] is token:
                del self._pending[key]

    # ---------- fence ----------
    def fence_get(
        self,
        scope: Any,
        tool_call_id: str = "",
        content_sha256: str = "",
        invocation_digest: str = "",
        result_position: int = 0,
        **kwargs: Any,
    ) -> str | None:
        # support alternate kw names
        if "scope_key" in kwargs and scope is None:
            scope = kwargs.pop("scope_key")
        sk = _scope_key(scope)
        tc = kwargs.get("tool_call_id", tool_call_id)
        sha = kwargs.get("content_sha256", content_sha256)
        dig = kwargs.get("invocation_digest", invocation_digest)
        pos = kwargs.get("result_position", result_position)
        with self._lock:
            try:
                row = self._conn.execute(
                    """SELECT item_id FROM identities
                       WHERE scope_key=? AND tool_call_id=? AND content_sha256=? AND invocation_digest=? AND result_position=?""",
                    (sk, tc, sha, dig, int(pos)),
                ).fetchone()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            return row["item_id"] if row is not None else None

    def fence_set(
        self,
        scope: Any,
        tool_call_id: str = "",
        content_sha256: str = "",
        invocation_digest: str = "",
        result_position: int = 0,
        item_id: str = "",
        version: int = 1,
        **kwargs: Any,
    ) -> None:
        sk = _scope_key(scope)
        tc = kwargs.get("tool_call_id", tool_call_id)
        sha = kwargs.get("content_sha256", content_sha256)
        dig = kwargs.get("invocation_digest", invocation_digest)
        pos = kwargs.get("result_position", result_position)
        iid = kwargs.get("item_id", item_id)
        ver = kwargs.get("version", version)
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO identities (scope_key, tool_call_id, content_sha256, invocation_digest, result_position, item_id, version, updated_at)
                    VALUES (?,?,?,?,?,?,?,?)
                    ON CONFLICT(scope_key,tool_call_id,content_sha256,invocation_digest,result_position)
                    DO UPDATE SET item_id=excluded.item_id, version=excluded.version, updated_at=excluded.updated_at
                    """,
                    (sk, tc, sha, dig, int(pos), iid, int(ver), time.time()),
                )
                self._conn.commit()
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                if self._is_full(exc):
                    raise DBFullError(str(exc))
                raise DBError(str(exc))

    # ---------- fork ----------
    def fork_scope(self, src_scope_key: Any, dst_scope_key: Any) -> ForkCounts:
        src = _scope_key(src_scope_key) if not isinstance(src_scope_key, str) or ":" in str(src_scope_key) else str(src_scope_key)
        # _scope_key handles Scope; for raw strings keep as-is
        if isinstance(src_scope_key, Scope):
            src = src_scope_key.scope_key()
        else:
            src = str(src_scope_key)
        if isinstance(dst_scope_key, Scope):
            dst = dst_scope_key.scope_key()
        else:
            dst = str(dst_scope_key)

        with self._lock:
            try:
                # items: recompute item_id under the child scope so project() lookups match.
                rows = self._conn.execute("SELECT * FROM items WHERE scope_key=?", (src,)).fetchall()
                id_map: dict[str, str] = {}
                for r in rows:
                    new_id = _item_id(dst, r["tool_call_id"] or "", r["content_sha256"] or "",
                                      r["invocation_digest"] or "", int(r["result_position"] or 0))
                    id_map[r["item_id"]] = new_id
                    self._conn.execute(
                        """INSERT OR REPLACE INTO items
                        (scope_key,item_id,tool_call_id,result_position,content_sha256,invocation_digest,original,compacted,excerpt_lines,visibility,version,tool_name,compaction_source,invocation_snapshot,context_hint,invocation_options_omitted,created_at,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            dst, new_id, r["tool_call_id"], r["result_position"], r["content_sha256"],
                            r["invocation_digest"], r["original"], r["compacted"], r["excerpt_lines"],
                            r["visibility"], r["version"], r["tool_name"], r["compaction_source"],
                            r["invocation_snapshot"], r["context_hint"], r["invocation_options_omitted"],
                            r["created_at"], r["updated_at"],
                        ),
                    )
                items_count = len(rows)

                rows = self._conn.execute("SELECT * FROM identities WHERE scope_key=?", (src,)).fetchall()
                for r in rows:
                    self._conn.execute(
                        """INSERT OR REPLACE INTO identities
                        (scope_key,tool_call_id,content_sha256,invocation_digest,result_position,item_id,version,updated_at)
                        VALUES (?,?,?,?,?,?,?,?)""",
                        (dst, r["tool_call_id"], r["content_sha256"], r["invocation_digest"], r["result_position"], id_map.get(r["item_id"], r["item_id"]), r["version"], r["updated_at"]),
                    )
                identities_count = len(rows)

                rows = self._conn.execute("SELECT * FROM units WHERE scope_key=?", (src,)).fetchall()
                for r in rows:
                    self._conn.execute(
                        """INSERT OR REPLACE INTO units
                        (scope_key,unit_id,message_uid,kind,parent_unit_id,tool_call_id,content_sha256,char_count,tokens_display,visibility,version,updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (dst, r["unit_id"], r["message_uid"], r["kind"], r["parent_unit_id"], r["tool_call_id"], r["content_sha256"], r["char_count"], r["tokens_display"], r["visibility"], r["version"], r["updated_at"]),
                    )
                units_count = len(rows)

                rows = self._conn.execute("SELECT * FROM calls WHERE scope_key=?", (src,)).fetchall()
                for r in rows:
                    self._conn.execute(
                        """INSERT OR REPLACE INTO calls
                        (scope_key,call_key,prompt_tokens,completion_tokens,total_tokens,cost_usd,recorded_at)
                        VALUES (?,?,?,?,?,?,?)""",
                        (dst, r["call_key"], r["prompt_tokens"], r["completion_tokens"], r["total_tokens"], r["cost_usd"], r["recorded_at"]),
                    )
                calls_count = len(rows)

                self._conn.commit()
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                if self._is_full(exc):
                    raise DBFullError(str(exc))
                raise DBError(str(exc))
            return ForkCounts(items_count, identities_count, units_count, calls_count)

    # ---------- units ----------
    def upsert_unit(self, scope: Any, unit: Any = None, **kwargs: Any) -> None:
        sk = _scope_key(scope)
        data = self._coerce_unit(unit, kwargs)
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO units (scope_key,unit_id,message_uid,kind,parent_unit_id,tool_call_id,content_sha256,char_count,tokens_display,visibility,version,updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(scope_key,unit_id) DO UPDATE SET
                        message_uid=excluded.message_uid,
                        kind=excluded.kind,
                        parent_unit_id=excluded.parent_unit_id,
                        tool_call_id=excluded.tool_call_id,
                        content_sha256=excluded.content_sha256,
                        char_count=excluded.char_count,
                        tokens_display=excluded.tokens_display,
                        visibility=excluded.visibility,
                        version=excluded.version,
                        updated_at=excluded.updated_at
                    """,
                    (
                        sk,
                        data["unit_id"],
                        data.get("message_uid"),
                        data.get("kind"),
                        data.get("parent_unit_id"),
                        data.get("tool_call_id"),
                        data.get("content_sha256"),
                        int(data.get("char_count", 0) or 0),
                        data.get("tokens_display", "—"),
                        data.get("visibility", "visible"),
                        int(data.get("version", 1) or 1),
                        float(data.get("updated_at", time.time()) or time.time()),
                    ),
                )
                self._conn.commit()
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                if self._is_full(exc):
                    raise DBFullError(str(exc))
                raise DBError(str(exc))

    def upsert_units(self, scope: Any, units: Any) -> None:
        for u in units:
            self.upsert_unit(scope, u)

    def list_units(self, scope: Any, message_uid: str | None = None) -> list[dict[str, Any]]:
        sk = _scope_key(scope)
        with self._lock:
            try:
                if message_uid is None:
                    rows = self._conn.execute(
                        "SELECT * FROM units WHERE scope_key=?", (sk,)
                    ).fetchall()
                else:
                    rows = self._conn.execute(
                        "SELECT * FROM units WHERE scope_key=? AND message_uid=?", (sk, message_uid)
                    ).fetchall()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            return [dict(r) for r in rows]

    def units(self, scope: Any, message_uid: str | None = None) -> list[dict[str, Any]]:
        return self.list_units(scope, message_uid)

    def set_message_visibility(
        self, scope: Any, unit_id: str, *, kind: str, content_sha256: str, char_count: int,
        visibility: str, expected_version: int | None = None,
    ) -> dict[str, Any]:
        """CAS-toggle a user/assistant message unit between visible and hidden."""
        sk = _scope_key(scope)
        with self._lock:
            try:
                row = self._conn.execute(
                    "SELECT version, visibility FROM units WHERE scope_key=? AND unit_id=?", (sk, unit_id)
                ).fetchone()
                version = int(row["version"]) if row else 1
                current = row["visibility"] if row else "visible"
                if expected_version is not None and version != expected_version:
                    return {"ok": False, "error": "version_conflict", "version": version, "visibility": current}
                if current == visibility:
                    return {"ok": True, "version": version, "visibility": visibility}
                now_ts = time.time()
                if row:
                    cur = self._conn.execute(
                        "UPDATE units SET visibility=?, version=?, updated_at=? WHERE scope_key=? AND unit_id=? AND version=?",
                        (visibility, version + 1, now_ts, sk, unit_id, version),
                    )
                    if cur.rowcount == 0:
                        self._conn.rollback()
                        return {"ok": False, "error": "version_conflict", "version": version, "visibility": current}
                else:
                    self._conn.execute(
                        "INSERT INTO units (scope_key,unit_id,message_uid,kind,content_sha256,char_count,visibility,version,updated_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (sk, unit_id, unit_id, kind, content_sha256, int(char_count), visibility, version + 1, now_ts),
                    )
                self._conn.commit()
                return {"ok": True, "version": version + 1, "visibility": visibility}
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))

    def ensure_message_units(self, scope: Any, units: list[tuple[str, str, str, int]]) -> None:
        """Record (unit_id, kind, content_sha256, char_count) message units without touching existing visibility."""
        if not units:
            return
        sk = _scope_key(scope)
        now_ts = time.time()
        with self._lock:
            try:
                self._conn.executemany(
                    "INSERT OR IGNORE INTO units (scope_key,unit_id,message_uid,kind,content_sha256,char_count,visibility,version,updated_at)"
                    " VALUES (?,?,?,?,?,?,'visible',1,?)",
                    [(sk, uid, uid, kind, sha, int(chars), now_ts) for uid, kind, sha, chars in units],
                )
                self._conn.commit()
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))

    def hidden_message_keys(self, scope: Any) -> list[str]:
        sk = _scope_key(scope)
        with self._lock:
            try:
                rows = self._conn.execute(
                    "SELECT unit_id FROM units WHERE scope_key=? AND kind IN ('user','assistant') AND visibility='hidden'",
                    (sk,),
                ).fetchall()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            return sorted(r["unit_id"] for r in rows)

    def _coerce_unit(self, unit: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
        if unit is None:
            data = dict(kwargs)
        elif isinstance(unit, dict):
            data = dict(unit)
            data.update(kwargs)
        elif is_dataclass(unit):
            data = asdict(unit)
            data.update(kwargs)
        else:
            # object with attributes
            data = {}
            for attr in (
                "unit_id", "message_uid", "kind", "parent_unit_id", "tool_call_id",
                "content_sha256", "char_count", "tokens_display", "visibility", "version", "updated_at",
            ):
                if hasattr(unit, attr):
                    data[attr] = getattr(unit, attr)
            data.update(kwargs)
        if "id" in data and "unit_id" not in data:
            data["unit_id"] = data.pop("id")
        return data

    # ---------- calls ----------
    def record_call(
        self,
        scope: Any,
        call_key: str = "",
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        total_tokens: int = 0,
        cost_usd: float = 0.0,
        recorded_at: float | None = None,
        **kwargs: Any,
    ) -> None:
        sk = _scope_key(scope)
        ck = kwargs.get("call_key", call_key)
        pt = kwargs.get("prompt_tokens", prompt_tokens)
        ct = kwargs.get("completion_tokens", completion_tokens)
        tt = kwargs.get("total_tokens", total_tokens)
        cost = kwargs.get("cost_usd", cost_usd)
        ts = kwargs.get("recorded_at", recorded_at)
        if ts is None:
            ts = time.time()
        with self._lock:
            try:
                self._conn.execute(
                    """
                    INSERT INTO calls (scope_key,call_key,prompt_tokens,completion_tokens,total_tokens,cost_usd,recorded_at)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(scope_key,call_key) DO UPDATE SET
                        prompt_tokens=excluded.prompt_tokens,
                        completion_tokens=excluded.completion_tokens,
                        total_tokens=excluded.total_tokens,
                        cost_usd=excluded.cost_usd,
                        recorded_at=excluded.recorded_at
                    """,
                    (sk, ck, int(pt or 0), int(ct or 0), int(tt or 0), float(cost or 0.0), float(ts)),
                )
                self._conn.commit()
            except sqlite3.Error as exc:
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                if self._is_full(exc):
                    raise DBFullError(str(exc))
                raise DBError(str(exc))

    def get_call(self, scope: Any, call_key: str) -> dict[str, Any] | None:
        sk = _scope_key(scope)
        with self._lock:
            try:
                row = self._conn.execute(
                    "SELECT * FROM calls WHERE scope_key=? AND call_key=?", (sk, call_key)
                ).fetchone()
            except sqlite3.Error as exc:
                raise DBFullError(str(exc)) if self._is_full(exc) else DBError(str(exc))
            return dict(row) if row is not None else None

    # alias names
    def get_usage(self, scope: Any, call_key: str) -> dict[str, Any] | None:
        return self.get_call(scope, call_key)

    def record_usage(self, *a: Any, **k: Any) -> None:
        self.record_call(*a, **k)


# Back-compat alias for any code/tests still referencing MemoryContextStore.
MemoryContextStore = SQLiteContextStore
