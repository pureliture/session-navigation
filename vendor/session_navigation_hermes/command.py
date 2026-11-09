"""Text fallback slash command for Hermes session-navigation (no TUI host needed)."""

from __future__ import annotations

import json
import os
from typing import Any

COMMAND_NAME = "nav"
DESCRIPTION = "List session-navigation rows and run hide/unhide/manage fallbacks."
ARGS_HINT = "hide <id> | unhide <id> | manage"


def _resolve_state(first: Any, *rest: Any, **kwargs: Any) -> Any:
    if hasattr(first, "store") and hasattr(first, "engine"):
        return first
    if hasattr(first, "state") and hasattr(first.state, "store"):
        return first.state
    if hasattr(first, "_state") and hasattr(first._state, "store"):
        return first._state
    if hasattr(first, "session_nav_state"):
        return first.session_nav_state
    resolver = getattr(first, "get_session_nav_state", None)
    if callable(resolver):
        try:
            return resolver()
        except Exception:
            pass
    for value in rest:
        if hasattr(value, "store") and hasattr(value, "engine"):
            return value
    state = kwargs.get("state")
    if state is not None and hasattr(state, "store"):
        return state
    state = kwargs.get("ctx")
    if state is not None and hasattr(state, "store"):
        return state
    return None


def _session_id(state: Any, raw_args: str, kwargs: dict[str, Any]) -> str:
    for key in ("session_id", "session", "sid"):
        value = kwargs.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    if state is not None and isinstance(getattr(state, "session_id", None), str) and state.session_id.strip():
        return state.session_id.strip()
    scope = getattr(state, "scope", None) if state is not None else None
    if scope is not None:
        value = getattr(scope, "session_id", None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    env = os.environ.get("HERMES_SESSION_ID") or os.environ.get("SESSION_ID")
    if isinstance(env, str) and env.strip():
        return env.strip()
    parts = str(raw_args or "").split()
    if parts and parts[0] not in {"list", "hide", "unhide", "restore", "rehide", "manage", "summarize", "messages", "hide-msg", "unhide-msg"}:
        return parts[0]
    return ""


def _call_tool(state: Any, name: str, args: Any, session_id: str) -> dict[str, Any]:
    tools = getattr(state, "tools", None) if state is not None else None
    if tools is None and state is not None:
        ctx = getattr(state, "ctx", None)
        if ctx is not None:
            tools = getattr(ctx, "tools", None)
    handler = None
    if isinstance(tools, dict):
        entry = tools.get(name)
        if isinstance(entry, dict):
            handler = entry.get("handler")
    if handler is None and state is not None:
        try:
            from . import factories as _factories
            maker = {
                "hide_context": _factories.make_hide_handler,
                "summarize_context": _factories.make_summarize_handler,
                "list_context_items": _factories.make_list_handler,
                "unhide_context": _factories.make_unhide_handler,
                "manage_context": _factories.make_manage_handler,
            }.get(name)
            if callable(maker):
                handler = maker(state)
        except Exception:
            handler = None
    if not callable(handler):
        return {"ok": False, "error": "handler_unavailable"}
    try:
        raw = handler(args, session_id=session_id)
    except TypeError:
        try:
            raw = handler(args, session_id=session_id)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"ok": True, "message": raw}
    if isinstance(raw, dict):
        return raw
    return {"ok": False, "error": "invalid_handler_result"}


def _rows_from_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    items = result.get("items")
    if isinstance(items, list):
        return [x for x in items if isinstance(x, dict)]
    return []


def _format_row(num: int, item: dict[str, Any]) -> str:
    status = str(item.get("status") or item.get("visibility") or "unknown")
    call_id = str(item.get("tool_call_id") or item.get("call_id") or item.get("call") or "—")
    item_id = str(item.get("item_id") or "—")
    tokens = item.get("tokens_display")
    if tokens is None:
        tokens = "—"
    cost = item.get("cost_usd", item.get("cost"))
    if cost is None:
        cost = "—"
    version = item.get("version", "—")
    pill = "[" + status + "]"
    return f"{num:>3} {pill:<10} {call_id:<22} {item_id:<22} tokens={tokens} cost={cost} version={version}"


def _list_text(state: Any, session_id: str) -> str:
    if not session_id:
        lines = ["Session navigation items (0) [session=—]:"]
        lines.append("status      tool/call id            tokens (실측 배분) cost  version")
        lines.append("(none)")
        lines.append("Hints: /nav hide <id> | /nav unhide <id> | /nav manage | /nav summarize <id>")
        return "\n".join(lines)
    result = _call_tool(state, "list_context_items", {}, session_id)
    if not result.get("ok", False):
        err = result.get("error", "unknown_error")
        if err == "db_error":
            choices = result.get("choices") or ["abort_request", "send_original"]
            return "Session navigation: DB error (" + err + "); choices: " + ", ".join(choices)
        return "Session navigation: " + str(err)
    rows = _rows_from_result(result)
    lines = ["Session navigation items (" + str(len(rows)) + ") [session=" + (session_id or "—") + "]:"]
    lines.append("  N [status]   tool/call id           item_id                tokens cost version")
    if rows:
        for num, item in enumerate(rows, 1):
            lines.append(_format_row(num, item))
    else:
        lines.append("(none)")
    lines.append("Hints: /nav hide <id> | /nav unhide <id> | /nav manage | /nav summarize <id>")
    return "\n".join(lines)


def _message_rows(state: Any, session_id: str) -> tuple[Any, list[dict[str, Any]]]:
    from .factories import scope_for

    scope = scope_for(state, session_id) if session_id else None
    if scope is None:
        return None, []

    def order(unit: dict[str, Any]) -> int:
        parts = str(unit["unit_id"]).split(":")
        position = parts[2][1:] if len(parts) > 2 else ""
        return int(position) if position.isdigit() else 0

    units = [u for u in state.engine.store.list_units(scope) if u.get("kind") in ("user", "assistant")]
    return scope, sorted(units, key=order)


def _messages_text(state: Any, session_id: str) -> str:
    _scope, rows = _message_rows(state, session_id)
    lines = ["Prompts/responses (" + str(len(rows)) + ") [session=" + (session_id or "—") + "]:"]
    for num, unit in enumerate(rows, 1):
        status = "hidden" if unit.get("visibility") == "hidden" else "visible"
        lines.append(f"{num:>3} [{status:<7}] {unit.get('kind', ''):<9} {unit.get('char_count', 0)} chars "
                     f"v{unit.get('version', 1)} {unit['unit_id']}")
    if not rows:
        lines.append("(none)")
    lines.append("Hints: /nav hide-msg <N> | /nav unhide-msg <N>  (prompts/responses support hide only)")
    return "\n".join(lines)


def _toggle_message(state: Any, session_id: str, target: str, hide: bool) -> str:
    scope, rows = _message_rows(state, session_id)
    unit = None
    if target.isdigit() and 0 < int(target) <= len(rows):
        unit = rows[int(target) - 1]
    else:
        unit = next((u for u in rows if u["unit_id"] == target), None)
    if scope is None or unit is None:
        return ("Hide" if hide else "Unhide") + " failed: not_found"
    result = state.engine.store.set_message_visibility(
        scope, unit["unit_id"], kind=unit["kind"], content_sha256=unit.get("content_sha256") or "",
        char_count=int(unit.get("char_count") or 0), visibility="hidden" if hide else "visible",
        expected_version=int(unit.get("version") or 1))
    if not result.get("ok"):
        return ("Hide" if hide else "Unhide") + " failed: " + str(result.get("error"))
    if (unit.get("visibility") == "hidden") != hide:
        tokens = state.usage.message_tokens(session_id, unit)
        state.usage.adjust(session_id, tokens if hide else -tokens)
    return ("Hidden " if hide else "Unhidden ") + unit["unit_id"] + " (v" + str(result.get("version")) + ")"


def nav_command(first: Any = None, raw_args: Any = "", *rest: Any, **kwargs: Any) -> str:
    if isinstance(first, str) and raw_args in ("", None) and "state" not in kwargs and not hasattr(first, "store"):
        raw_args = first
        first = kwargs.get("state") or kwargs.get("ctx")
    state = _resolve_state(first, *rest, **kwargs)
    if state is None:
        state = _resolve_state(kwargs.get("ctx"), kwargs.get("state"))
    text = "" if raw_args is None else str(raw_args)
    parts = text.split()
    session_id = _session_id(state, text, kwargs)

    verb = parts[0].lower() if parts else "list"
    if verb not in {"list", "hide", "unhide", "restore", "rehide", "manage", "summarize", "messages", "hide-msg", "unhide-msg"} and session_id == verb:
        parts = parts[1:]
        verb = parts[0].lower() if parts else "list"

    if state is None:
        return "Session navigation: no state available.\nHints: /nav hide <id> | /nav unhide <id> | /nav manage"

    if verb in ("", "list", "ls"):
        return _list_text(state, session_id) + "\n" + state.usage.footer(session_id)

    if verb == "messages":
        return _messages_text(state, session_id) + "\n" + state.usage.footer(session_id)

    if verb in ("hide-msg", "unhide-msg"):
        if not state.is_enabled():
            return "Session navigation: disabled"
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "Usage: /nav " + verb + " <N|message id>"
        return _toggle_message(state, session_id, target, verb == "hide-msg")

    if verb == "hide":
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "Usage: /nav hide <tool_call_id>"
        result = _call_tool(state, "hide_context", {"tool_call_id": target}, session_id)
        if result.get("ok"):
            return "Hidden " + target + " -> " + str(result.get("item_id")) + " (v" + str(result.get("visibility_version")) + ")"
        err = result.get("error", "unknown_error")
        if err == "db_error":
            return "Hidden failed: db_error; choices: " + ", ".join(result.get("choices", ["abort_request", "send_original"]))
        return "Hidden failed: " + str(err)

    if verb in ("unhide", "restore", "reveal"):
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "Usage: /nav unhide <N|item_id>"
        listed = _call_tool(state, "list_context_items", {}, session_id)
        rows = _rows_from_result(listed)
        # Accept the displayed row number or the item_id; always CAS on the listed version.
        resolved = target
        version = None
        if target.isdigit():
            idx = int(target) - 1
            if 0 <= idx < len(rows) and rows[idx].get("item_id"):
                resolved = str(rows[idx]["item_id"])
                version = rows[idx].get("version")
        else:
            for row in rows:
                if str(row.get("item_id")) == target:
                    version = row.get("version")
                    break
        args: dict[str, Any] = {"item_id": resolved}
        if isinstance(version, int):
            args["expected_version"] = version
        result = _call_tool(state, "unhide_context", args, session_id)
        if result.get("ok"):
            return "Unhidden " + str(result.get("item_id")) + " (v" + str(result.get("visibility_version")) + ")"
        err = result.get("error", "unknown_error")
        if err == "version_conflict":
            return "Unhide stale (version_conflict); refreshed list:\n" + _list_text(state, session_id)
        if err == "db_error":
            return "Unhide failed: db_error; choices: " + ", ".join(result.get("choices", ["abort_request", "send_original"]))
        return "Unhide failed: " + str(err)

    if verb == "rehide":
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "Usage: /nav rehide <N|tool_call_id>"
        listed = _call_tool(state, "list_context_items", {}, session_id)
        rows = _rows_from_result(listed)
        resolved = target
        if target.isdigit():
            idx = int(target) - 1
            if 0 <= idx < len(rows):
                resolved = str(rows[idx].get("tool_call_id") or rows[idx].get("call_id") or target)
        result = _call_tool(state, "hide_context", {"tool_call_id": resolved}, session_id)
        if result.get("ok"):
            return "Re-hidden " + resolved + " -> " + str(result.get("item_id")) + " (v" + str(result.get("visibility_version")) + ")"
        return "Re-hide failed: " + str(result.get("error", "unknown_error"))

    if verb == "summarize":
        target = parts[1] if len(parts) > 1 else ""
        if not target:
            return "Usage: /nav summarize <tool_call_id>"
        result = _call_tool(state, "summarize_context", {"tool_call_id": target}, session_id)
        if result.get("ok"):
            return "Summarized " + target + " -> " + str(result.get("item_id")) + " (v" + str(result.get("visibility_version")) + ")"
        err = result.get("error", "unknown_error")
        if err == "summarizer_unavailable":
            return "Summarizer unavailable (session model required)."
        if err == "db_error":
            return "Summarize failed: db_error; choices: " + ", ".join(result.get("choices", ["abort_request", "send_original"]))
        return "Summarize failed: " + str(err)

    if verb == "manage":
        action = parts[1] if len(parts) > 1 and parts[1] in ("auto", "hide", "summarize") else "auto"
        start = 2 if len(parts) > 1 and parts[1] == action else 1
        params = {"action": action, "tool_call_ids": parts[start:]}
        result = _call_tool(state, "manage_context", params, session_id)
        err = result.get("error")
        if err:
            if err == "db_error":
                return "Manage failed: db_error; choices: " + ", ".join(result.get("choices", ["abort_request", "send_original"]))
            return "Manage failed: " + str(err)
        applied = result.get("applied", 0)
        failed = result.get("failed", 0)
        return "Managed: applied=" + str(applied) + " failed=" + str(failed)

    return (
        "Usage: /nav [list|hide <id>|unhide <id>|rehide <id>|summarize <id>|manage [auto|hide|summarize] <ids...>]\n"
        "Hints: /nav hide <id> | /nav unhide <id> | /nav manage"
    )


handle = nav_command
run = nav_command
execute = nav_command
fallback = nav_command
text_fallback = nav_command
list_rows = nav_command


def register(ctx: Any, state: Any = None, **kwargs: Any) -> Any:
    if state is None:
        state = _resolve_state(ctx, kwargs.get("state"))
    if ctx is None:
        return None
    register_command = getattr(ctx, "register_command", None)
    if not callable(register_command):
        return None
    def handler(raw_args="", **session_context):
        return nav_command(state, raw_args, **session_context)
    if state is not None:
        try:
            state.ctx = ctx
            if not hasattr(state, "tools"):
                state.tools = getattr(ctx, "tools", {})
            else:
                state.tools = getattr(ctx, "tools", state.tools)
        except Exception:
            pass

    try:
        return register_command(COMMAND_NAME, handler, description=DESCRIPTION, args_hint=ARGS_HINT)
    except TypeError:
        try:
            return register_command(COMMAND_NAME, handler, DESCRIPTION, ARGS_HINT)
        except TypeError:
            return register_command(COMMAND_NAME, handler)


register_nav_command = register
register_nav = register
register_command = register
