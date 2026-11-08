"""JSON command-line interface for session-navigation state management."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from session_navigation.db import DBError, DBFullError, db_info, resolve_path
from session_navigation.sqlite_store import SQLiteContextStore


def _print(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str))


def _store(path: str | None) -> SQLiteContextStore:
    return SQLiteContextStore(path)


def _scope_arg(value: str) -> str:
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="session-navigation")
    sub = parser.add_subparsers(dest="command", required=True)

    p_db = sub.add_parser("db-info")
    p_db.add_argument("--path", default=None)

    p_list = sub.add_parser("list")
    p_list.add_argument("--scope", required=True)
    p_list.add_argument("--query", default="")
    p_list.add_argument("--path", default=None)

    p_hide = sub.add_parser("hide")
    p_hide.add_argument("--scope", required=True)
    p_hide.add_argument("--item-id", required=True)
    p_hide.add_argument("--expected-version", type=int, default=None)
    p_hide.add_argument("--path", default=None)

    p_unhide = sub.add_parser("unhide")
    p_unhide.add_argument("--scope", required=True)
    p_unhide.add_argument("--item-id", required=True)
    p_unhide.add_argument("--expected-version", type=int, default=None)
    p_unhide.add_argument("--path", default=None)

    p_manage = sub.add_parser("manage")
    p_manage.add_argument("--scope", required=True)
    p_manage.add_argument("--action", default="auto", choices=["auto", "hide", "summarize"])
    p_manage.add_argument("--max-items", type=int, default=20)
    p_manage.add_argument("--path", default=None)

    p_fork = sub.add_parser("fork-scope")
    p_fork.add_argument("src")
    p_fork.add_argument("dst")
    p_fork.add_argument("--path", default=None)

    p_rec = sub.add_parser("record-usage")
    p_rec.add_argument("--scope", required=True)
    p_rec.add_argument("--call-key", required=True)
    p_rec.add_argument("--prompt-tokens", type=int, default=0)
    p_rec.add_argument("--completion-tokens", type=int, default=0)
    p_rec.add_argument("--total-tokens", type=int, default=0)
    p_rec.add_argument("--cost-usd", type=float, default=0.0)
    p_rec.add_argument("--path", default=None)

    args = parser.parse_args(argv)

    try:
        if args.command == "db-info":
            _print(db_info(args.path))
            return 0

        if args.command == "list":
            store = _store(args.path)
            try:
                items = store.items(args.scope)
                out = []
                for it in items:
                    if args.query and args.query.lower() not in (it.compacted or "").lower() and args.query.lower() not in it.item_id.lower():
                        continue
                    out.append({
                        "item_id": it.item_id,
                        "tool_call_id": it.tool_call_id,
                        "visibility": it.visibility,
                        "version": it.version,
                        "compaction_source": it.compaction_source,
                    })
                _print({"ok": True, "items": out})
                return 0
            finally:
                store.close()

        if args.command == "hide":
            store = _store(args.path)
            try:
                item = store.get(args.scope, args.item_id)
                if item is None:
                    _print({"ok": False, "error": "not_found"})
                    return 2
                if item.visibility == "hidden":
                    _print({"ok": True, "item_id": item.item_id, "visibility": "hidden", "version": item.version})
                    return 0
                # mark hidden by updating visibility/version
                from dataclasses import replace
                updated = replace(item, visibility="hidden", version=item.version + 1)
                res = store.put(args.scope, updated, expected_version=args.expected_version if args.expected_version is not None else item.version)
                if not res.ok:
                    if res.error == "version_conflict":
                        _print({"ok": False, "error": "version_conflict", "item": res.item.__dict__ if res.item else None})
                        return 4
                    _print({"ok": False, "error": res.error})
                    return 3 if res.error in ("db_error", "db_full") else 2
                _print({"ok": True, "item_id": res.item.item_id, "visibility": "hidden", "version": res.item.version})
                return 0
            finally:
                store.close()

        if args.command == "unhide":
            store = _store(args.path)
            try:
                res = store.restore(args.scope, args.item_id, expected_version=args.expected_version)
                if not res.ok:
                    if res.error == "version_conflict":
                        _print({"ok": False, "error": "version_conflict", "item": res.item.__dict__ if res.item else None})
                        return 4
                    _print({"ok": False, "error": res.error})
                    return 3 if res.error in ("db_error", "db_full") else 2
                _print({"ok": True, "item_id": res.item.item_id, "visibility": res.item.visibility, "version": res.item.version})
                return 0
            finally:
                store.close()

        if args.command == "manage":
            store = _store(args.path)
            try:
                from dataclasses import replace as _replace
                action = args.action
                max_items = max(1, min(int(args.max_items), 64))
                if action == "summarize":
                    _print({"ok": False, "error": "summarizer_unavailable"})
                    return 2
                # CLI/Paseo have no session model: auto/hide == rule re-hide of visible rows.
                items_out: list[dict[str, Any]] = []
                targets = [it for it in store.items(args.scope) if it.visibility == "visible"][:max_items]
                for item in targets:
                    flipped = _replace(item, visibility="hidden", version=item.version + 1)
                    res = store.put(args.scope, flipped, expected_version=item.version)
                    if res.ok and res.item is not None:
                        items_out.append({"tool_call_id": item.tool_call_id, "ok": True, "item_id": res.item.item_id})
                    else:
                        items_out.append({"tool_call_id": item.tool_call_id, "ok": False,
                                          "error": res.error or "not_found"})
                applied = sum(1 for r in items_out if r["ok"])
                _print({"ok": all(r["ok"] for r in items_out), "applied": applied,
                        "failed": len(items_out) - applied, "items": items_out})
                return 0
            finally:
                store.close()

        if args.command == "fork-scope":
            store = _store(args.path)
            try:
                counts = store.fork_scope(args.src, args.dst)
                _print({"ok": True, "counts": counts.to_dict()})
                return 0
            finally:
                store.close()

        if args.command == "record-usage":
            store = _store(args.path)
            try:
                store.record_call(
                    args.scope,
                    args.call_key,
                    prompt_tokens=args.prompt_tokens,
                    completion_tokens=args.completion_tokens,
                    total_tokens=args.total_tokens,
                    cost_usd=args.cost_usd,
                )
                _print({"ok": True})
                return 0
            except (DBError, DBFullError) as exc:
                _print({"ok": False, "error": getattr(exc, "code", "db_error")})
                return 3
            finally:
                store.close()

    except (DBError, DBFullError) as exc:
        _print({"ok": False, "error": getattr(exc, "code", "db_error")})
        return 3
    except SystemExit:
        raise
    except Exception as exc:
        _print({"ok": False, "error": str(exc)})
        return 2

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
