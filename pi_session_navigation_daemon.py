"""OMP 전용 stdio RPC 데몬. 원본 메시지는 확장에서 소유한다."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import OrderedDict
from typing import Any

from session_navigation_hermes.factories import _make_configured_summarizer
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope, ToolResultRecord, compute_invocation_digest, compute_sha256
from session_navigation.store import _item_id

PROTOCOL = 2
MAX_SCOPES = 32
MAX_RECORDS = 64
MAX_BYTES = 4 * 1024 * 1024


class Daemon:
    def __init__(self) -> None:
        self.engine = SessionNavigationEngine()
        self.snapshots: OrderedDict[str, tuple[str, dict[str, ToolResultRecord]]] = OrderedDict()
        self.identities: OrderedDict[tuple[str, str, str], str] = OrderedDict()
        self.summarizer = self._summarizer()

    @staticmethod
    def _summarizer():
        try:
            settings = {
                "summary_mode": "llm",
                "base_url": os.environ.get("SESSION_NAVIGATION_BASE_URL", "").strip(),
                "model": os.environ.get("SESSION_NAVIGATION_MODEL", "").strip(),
                "timeout_seconds": min(int(os.environ.get("SESSION_NAVIGATION_TIMEOUT", "20")), 20),
                "max_input_bytes": int(os.environ.get("SESSION_NAVIGATION_MAX_INPUT_BYTES", "12288")),
                "max_output_tokens": int(os.environ.get("SESSION_NAVIGATION_MAX_OUTPUT_TOKENS", "384")),
            }
            if not settings["base_url"] or not settings["model"]:
                return None
            class Config:
                def get_config(self, key, default=None):
                    return settings.get(key, default)
            return _make_configured_summarizer(Config())
        except (ValueError, TypeError):
            return None

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        method = req.get("method")
        if method == "ping":
            return {"ok": True, "protocol": PROTOCOL}
        params = req.get("params")
        if not isinstance(params, dict):
            return {"ok": False, "error": "invalid_params"}
        session = params.get("session_id")
        if not isinstance(session, str) or not session or len(session) > 256 or ":" in session:
            return {"ok": False, "error": "invalid_session"}
        scope = Scope(adapter_id="pi", host_profile="default", session_id=session, branch_scope="unknown")
        if method == "prepare":
            self.snapshots.pop(session, None)
            token, records = params.get("snapshot_id"), params.get("records")
            if not isinstance(token, str) or not isinstance(records, list) or len(records) > MAX_RECORDS:
                return {"ok": False, "error": "invalid_snapshot"}
            selected: dict[str, ToolResultRecord] = {}
            total = 0
            for raw in records:
                if not isinstance(raw, dict):
                    return {"ok": False, "error": "invalid_record"}
                call_id, content, args = raw.get("call_id"), raw.get("content"), raw.get("arguments")
                if (not isinstance(call_id, str) or not call_id or call_id in selected
                    or not isinstance(content, str) or not isinstance(args, dict)
                    or set(args) != {"path"} or not isinstance(args["path"], str) or not args["path"].strip()
                    or raw.get("tool_name") != "read" or raw.get("status") != "ok"):
                    return {"ok": False, "error": "invalid_record"}
                total += len(content.encode("utf-8"))
                if total > MAX_BYTES:
                    return {"ok": False, "error": "snapshot_too_large"}
                invocation = {"tool_name": "read", "arguments": args}
                selected[call_id] = ToolResultRecord(call_id=call_id, content=content,
                    content_sha256=compute_sha256(content), invocation=invocation,
                    invocation_digest=compute_invocation_digest(invocation), status="ok")
            self.snapshots[session] = (token, selected)
            while len(self.snapshots) > MAX_SCOPES:
                self.snapshots.popitem(last=False)
            # Item identity includes call_id; never match plans by content hash alone.
            patches = []
            for record in selected.values():
                key = (session, record.call_id, record.content_sha256)
                if self.identities.get(key) != record.invocation_digest:
                    continue
                for plan in self.engine.project(scope, [record]):
                    patches.append({"call_id": record.call_id, "sha256": plan.expected_content_sha256,
                                    "text": plan.replacement_text})
            return {"ok": True, "patches": patches}
        if method in ("compact", "summarize"):
            snapshot = self.snapshots.get(session)
            if not snapshot or params.get("snapshot_id") != snapshot[0]:
                return {"ok": False, "error": "unconfirmed_snapshot"}
            record = snapshot[1].get(params.get("tool_call_id"))
            if record is None:
                return {"ok": False, "error": "not_found"}
            key = (session, record.call_id, record.content_sha256)
            if key not in self.identities and self.engine.store.get(scope, _item_id(scope.scope_key(), record.call_id, record.content_sha256)) is not None:
                return {"ok": False, "error": "identity_expired"}
            if key in self.identities and self.identities[key] != record.invocation_digest:
                return {"ok": False, "error": "invocation_conflict"}
            if method == "compact":
                result = self.engine.compact_sync(scope, record)
            elif self.summarizer is None:
                return {"ok": False, "error": "summarizer_unavailable"}
            else:
                result = asyncio.run(self.engine.summarize(scope, record, self.summarizer))
            if result.ok:
                self.identities[key] = record.invocation_digest
                self.identities.move_to_end(key)
                while len(self.identities) > 1024:
                    self.identities.popitem(last=False)
            return {"ok": result.ok, "error": result.error,
                    "item_id": result.plan.item_id if result.plan else None}
        if method == "list_items":
            return {"ok": True, "items": [item.to_dict() for item in self.engine.list_items(scope, params.get("query", ""))]}
        if method == "restore":
            result = self.engine.restore(scope, params.get("item_id", ""))
            return {"ok": result.ok, "error": result.error, "item_id": result.item.item_id if result.item else None}
        return {"ok": False, "error": "unknown_method"}


def main() -> None:
    daemon = Daemon()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid_request")
            response = daemon.handle(request)
            response["id"] = request.get("id")
        except Exception:
            response = {"ok": False, "error": "invalid_request"}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
