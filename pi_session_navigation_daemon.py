"""Stdio JSON-RPC daemon exposing session-navigation to the pi/omp extension."""
from __future__ import annotations

import json
import sys
from typing import Any

from adapters.hermes.handlers import (
    compact as _engine_compact,
    list_records as _engine_list,
    middleware_step as _engine_step,
    summarize as _engine_summarize,
    restore as _engine_restore,
)
from adapters.hermes.factories import _make_configured_summarizer
from adapters.hermes.session import SessionTranscriptStore
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import Scope

BRANCH_SCOPE = "unknown"


def _scope(scope_key: str) -> Scope:
    # scope_key format: adapter:profile:session:branch
    parts = scope_key.split(":", 3)
    adapter = parts[0] if len(parts) > 0 else "pi"
    profile = parts[1] if len(parts) > 1 else "default"
    session = parts[2] if len(parts) > 2 else "default"
    branch = parts[3] if len(parts) > 3 else BRANCH_SCOPE
    return Scope(adapter_id=adapter, host_profile=profile, session_id=session, branch_scope=branch)


class Daemon:
    def __init__(self) -> None:
        self.engines: dict[str, SessionNavigationEngine] = {}
        self.stores: dict[str, SessionTranscriptStore] = {}
        self.summarizers: dict[str, Any] = {}
        self._default_summarizer = self._build_summarizer_from_env()

    @staticmethod
    def _build_summarizer_from_env():
        import os
        base_url = os.environ.get("SESSION_NAVIGATION_BASE_URL", "").strip()
        model = os.environ.get("SESSION_NAVIGATION_MODEL", "").strip()
        if not base_url or not model:
            return None
        try:
            timeout = int(os.environ.get("SESSION_NAVIGATION_TIMEOUT", "60"))
            max_input = int(os.environ.get("SESSION_NAVIGATION_MAX_INPUT_BYTES", "12288"))
            max_output = int(os.environ.get("SESSION_NAVIGATION_MAX_OUTPUT_TOKENS", "384"))
        except ValueError:
            return None
        try:
            from adapters.hermes.factories import _make_configured_summarizer
            # reuse factory by faking ctx
            class _Ctx:
                def get_config(self, key, default=None):
                    mapping = {
                        "summary_mode": "llm",
                        "base_url": base_url,
                        "model": model,
                        "timeout_seconds": timeout,
                        "max_input_bytes": max_input,
                        "max_output_tokens": max_output,
                    }
                    return mapping.get(key, default)
            return _make_configured_summarizer(_Ctx())
        except Exception:
            return None

    def _state(self, scope_key: str):
        if scope_key not in self.engines:
            self.engines[scope_key] = SessionNavigationEngine()
            self.stores[scope_key] = SessionTranscriptStore()
            self.summarizers[scope_key] = self._default_summarizer
        return self.engines[scope_key], self.stores[scope_key], self.summarizers[scope_key]

    def handle(self, req: dict[str, Any]) -> dict[str, Any]:
        method = req.get("method")
        params = req.get("params") or {}
        try:
            if method == "transform_context":
                scope_key = params["scope_key"]
                messages = params["messages"]
                engine, store, _ = self._state(scope_key)
                scope = _scope(scope_key)
                payload = {"messages": messages}
                step = _engine_step(engine, store, scope, "chat_completions", payload)
                return {"ok": True, "messages": step["request"].get("messages", messages),
                        "applied": step.get("applied", []), "skipped": step.get("skipped", []),
                        "reason": step.get("trace", {}).get("reason", "")}
            if method == "compact":
                scope_key = params["scope_key"]
                engine, store, _ = self._state(scope_key)
                scope = _scope(scope_key)
                res = _engine_compact(engine, store, scope, params["tool_call_id"])
                return {"ok": res.ok, "item_id": getattr(res.plan, "item_id", None) if res.plan else None,
                        "error": res.error}
            if method == "summarize":
                scope_key = params["scope_key"]
                engine, store, summ = self._state(scope_key)
                scope = _scope(scope_key)
                if summ is None:
                    return {"ok": False, "error": "summarizer_unavailable"}
                res = _engine_summarize(engine, store, scope, params["tool_call_id"], summ)
                return {"ok": res.ok, "item_id": getattr(res.plan, "item_id", None) if res.plan else None,
                        "error": res.error}
            if method == "restore":
                scope_key = params["scope_key"]
                engine, store, _ = self._state(scope_key)
                scope = _scope(scope_key)
                res = _engine_restore(engine, scope, params["item_id"])
                return {"ok": res.ok, "item_id": getattr(res.item, "item_id", None) if res.item else None,
                        "error": res.error}
            if method == "list_items":
                scope_key = params["scope_key"]
                engine, store, _ = self._state(scope_key)
                scope = _scope(scope_key)
                items = _engine_list(engine, scope, params.get("query", ""))
                return {"ok": True, "items": items}
            if method == "ping":
                return {"ok": True, "pong": True}
            return {"ok": False, "error": f"unknown_method:{method}"}
        except Exception as exc:
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def main() -> None:
    daemon = Daemon()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            out.write(json.dumps({"ok": False, "error": f"json_error: {exc}"}) + "\n")
            out.flush()
            continue
        resp = daemon.handle(req)
        resp.setdefault("id", req.get("id"))
        out.write(json.dumps(resp) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
