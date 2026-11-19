"""Hermes adapter tool allowlist (M2-2).

Adapter-owned tool rules. The engine never sees host tool names here;
it only receives the filtered invocation. Order, duplicate, secret, and
size checks stay in the engine policy. This module only decides which
tools and arguments the Hermes adapter accepts.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

INTERNAL_TOOLS = ("hide_context", "summarize_context", "list_context_items", "unhide_context", "manage_context")

FIELDS: dict[str, set[str]] = {
    "terminal": {"command", "workdir"},
    "read_file": {"path", "offset", "limit"},
    "search_files": {"pattern", "target", "path", "file_glob"},
    "web_search": {"query"},
    "web_extract": {"url", "urls"},
    "execute_code": {"code", "language"},
    "vision_analyze": {"image_path", "path", "url"},
    "skill_view": {"name"},
    "tool_describe": {"name", "names"},
    "browser_snapshot": {"browserId", "selector", "tabId", "tab_id", "url"},
    "browser_console": {"browserId", "tabId", "tab_id"},
    "browser_logs": {"browserId", "tabId", "tab_id"},
    "browser_vision": {"browserId", "prompt", "question", "selector", "tabId", "tab_id", "url"},
    "browser_list_tabs": {"browserId"},
    "get_agent_activity": {"agentId", "agent_id", "id"},
    "get_agent_status": {"agentId", "agent_id", "id"},
    "list_agents": {"cwd", "serverId", "server_id"},
    "list_workspaces": {"cwd", "serverId", "server_id"},
    "list_hosts": {"cwd", "serverId", "server_id"},
    "list_models": {"provider", "serverId", "server_id"},
    "list_providers": {"cwd", "serverId", "server_id"},
    "list_profiles": {"cwd", "serverId", "server_id"},
    "inspect_provider": {"provider", "serverId", "server_id"},
    "list_terminals": {"cwd", "serverId", "server_id"},
    "capture_terminal": {"id", "terminalId", "terminal_id"},
    "list_schedules": {"cwd", "serverId", "server_id"},
    "inspect_schedule": {"id", "scheduleId", "schedule_id"},
    "schedule_logs": {"id", "scheduleId", "schedule_id"},
    "memory_authority_pack_read": {"id", "key", "pack_id", "path", "query", "scope", "topic"},
    "brain_memory_search": {"id", "key", "namespace", "path", "query", "scope", "topic"},
    "brain_context_resolve": {"context_id", "id", "key", "namespace", "path", "query", "scope", "topic"},
}

ALLOWED_TOOLS = tuple(FIELDS)

DEFAULTS: dict[str, dict[str, Any]] = {
    "terminal": {
        "background": False,
        "pty": False,
        "persist_on_release": False,
        "heartbeat": 0,
        "notify": False,
    },
    "read_file": {},
    "search_files": {
        "limit": 50,
        "offset": 0,
        "order": "discovery",
        "output_mode": "content",
        "context": 0,
        "case_insensitive": False,
    },
}

REQUIRED: dict[str, str] = {
    "terminal": "command",
    "read_file": "path",
    "search_files": "pattern",
    "web_search": "query",
    "execute_code": "code",
    "skill_view": "name",
}

_TERMINAL_BLOCKED_TRUTHY_OPTIONS = ("background", "pty", "persist_on_release", "notify")
_INT_OR_STR_ID_KEYS = {
    "id",
    "tabId",
    "tab_id",
    "scheduleId",
    "schedule_id",
    "terminalId",
    "terminal_id",
}
_MCP_READ_PATTERN = re.compile(
    r"(?:^|_)(?:read|get|list|search|query|inspect|resolve|fetch)(?:$|_)",
    re.IGNORECASE,
)


def _reject_json_constant(value: str) -> Any:
    raise ValueError(f"invalid JSON constant: {value}")


def _is_mcp_read_tool(name: str) -> bool:
    return name.startswith("mcp_") and bool(_MCP_READ_PATTERN.search(name))


def _is_valid_json(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str)):
        return True
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_valid_json(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(k, str) and _is_valid_json(v) for k, v in value.items())
    return False


def _canonicalize_json(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _canonicalize_json(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [_canonicalize_json(item) for item in value]
    return value


class AdapterRejected(Exception):
    """Adapter-level invocation refusal carrying a contract error code."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def parse_raw_arguments(raw: Any) -> dict[str, Any]:
    """Coerce raw tool arguments to a dict or raise invalid_invocation."""
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw, parse_constant=_reject_json_constant) if raw.strip() else {}
        except ValueError:
            raise AdapterRejected("invalid_invocation") from None
        if not isinstance(parsed, dict):
            raise AdapterRejected("invalid_invocation")
        return parsed
    raise AdapterRejected("invalid_invocation")


def filter_invocation(
    tool_name: Any, raw_args: Any
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Filter a tool call to the engine invocation shape.

    Returns (invocation, omitted_options). Raises AdapterRejected with one
    of: invalid_invocation, internal_target, unsupported_tool,
    unsupported_arguments.
    """
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise AdapterRejected("invalid_invocation")
    name = tool_name.strip()
    if name in INTERNAL_TOOLS:
        raise AdapterRejected("internal_target")
    is_mcp = _is_mcp_read_tool(name)
    if name not in FIELDS and not is_mcp:
        raise AdapterRejected("unsupported_tool")
    args = parse_raw_arguments(raw_args)
    if not _is_valid_json(args):
        raise AdapterRejected("invalid_invocation")
    if is_mcp and name not in FIELDS:
        filtered = {key: _canonicalize_json(args[key]) for key in sorted(args)}
        return {"tool_name": name, "arguments": filtered}, {}

    if name == "terminal":
        for flag in _TERMINAL_BLOCKED_TRUTHY_OPTIONS:
            if flag in args and bool(args[flag]):
                raise AdapterRejected("unsupported_arguments")
        if (
            "timeout" in args
            and args["timeout"] is not None
            and (type(args["timeout"]) is not int or args["timeout"] < 1)
        ):
            raise AdapterRejected("unsupported_arguments")

    if name in REQUIRED:
        required = REQUIRED[name]
        if not isinstance(args.get(required), str) or not args[required].strip():
            raise AdapterRejected("invalid_invocation")
    elif name == "web_extract":
        has_url = isinstance(args.get("url"), str) and bool(args["url"].strip())
        urls_val = args.get("urls")
        has_urls = (
            isinstance(urls_val, list)
            and len(urls_val) > 0
            and all(isinstance(u, str) and bool(u.strip()) for u in urls_val)
        )
        if not (has_url or has_urls):
            raise AdapterRejected("invalid_invocation")
    elif name == "vision_analyze":
        if not any(
            isinstance(args.get(key), str) and bool(args[key].strip())
            for key in ("image_path", "path", "url")
        ):
            raise AdapterRejected("invalid_invocation")

    field_set = FIELDS[name]
    defaults = DEFAULTS.get(name, {})
    filtered = {}
    omitted: dict[str, Any] = {}
    for key in sorted(args):
        val = args[key]
        if val is None:
            continue
        if key in field_set:
            if name == "read_file" and key in {"offset", "limit"}:
                if type(val) is not int or val < 1:
                    raise AdapterRejected("invalid_invocation")
                filtered[key] = val
            elif name == "web_extract" and key == "urls":
                if (
                    not isinstance(val, list)
                    or len(val) == 0
                    or not all(isinstance(u, str) and bool(u.strip()) for u in val)
                ):
                    raise AdapterRejected("invalid_invocation")
                filtered[key] = list(val)
            elif name == "tool_describe" and key in {"name", "names"}:
                if isinstance(val, str):
                    filtered[key] = val
                elif isinstance(val, list) and all(isinstance(item, str) for item in val):
                    filtered[key] = list(val)
                else:
                    raise AdapterRejected("invalid_invocation")
            elif key in _INT_OR_STR_ID_KEYS and type(val) is int:
                filtered[key] = val
            else:
                if not isinstance(val, str):
                    raise AdapterRejected("invalid_invocation")
                filtered[key] = val
        else:
            if key in defaults:
                default = defaults[key]
                if type(val) is type(default) and val == default:
                    continue
            omitted[key] = _canonicalize_json(val)

    return {"tool_name": name, "arguments": filtered}, omitted
