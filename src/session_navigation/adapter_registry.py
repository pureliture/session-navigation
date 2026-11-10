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
                    result["enabled"] = bool(result["enabled"])
                    return result
        return None

    def adapter_can(self, scope, capability: str) -> bool:
        row = self.adapter_session(scope)
        return bool(row and row["adapter_protocol"] == ADAPTER_PROTOCOL_VERSION and
                    row["enabled"] and row["capabilities"].get(capability) is True)

    def register_adapter(self, scope, *, adapter_id: str, instance_id: str,
                         capabilities: dict, enabled: bool = True,
                         adapter_protocol: int = ADAPTER_PROTOCOL_VERSION, now: float | None = None) -> bool:
        key = scope.scope_key() if hasattr(scope, "scope_key") else str(scope)
        if not instance_id or key.split(":", 1)[0] != adapter_id:
            raise ValueError("invalid_adapter_registration")
        caps = canonical({name: capabilities.get(name) is True for name in ("hide", "summarize", "unhide")})
        stamp = time.time() if now is None else now
        with self._lock, self.connection:
            row = self.connection.execute("SELECT * FROM adapter_sessions WHERE scope_key=?", (key,)).fetchone()
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
