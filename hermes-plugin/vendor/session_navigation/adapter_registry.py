"""Durable adapter capabilities and bounded, verified target publication."""
from __future__ import annotations

import functools
import json
import sqlite3
import time

from .db import ADAPTER_PROTOCOL_VERSION, DBError, DBFullError, _is_full_error
from .model import _item_id, canonical, compute_invocation_digest

HEARTBEAT_SECONDS = 300
MAX_TARGETS = 256
MAX_TARGET_BYTES = 4 * 1024 * 1024


def _db_guarded(fn):
    """Normalize raw sqlite3 failures to the shared DBError/DBFullError contract.

    sqlite_store normalizes persistence failures the same way; the registry
    mixin must not leak bare ``sqlite3.Error`` (e.g. read-only/locked/full
    databases) to host-side callers. ``ValueError`` input validation passes
    through unchanged.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except DBError:
            raise
        except sqlite3.Error as exc:
            if _is_full_error(exc):
                raise DBFullError(str(exc)) from exc
            raise DBError(str(exc)) from exc

    return wrapper


def _utf16_len(value: str) -> int:
    """Length in UTF-16 code units, matching TypeScript ``String.length``.

    The bundle fingerprint bound (128) is defined in these units so both
    implementations accept exactly the same values. Real fingerprints are
    ASCII hex digests where code points and code units coincide; the units
    only differ for non-BMP characters.
    """
    return len(value.encode("utf-16-le")) // 2


# B1.3: internal bookkeeping flag stored inside adapter_sessions.capabilities
# JSON. Marks rows whose enabled=false was written by set_adapter_control(false)
# so a later set_adapter_control(true) resurrects only those rows — never rows
# disabled for their own reasons (e.g. unsupported api_mode registers with
# enabled=false). Stripped from adapter_session() output; never a capability.
# Writers on both sides of the shared DB must preserve it: register_adapter()
# carries it per the rules below, link_children() copies it, and control
# toggles own it. (Mirrors packages/core/src/store.ts CONTROL_DISABLED_MARKER.)
CONTROL_DISABLED_MARKER = "control_disabled"

def scope_aliases(scope_key: str, aliases: dict[str, tuple[str, ...]]) -> tuple[str, ...]:
    """Exact scope wins; the owning host supplies discovery-only branch aliases."""
    parts = scope_key.split(":")
    if len(parts) == 4 and parts[3] in aliases.get(parts[0], ()):
        return (scope_key, *(":".join([*parts[:3], branch]) for branch in aliases[parts[0]] if branch != parts[3]))
    return (scope_key,)


class AdapterRegistryMixin:
    def _stored_capabilities(self, scope_key):
        """Raw stored capabilities JSON, including the control-disabled marker."""
        row = self.connection.execute(
            "SELECT capabilities FROM adapter_sessions WHERE scope_key=?", (scope_key,)).fetchone()
        return json.loads(row["capabilities"]) if row else {}

    @_db_guarded
    def adapter_session(self, scope):
        """Resolve an exact registration, then host-configured branch aliases."""
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        with self._lock:
            for candidate in scope_aliases(key, self.scope_aliases):
                row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (candidate,)).fetchone()
                if row is not None:
                    result = dict(row)
                    stored = json.loads(result["capabilities"])
                    linkage = stored.get("linkage", {})
                    result.update({name: linkage.get(name) for name in ("parent_scope", "tool_call_id", "subagent_id")})
                    # The control-disabled marker is store bookkeeping, not a capability.
                    result["capabilities"] = {k: v for k, v in stored.items() if k != CONTROL_DISABLED_MARKER}
                    result["enabled"] = bool(result["enabled"])
                    return result
        return None

    @_db_guarded
    def child_scopes(self, parent_scope: str):
        with self._lock:
            rows = self.connection.execute("SELECT scope_key FROM adapter_sessions ORDER BY scope_key").fetchall()
            return [row for key in rows if (row := self.adapter_session(key[0]))["parent_scope"] == parent_scope]
    @_db_guarded
    def adapter_can(self, scope, capability: str) -> bool:
        row = self.adapter_session(scope)
        if not (row and row["adapter_protocol"] == ADAPTER_PROTOCOL_VERSION and
                row["enabled"] and row["capabilities"].get(capability) is True):
            return False
        # B1.4: consult the control row on every check instead of trusting a
        # caller-side isAdapterEnabled() read; an absent row means enabled.
        control = self.get_adapter_control(row["adapter_id"])
        return True if control is None else bool(control["enabled"])

    @_db_guarded
    def link_children(self, parent_scope: str, tool_call_id: str, subagent_ids: list[str]) -> None:
        if not tool_call_id or any(not isinstance(value, str) or not value for value in subagent_ids):
            raise ValueError("invalid_adapter_registration")
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            parent = self.adapter_session(parent_scope)
            if parent is None:
                raise ValueError("adapter_not_detected")
            caps = dict(parent["capabilities"])
            # adapter_session() strips the control-disabled marker; carry it over
            # so linking never resurrects-or-orphans control-disabled rows (B1.3).
            if self._stored_capabilities(parent_scope).get(CONTROL_DISABLED_MARKER) is True:
                caps[CONTROL_DISABLED_MARKER] = True
            pending = dict(caps.get("pending_children", {}))
            for subagent in subagent_ids:
                children = [row for row in self.child_scopes(parent_scope) if row["subagent_id"] == subagent]
                if not children:
                    pending[subagent] = tool_call_id
                for child in children:
                    packed = dict(child["capabilities"])
                    if self._stored_capabilities(child["scope_key"]).get(CONTROL_DISABLED_MARKER) is True:
                        packed[CONTROL_DISABLED_MARKER] = True
                    packed["linkage"] = dict(parent_scope=parent_scope, subagent_id=subagent, tool_call_id=tool_call_id)
                    self.connection.execute("UPDATE adapter_sessions SET capabilities=? WHERE scope_key=?", (canonical(packed), child["scope_key"]))
            if pending:
                caps["pending_children"] = pending
            self.connection.execute("UPDATE adapter_sessions SET capabilities=? WHERE scope_key=?", (canonical(caps), parent_scope))

    @_db_guarded
    def register_adapter(self, scope, *, adapter_id: str, instance_id: str,
                         capabilities: dict, enabled: bool = True,
                         adapter_protocol: int = ADAPTER_PROTOCOL_VERSION, now: float | None = None,
                         parent_scope: str | None = None, tool_call_id: str | None = None,
                         subagent_id: str | None = None) -> bool:
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        # B1.1: ':' would create an unused control row shadowing real sessions
        # (e.g. "acme:default" matching "acme:default:*"); reject it here
        # instead of relying on the scope-prefix check below.
        if not isinstance(adapter_id, str) or ":" in adapter_id:
            raise ValueError("invalid_adapter_registration")
        if not instance_id or key.split(":", 1)[0] != adapter_id:
            raise ValueError("invalid_adapter_registration")
        packed = {name: capabilities.get(name) is True for name in ("hide", "summarize", "unhide")}
        if capabilities.get("protection_only") is True:
            packed["protection_only"] = True
        bundle_fp = capabilities.get("bundle_fingerprint")
        # Bound is UTF-16 code units (TypeScript String.length); see _utf16_len.
        if isinstance(bundle_fp, str) and bundle_fp and _utf16_len(bundle_fp) <= 128:
            packed["bundle_fingerprint"] = bundle_fp
        if any(value is not None and (not isinstance(value, str) or not value or len(value) > 1024)
               for value in (parent_scope, tool_call_id, subagent_id)):
            raise ValueError("invalid_adapter_registration")
        if parent_scope == key or (parent_scope and len(parent_scope.split(":")) != 4):
            raise ValueError("invalid_adapter_registration")
        stamp = time.time() if now is None else now
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (key,)).fetchone()
            # B1.4: re-read adapter_control inside the write transaction so a stale
            # caller-side enabled flag cannot commit enabled=true after a
            # concurrent control-off (BEGIN IMMEDIATE serializes control writers).
            control_row = self.connection.execute(
                "SELECT enabled FROM adapter_control WHERE adapter_id=?", (adapter_id,)).fetchone()
            control_on = control_row is None or bool(control_row["enabled"])
            stored_enabled = bool(enabled) and control_on
            prior_caps = json.loads(row["capabilities"]) if row else {}
            prior = prior_caps.get("linkage", {})
            parent = parent_scope or prior.get("parent_scope")
            subagent = subagent_id or prior.get("subagent_id")
            parent_row = self.connection.execute("SELECT capabilities FROM adapter_sessions WHERE scope_key=?", (parent,)).fetchone() if parent else None
            parent_caps = json.loads(parent_row["capabilities"]) if parent_row else {}
            pending = parent_caps.get("pending_children", {})
            pending_call = pending.pop(subagent, None)
            if pending_call:
                if not pending:
                    parent_caps.pop("pending_children", None)
                self.connection.execute("UPDATE adapter_sessions SET capabilities=? WHERE scope_key=?", (canonical(parent_caps), parent))
            if "pending_children" in prior_caps:
                packed["pending_children"] = prior_caps["pending_children"]
            # B1.3: a disable while control is off keeps the existing marker (the
            # write mirrors control); a disable while control is on is self-caused
            # and clears it so a later control-on cannot resurrect the session.
            if not stored_enabled and not control_on and prior_caps.get(CONTROL_DISABLED_MARKER) is True:
                packed[CONTROL_DISABLED_MARKER] = True
            if parent:
                packed["linkage"] = dict(parent_scope=parent,
                    tool_call_id=tool_call_id or prior.get("tool_call_id") or pending_call,
                    subagent_id=subagent)
            caps = canonical(packed)
            values = (adapter_id, adapter_protocol, caps, int(stored_enabled), instance_id)
            if row is not None and tuple(row[k] for k in ("adapter_id", "adapter_protocol", "capabilities", "enabled", "instance_id")) == values and stamp - row["last_seen"] < HEARTBEAT_SECONDS:
                return False
            self.connection.execute("""INSERT INTO adapter_sessions VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(scope_key) DO UPDATE SET adapter_id=excluded.adapter_id,
                adapter_protocol=excluded.adapter_protocol,capabilities=excluded.capabilities,
                enabled=excluded.enabled,instance_id=excluded.instance_id,last_seen=excluded.last_seen""",
                (key, *values, stamp))
            return True

    @_db_guarded
    def publish_targets(self, scope, targets) -> None:
        """Publish (record, omitted-options) tuples; invalid batches write nothing."""
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        verified = []
        for record, omitted in targets:
            if not record.call_id or record.result_position < 0 or not record.invocation.get("tool_name") or record.status != "ok" or not record.verify_sha256() or record.invocation_digest != compute_invocation_digest(record.invocation, omitted):
                raise ValueError("invalid_target_identity")
            item_id = _item_id(key, record.call_id, record.content_sha256, record.invocation_digest, record.result_position)
            invocation = canonical(record.invocation)
            size = len(record.content.encode("utf-8")) + len(invocation.encode("utf-8"))
            if size <= MAX_TARGET_BYTES:
                verified.append((item_id, record, invocation, bool(omitted)))
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (key,)).fetchone()
            if row is None or not row["enabled"] or row["adapter_protocol"] != ADAPTER_PROTOCOL_VERSION or json.loads(row["capabilities"]).get("hide") is not True:
                raise ValueError("adapter_unavailable")
            # B1.4: couple the control check to the publishing transaction. The
            # owner row may carry a stale enabled=true committed before a
            # concurrent control-off; fail closed instead of publishing.
            control = self.connection.execute(
                "SELECT enabled FROM adapter_control WHERE adapter_id=?", (str(row["adapter_id"]),)).fetchone()
            if control is not None and not control["enabled"]:
                raise ValueError("adapter_disabled")
            for item_id, record, invocation, omitted in verified:
                seq = self.connection.execute("SELECT COALESCE(MAX(seq),0)+1 FROM adapter_targets WHERE scope_key=?", (key,)).fetchone()[0]
                self.connection.execute("""INSERT INTO adapter_targets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(scope_key,item_id) DO NOTHING""",
                    (key, item_id, record.call_id, record.result_position, record.invocation_digest,
                     invocation, record.content, record.content_sha256,
                     str(record.invocation.get("tool", record.invocation.get("tool_name", ""))),
                     int(omitted), time.time(), seq))
            rows = self.connection.execute("""SELECT item_id,length(CAST(original AS BLOB))+length(CAST(invocation_snapshot AS BLOB)) AS bytes
                FROM adapter_targets WHERE scope_key=? ORDER BY seq DESC,item_id DESC""", (key,)).fetchall()
            size = 0
            for index, row in enumerate(rows):
                size += row["bytes"]
                if index >= MAX_TARGETS or size > MAX_TARGET_BYTES:
                    self.connection.execute("DELETE FROM adapter_targets WHERE scope_key=? AND item_id=?", (key, row["item_id"]))

    @_db_guarded
    def adapter_targets(self, scope):
        session = self.adapter_session(scope)
        if session is None:
            return []
        with self._lock:
            return [dict(row) for row in self.connection.execute("SELECT * FROM adapter_targets WHERE scope_key=? ORDER BY seq", (session["scope_key"],))]

    @_db_guarded
    def get_adapter_control(self, adapter_id: str):
        if not isinstance(adapter_id, str) or not adapter_id.strip():
            return None
        with self._lock:
            row = self.connection.execute(
                "SELECT * FROM adapter_control WHERE adapter_id=?",
                (adapter_id.strip(),),
            ).fetchone()
            if row is None:
                return None
            return {
                "adapter_id": str(row["adapter_id"]),
                "enabled": bool(row["enabled"]),
                "revision": int(row["revision"]),
                "updated_at": float(row["updated_at"]),
            }

    @_db_guarded
    def set_adapter_control(self, adapter_id: str, enabled: bool, *, now: float | None = None):
        # B1.1: ':' would create an unused row that shadows real sessions
        # (e.g. "acme:default" matching "acme:default:*" rows); reject it.
        if not isinstance(adapter_id, str) or not adapter_id.strip() or ":" in adapter_id:
            raise ValueError("invalid_adapter_registration")
        aid = adapter_id.strip()
        flag = bool(enabled)
        stamp = time.time() if now is None else float(now)
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                "SELECT revision FROM adapter_control WHERE adapter_id=?",
                (aid,),
            ).fetchone()
            revision = (int(row["revision"]) + 1) if row is not None else 1
            self.connection.execute(
                """INSERT INTO adapter_control(adapter_id, enabled, revision, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(adapter_id) DO UPDATE SET
                     enabled=excluded.enabled,
                     revision=excluded.revision,
                     updated_at=excluded.updated_at""",
                (aid, int(flag), revision, stamp),
            )
            # B1.2: LIKE is ASCII case-insensitive ("OMP" would match "omp:*"
            # rows). instr() compares case-sensitively, so adapter_id=? matches
            # exactly and instr(scope_key, ?)=1 matches only the "<id>:" prefix.
            match = (aid, f"{aid}:")
            if not flag:
                # B1.3: mark only the rows this call actually flips. Rows already
                # disabled for their own reasons (unsupported api_mode, pause)
                # keep no marker, so the next control-on leaves them disabled.
                for session_row in self.connection.execute(
                    "SELECT scope_key, enabled, capabilities FROM adapter_sessions"
                    " WHERE adapter_id=? OR instr(scope_key, ?)=1", match,
                ).fetchall():
                    if not session_row["enabled"]:
                        continue
                    caps = json.loads(session_row["capabilities"])
                    caps[CONTROL_DISABLED_MARKER] = True
                    self.connection.execute(
                        "UPDATE adapter_sessions SET enabled=?, capabilities=? WHERE scope_key=?",
                        (0, canonical(caps), session_row["scope_key"]),
                    )
            else:
                # B1.3: resurrect only rows the control-off path marked. Rows
                # disabled for their own reasons carry no marker and stay disabled.
                for session_row in self.connection.execute(
                    "SELECT scope_key, capabilities FROM adapter_sessions"
                    " WHERE adapter_id=? OR instr(scope_key, ?)=1", match,
                ).fetchall():
                    caps = json.loads(session_row["capabilities"])
                    if caps.get(CONTROL_DISABLED_MARKER) is not True:
                        continue
                    del caps[CONTROL_DISABLED_MARKER]
                    self.connection.execute(
                        "UPDATE adapter_sessions SET enabled=?, capabilities=? WHERE scope_key=?",
                        (1, canonical(caps), session_row["scope_key"]),
                    )
            return {
                "adapter_id": aid,
                "enabled": flag,
                "revision": revision,
                "updated_at": stamp,
            }

    getAdapterControl = get_adapter_control
    setAdapterControl = set_adapter_control
