"""Durable adapter capabilities and bounded, verified target publication."""
from __future__ import annotations

import json
import time

from .db import ADAPTER_PROTOCOL_VERSION
from .model import _item_id, canonical, compute_invocation_digest

HEARTBEAT_SECONDS = 300
MAX_TARGETS = 256
MAX_TARGET_BYTES = 4 * 1024 * 1024


def scope_aliases(scope_key: str, aliases: dict[str, tuple[str, ...]]) -> tuple[str, ...]:
    """Exact scope wins; the owning host supplies discovery-only branch aliases."""
    parts = scope_key.split(":")
    if len(parts) == 4 and parts[3] in aliases.get(parts[0], ()):
        return (scope_key, *(":".join([*parts[:3], branch]) for branch in aliases[parts[0]] if branch != parts[3]))
    return (scope_key,)


class AdapterRegistryMixin:
    def adapter_session(self, scope):
        """Resolve an exact registration, then host-configured branch aliases."""
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        with self._lock:
            for candidate in scope_aliases(key, self.scope_aliases):
                row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (candidate,)).fetchone()
                if row is not None:
                    result = dict(row)
                    result["capabilities"] = json.loads(result["capabilities"])
                    linkage = result["capabilities"].get("linkage", {})
                    result.update({name: linkage.get(name) for name in ("parent_scope", "tool_call_id", "subagent_id")})
                    result["enabled"] = bool(result["enabled"])
                    return result
        return None

    def child_scopes(self, parent_scope: str):
        with self._lock:
            rows = self.connection.execute("SELECT scope_key FROM adapter_sessions ORDER BY scope_key").fetchall()
            return [row for key in rows if (row := self.adapter_session(key[0]))["parent_scope"] == parent_scope]

    def adapter_can(self, scope, capability: str) -> bool:
        row = self.adapter_session(scope)
        return bool(row and row["adapter_protocol"] == ADAPTER_PROTOCOL_VERSION and
                    row["enabled"] and row["capabilities"].get(capability) is True)

    def link_children(self, parent_scope: str, tool_call_id: str, subagent_ids: list[str]) -> None:
        if not tool_call_id or any(not isinstance(value, str) or not value for value in subagent_ids):
            raise ValueError("invalid_adapter_registration")
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            parent = self.adapter_session(parent_scope)
            if parent is None:
                raise ValueError("adapter_not_detected")
            caps = parent["capabilities"]
            pending = dict(caps.get("pending_children", {}))
            for subagent in subagent_ids:
                children = [row for row in self.child_scopes(parent_scope) if row["subagent_id"] == subagent]
                if not children:
                    pending[subagent] = tool_call_id
                for child in children:
                    packed = child["capabilities"]
                    packed["linkage"] = dict(parent_scope=parent_scope, subagent_id=subagent, tool_call_id=tool_call_id)
                    self.connection.execute("UPDATE adapter_sessions SET capabilities=? WHERE scope_key=?", (canonical(packed), child["scope_key"]))
            if pending:
                caps["pending_children"] = pending
            self.connection.execute("UPDATE adapter_sessions SET capabilities=? WHERE scope_key=?", (canonical(caps), parent_scope))

    def register_adapter(self, scope, *, adapter_id: str, instance_id: str,
                         capabilities: dict, enabled: bool = True,
                         adapter_protocol: int = ADAPTER_PROTOCOL_VERSION, now: float | None = None,
                         parent_scope: str | None = None, tool_call_id: str | None = None,
                         subagent_id: str | None = None) -> bool:
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        if not instance_id or key.split(":", 1)[0] != adapter_id:
            raise ValueError("invalid_adapter_registration")
        packed = {name: capabilities.get(name) is True for name in ("hide", "summarize", "unhide")}
        if any(value is not None and (not isinstance(value, str) or not value or len(value) > 1024)
               for value in (parent_scope, tool_call_id, subagent_id)):
            raise ValueError("invalid_adapter_registration")
        if parent_scope == key or (parent_scope and len(parent_scope.split(":")) != 4):
            raise ValueError("invalid_adapter_registration")
        stamp = time.time() if now is None else now
        with self._lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (key,)).fetchone()
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
            if parent:
                packed["linkage"] = dict(parent_scope=parent,
                    tool_call_id=tool_call_id or prior.get("tool_call_id") or pending_call,
                    subagent_id=subagent)
            caps = canonical(packed)
            values = (adapter_id, adapter_protocol, caps, int(enabled), instance_id)
            if row is not None and tuple(row[k] for k in ("adapter_id", "adapter_protocol", "capabilities", "enabled", "instance_id")) == values and stamp - row["last_seen"] < HEARTBEAT_SECONDS:
                return False
            self.connection.execute("""INSERT INTO adapter_sessions VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(scope_key) DO UPDATE SET adapter_id=excluded.adapter_id,
                adapter_protocol=excluded.adapter_protocol,capabilities=excluded.capabilities,
                enabled=excluded.enabled,instance_id=excluded.instance_id,last_seen=excluded.last_seen""",
                (key, *values, stamp))
            return True

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

    def adapter_targets(self, scope):
        session = self.adapter_session(scope)
        if session is None:
            return []
        with self._lock:
            return [dict(row) for row in self.connection.execute("SELECT * FROM adapter_targets WHERE scope_key=? ORDER BY seq", (session["scope_key"],))]
