"""JSON command-line interface for session-navigation state management."""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
from dataclasses import replace
from typing import Any

from session_navigation.db import DBError, DBFullError, db_info, resolve_path
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    ToolResultRecord,
    _item_id,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.sqlite_store import SQLiteContextStore


def _print(payload: Any) -> None:
    print(json.dumps(payload, ensure_ascii=False, default=str))


def _store(path: str | None) -> SQLiteContextStore:
    return SQLiteContextStore(path)


def _scope_arg(value: str) -> str:
    return value


def _preview_text(value: Any) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, default=str)
    encoded = text.encode("utf-8")
    if len(encoded) <= 8192:
        return text
    return encoded[:8192].decode("utf-8", errors="ignore") + "\n… [truncated]"


def _tool_preview(arguments: Any, output: str) -> dict[str, str]:
    return {
        **({"tool_input": _preview_text(arguments)} if arguments is not None else {}),
        "tool_output": _preview_text(output),
    }


def _read_omp_session(scope_key: str) -> tuple[list[dict[str, Any]], list[int], list[tuple[int, int]]] | None:
    """Read an OMP session: messages, positions where history was compacted/reset, and injected reminders (position, chars)."""
    parts = scope_key.split(":")
    if len(parts) < 3 or parts[0] != "pi":
        return None
    session_id = parts[2]
    sessions_root = os.path.expanduser("~/.omp/agent/sessions")
    pattern = os.path.join(sessions_root, "**", f"*_{session_id}.jsonl")
    matched = glob.glob(pattern, recursive=True)
    if not matched:
        return None
    path = matched[0]
    messages: list[dict[str, Any]] = []
    boundaries: list[int] = []
    injected: list[tuple[int, int]] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except Exception:
                    continue
                if isinstance(data, dict):
                    if data.get("type") == "message" and isinstance(data.get("message"), dict):
                        messages.append(data["message"])
                    elif data.get("type") in ("compaction", "branch_summary", "reset_boundary"):
                        boundaries.append(len(messages))
                    elif data.get("type") == "custom" and isinstance(data.get("data"), dict) \
                            and isinstance(data["data"].get("reminder"), str):
                        injected.append((len(messages), len(data["data"]["reminder"])))
                    elif "role" in data:
                        messages.append(data)
    except Exception:
        return None
    return messages, boundaries, injected


def _omp_context_window(provider: Any, model: Any) -> int | None:
    """Look up a model's contextWindow in ~/.omp/agent/models.yml (custom OMP models)."""
    if not isinstance(provider, str) or not isinstance(model, str):
        return None
    try:
        with open(os.path.expanduser("~/.omp/agent/models.yml"), encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return None
    head = re.search(rf"^(\s*){re.escape(provider)}:\s*$", text, re.M)
    if not head:
        return None
    indent = len(head.group(1))
    block = []
    for line in text[head.end():].splitlines()[1:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        block.append(line)
    for entry in re.split(r"^\s*-\s+", "\n".join(block), flags=re.M):
        if re.match(rf"""id:\s*["']?{re.escape(model)}["']?\s*$""", entry, re.M):
            window = re.search(r"^\s*contextWindow:\s*(\d+)", entry, re.M)
            return int(window.group(1)) if window else None
    return None


def _message_text(msg: dict[str, Any]) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))


def _message_key(idx: int, msg: dict[str, Any]) -> str | None:
    """Stable id for a user/assistant message; `msg:` ids are hideable (the OMP extension computes the same id)."""
    role = msg.get("role")
    if role not in ("user", "assistant"):
        return None
    ts = msg.get("timestamp")
    if isinstance(ts, (int, float)) and not isinstance(ts, bool) and ts == int(ts):
        return f"msg:{role}:{int(ts)}:{compute_sha256(_message_text(msg))[:12]}"
    return f"usr_{idx}" if role == "user" else f"ast_{idx}"


def _message_weights(idx: int, msg: dict[str, Any]) -> list[tuple[str | None, int]]:
    """Character weight of each block, keyed by the outline row it belongs to ("?" = unweighable)."""
    role = msg.get("role")
    content = msg.get("content")
    blocks = content if isinstance(content, list) else [{"type": "text", "text": content}] if isinstance(content, str) else []
    owner = msg.get("toolCallId") if role == "toolResult" else _message_key(idx, msg)
    out: list[tuple[str | None, int]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and isinstance(block.get("text"), str):
            out.append((owner, len(block["text"])))
        elif kind == "toolCall":
            out.append((block.get("id"), len(str(block.get("name", ""))) + len(json.dumps(block.get("arguments"), ensure_ascii=False))))
        elif kind != "thinking":
            out.append(("?", 0))
    return out


def _measured_tokens(
    messages: list[dict[str, Any]], boundaries: list[int], mutation_spans: list[tuple[float, float]],
    injected: list[tuple[int, int]] = (),
) -> tuple[dict[str, int], dict[str, Any] | None]:
    """Spec D2 "실측 배분": split each request's measured prompt growth over the rows it added, by characters.

    A segment is unmeasured (rows fall back to bytes) when it is the first request, usage is missing, the
    growth is not positive, history was compacted, a hide/unhide may have landed between the two requests
    (only first and last change times are stored, so the whole span between them counts), or it holds
    non-text blocks.
    """
    anchors = [i for i, m in enumerate(messages)
               if isinstance(m, dict) and m.get("role") == "assistant" and isinstance(m.get("usage"), dict)]
    if not anchors:
        return {}, None

    def prompt_of(msg: dict[str, Any]) -> tuple[float, float | None]:
        snap = msg.get("contextSnapshot") if isinstance(msg.get("contextSnapshot"), dict) else {}
        usage = msg["usage"]
        prompt = snap.get("promptTokens")
        if not isinstance(prompt, (int, float)):
            prompt = sum(usage.get(k) or 0 for k in ("input", "cacheRead", "cacheWrite"))
        non_message = snap.get("nonMessageTokens")
        return prompt, non_message if isinstance(non_message, (int, float)) else None

    totals: dict[str, float] = {}
    incomplete: set[str] = set()
    prev_idx: int | None = None
    prev_tokens: float | None = None
    prev_ts: Any = None
    for anchor in anchors:
        msg = messages[anchor]
        prompt, non_message = prompt_of(msg)
        tokens = prompt - non_message if non_message is not None else None
        start = 0 if prev_idx is None else prev_idx
        parts = [w for i in range(start, anchor) if isinstance(messages[i], dict) for w in _message_weights(i, messages[i])]
        lower = -1 if prev_idx is None else prev_idx
        parts += [(None, chars) for pos, chars in injected if lower < pos <= anchor]
        weight = sum(w for _, w in parts)
        delta = tokens - (prev_tokens or 0) if tokens is not None and (prev_idx is None or prev_tokens is not None) else None
        ts = msg.get("timestamp")
        changed = (isinstance(prev_ts, (int, float)) and isinstance(ts, (int, float))
                   and any(lo <= ts / 1000 and hi > prev_ts / 1000 for lo, hi in mutation_spans))
        # The first request also carries host preamble that never appears as an outline row.
        measured = (prev_idx is not None and delta is not None and delta > 0 and weight > 0 and not changed
                    and not any(start < b <= anchor for b in boundaries) and all(k != "?" for k, _ in parts))
        for key, w in parts:
            if key in (None, "?"):
                continue
            if measured:
                totals[key] = totals.get(key, 0.0) + delta * w / weight
            else:
                incomplete.add(key)
        prev_idx, prev_tokens, prev_ts = anchor, tokens, ts
    for i in range(anchors[-1], len(messages)):
        if isinstance(messages[i], dict):
            incomplete.update(k for k, _ in _message_weights(i, messages[i]) if k)

    last = messages[anchors[-1]]
    usage = last["usage"]
    total = usage.get("totalTokens")
    used = total if isinstance(total, (int, float)) and total > 0 else prompt_of(last)[0] + (usage.get("output") or 0)
    context = {"used_tokens": int(used), "max_tokens": _omp_context_window(last.get("provider"), last.get("model")),
               "source": "omp_session_usage"}
    return {k: max(1, round(v)) if v > 0 else 0 for k, v in totals.items() if k not in incomplete}, context


def _token_fields(tokens: int | None) -> dict[str, Any]:
    if tokens is None:
        return {}
    label = f"{tokens} tok" if tokens < 1000 else f"{tokens / 1000:.1f}K tok"
    return {"tokens": tokens, "tokens_display": label, "tokens_source": "실측 배분"}


def _load_omp_session_timeline(scope_key: str) -> tuple[list[dict[str, Any]], dict[str, ToolResultRecord]]:
    """Load chronological timeline entries (user, assistant, tools) and confirmed ToolResultRecords for an OMP session."""
    session = _read_omp_session(scope_key)
    if session is None:
        return [], {}
    messages = session[0]

    calls: dict[str, tuple[dict[str, Any], int]] = {}
    duplicates: set[str] = set()
    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "toolCall":
                continue
            cid = block.get("id")
            if not isinstance(cid, str) or not cid:
                continue
            if cid in calls:
                duplicates.add(cid)
            else:
                calls[cid] = (block, idx)

    result_counts: dict[str, int] = {}
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "toolResult":
            cid = msg.get("toolCallId")
            if isinstance(cid, str):
                result_counts[cid] = result_counts.get(cid, 0) + 1

    records: dict[str, ToolResultRecord] = {}
    timeline: list[dict[str, Any]] = []
    total_bytes = 0
    MAX_BYTES = 4 * 1024 * 1024
    MAX_RECORDS = 1000

    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "user":
            c = msg.get("content", "")
            text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            summary = "\n".join(lines[:2])[:220]
            if summary:
                timeline.append({
                    "item_id": _message_key(idx, msg),
                    "tool_call_id": "",
                    "kind": "user",
                    "tool_name": "user",
                    "status": "visible",
                    "visibility": "visible",
                    "version": 1,
                    "compaction_source": "user_prompt",
                    "summary_line": summary,
                    "bytes_size": len(text.encode("utf-8")),
                })
        elif role == "assistant":
            c = msg.get("content", [])
            text = ""
            if isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get("type") == "text":
                        text += b.get("text", "")
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            summary = "\n".join(lines[:2])[:220]
            if summary:
                timeline.append({
                    "item_id": _message_key(idx, msg),
                    "tool_call_id": "",
                    "kind": "assistant",
                    "tool_name": "assistant",
                    "status": "visible",
                    "visibility": "visible",
                    "version": 1,
                    "compaction_source": "assistant_output",
                    "summary_line": summary,
                    "bytes_size": len(text.encode("utf-8")),
                })
        elif role == "toolResult":
            cid = msg.get("toolCallId")
            if not isinstance(cid, str) or cid in duplicates or result_counts.get(cid) != 1:
                continue
            found = calls.get(cid)
            if not found:
                continue
            call_block, call_idx = found
            if call_idx >= idx:
                continue
            tool_name = call_block.get("name")
            if tool_name not in ("read", "bash") or msg.get("toolName") != tool_name:
                continue
            if msg.get("isError") is not False:
                continue
            call_args = call_block.get("arguments")
            if not isinstance(call_args, dict):
                continue
            content_list = msg.get("content")
            if not isinstance(content_list, list) or len(content_list) != 1:
                continue
            block0 = content_list[0]
            if not isinstance(block0, dict) or block0.get("type") != "text" or not isinstance(block0.get("text"), str):
                continue

            if tool_name == "read":
                p = call_args.get("path")
                if not isinstance(p, str) or not p.strip():
                    continue
                args = {"path": p}
            else:
                cmd = call_args.get("command")
                if not isinstance(cmd, str) or not cmd.strip():
                    continue
                args = {"command": cmd}
                cwd = call_args.get("cwd")
                if isinstance(cwd, str) and cwd.strip():
                    args["cwd"] = cwd

            text = block0["text"]
            raw_bytes = len(text.encode("utf-8"))
            total_bytes += raw_bytes
            if total_bytes > MAX_BYTES or len(records) >= MAX_RECORDS:
                break

            invocation = {"tool_name": tool_name, "arguments": args}
            inv_digest = compute_invocation_digest(invocation)
            content_hash = compute_sha256(text)
            rec = ToolResultRecord(
                call_id=cid,
                content=text,
                content_sha256=content_hash,
                invocation=invocation,
                invocation_digest=inv_digest,
                status="ok",
                result_position=0,
            )
            records[cid] = rec
            item_id = _item_id(scope_key, cid, content_hash, inv_digest, 0)
            lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
            summary = "\n".join(lines[:2])[:220]
            timeline.append({
                "item_id": item_id,
                "tool_call_id": cid,
                "kind": "tool",
                "tool_name": tool_name,
                "status": "visible",
                "visibility": "visible",
                "version": 1,
                "compaction_source": "unrecorded",
                "summary_line": summary,
                "bytes_size": raw_bytes,
                **_tool_preview(call_args, text),
                "record": rec,
            })

    return timeline, records


def _explicit_hide_fallback(
    store: SQLiteContextStore,
    scope: str,
    target_rec: ToolResultRecord,
    compaction_source: str = "explicit_user_hide",
) -> Any:
    """Store an explicit user hide fallback ContextItem when automatic compaction policy refuses."""
    from session_navigation.model import ContextItem
    lines = target_rec.content.splitlines()
    head = [lines[i] for i in range(min(3, len(lines)))]
    tail = [lines[i] for i in range(max(0, len(lines) - 2), len(lines))] if len(lines) > 3 else []
    excerpt = "\n".join(head + (["..."] if tail else []) + tail)
    tname = target_rec.invocation.get("tool_name", "tool")
    header = "summary" if compaction_source in ("rule_summary", "llm", "llm_summary", "summarize") else "hidden"
    compacted = f"[{header}: {tname} {target_rec.call_id}]\n{excerpt}"
    iid = _item_id(scope, target_rec.call_id, target_rec.content_sha256, target_rec.invocation_digest or "", 0)
    fallback_item = ContextItem(
        item_id=iid,
        tool_call_id=target_rec.call_id,
        content_sha256=target_rec.content_sha256,
        original=target_rec.content,
        compacted=compacted,
        excerpt_lines=head + tail,
        visibility="hidden",
        version=1,
        expires_at=0.0,
        tool_name=tname,
        compaction_source=compaction_source,
        invocation_snapshot=None,
        invocation_digest=target_rec.invocation_digest or "",
        result_position=target_rec.result_position,
    )
    put_res = store.put(scope, fallback_item)
    if put_res.ok and put_res.item is not None:
        store.fence_set(
            scope,
            tool_call_id=target_rec.call_id,
            content_sha256=target_rec.content_sha256,
            invocation_digest=target_rec.invocation_digest or "",
            result_position=target_rec.result_position,
            item_id=put_res.item.item_id,
            version=put_res.item.version,
        )
    return put_res


def _load_omp_session_records(scope_key: str) -> dict[str, ToolResultRecord]:
    """Compatibility wrapper returning just the confirmed ToolResultRecords dictionary."""
    _, records = _load_omp_session_timeline(scope_key)
    return records


def _mutate_message(
    store: SQLiteContextStore, command: str, scope: str, item_id: str, expected_version: int | None, mode: str,
) -> tuple[dict[str, Any], int]:
    """Hide/unhide a user prompt or assistant response. Messages support hide only, never summarize."""
    if command == "hide" and mode != "hide":
        return {"ok": False, "error": "summarize_unsupported"}, 2
    session = _read_omp_session(scope)
    found = next(((i, m) for i, m in enumerate(session[0] if session else [])
                  if isinstance(m, dict) and _message_key(i, m) == item_id), None)
    if found is None:
        return {"ok": False, "error": "not_found"}, 2
    text = _message_text(found[1])
    try:
        res = store.set_message_visibility(
            scope, item_id, kind=found[1]["role"], content_sha256=compute_sha256(text), char_count=len(text),
            visibility="hidden" if command == "hide" else "visible", expected_version=expected_version,
        )
    except (DBError, DBFullError) as exc:
        return {"ok": False, "error": "db_full" if isinstance(exc, DBFullError) else "db_error"}, 3
    if not res["ok"]:
        return {"ok": False, "error": res["error"],
                "item": {"item_id": item_id, "version": res["version"], "visibility": res["visibility"]}}, 4
    return {"ok": True, "item_id": item_id, "visibility": res["visibility"], "version": res["version"],
            "source": "explicit_user_hide"}, 0


def _mutate_item(
    store: SQLiteContextStore, command: str, scope: str, item_id: str,
    expected_version: int | None = None, mode: str = "hide", *, enforce_version: bool = False,
) -> tuple[dict[str, Any], int]:
    if item_id.startswith("msg:"):
        return _mutate_message(store, command, scope, item_id, expected_version, mode)
    if command == "unhide":
        res = store.restore(scope, item_id, expected_version=expected_version)
        if not res.ok:
            if res.error == "version_conflict":
                return {"ok": False, "error": "version_conflict", "item": res.item.__dict__ if res.item else None}, 4
            return {"ok": False, "error": res.error}, 3 if res.error in ("db_error", "db_full") else 2
        return {"ok": True, "item_id": res.item.item_id, "visibility": res.item.visibility, "version": res.item.version}, 0

    chosen_source = "rule_summary" if mode == "summarize" else "explicit_user_hide"
    item = store.get(scope, item_id)
    if enforce_version and item is not None and expected_version is not None and item.version != expected_version:
        return {"ok": False, "error": "version_conflict", "item": item.__dict__}, 4
    if item is None:
        _, omp_records = _load_omp_session_timeline(scope)
        target_rec = None
        for rec in omp_records.values():
            iid = _item_id(scope, rec.call_id, rec.content_sha256, rec.invocation_digest or "", 0)
            if iid == item_id or rec.call_id == item_id:
                target_rec = rec
                break
        if target_rec is not None:
            engine = SessionNavigationEngine(store=store)
            c_res = engine.compact_sync(scope, target_rec)
            if c_res.ok and c_res.item is not None:
                final_item = c_res.item
                if final_item.compaction_source != chosen_source:
                    updated_src = replace(final_item, compaction_source=chosen_source, version=final_item.version + 1)
                    put_src = store.put(scope, updated_src, expected_version=final_item.version)
                    if not put_src.ok:
                        return {"ok": False, "error": put_src.error}, 3 if put_src.error in ("db_error", "db_full") else 2
                    if put_src.ok and put_src.item is not None:
                        final_item = put_src.item
                store.fence_set(
                    scope,
                    tool_call_id=target_rec.call_id,
                    content_sha256=target_rec.content_sha256,
                    invocation_digest=target_rec.invocation_digest or "",
                    result_position=target_rec.result_position,
                    item_id=final_item.item_id,
                    version=final_item.version,
                )
                return {"ok": True, "item_id": final_item.item_id, "visibility": "hidden", "version": final_item.version, "source": final_item.compaction_source}, 0
            else:
                if c_res.error in ("db_error", "db_full"):
                    return {"ok": False, "error": c_res.error}, 3
                fallback_res = _explicit_hide_fallback(store, scope, target_rec, compaction_source=chosen_source)
                if fallback_res.ok and fallback_res.item is not None:
                    return {"ok": True, "item_id": fallback_res.item.item_id, "visibility": "hidden", "version": fallback_res.item.version, "source": fallback_res.item.compaction_source}, 0
                else:
                    return {"ok": False, "error": fallback_res.error or "hide_failed"}, 2
        return {"ok": False, "error": "not_found"}, 2
    if item.visibility == "hidden" and item.compaction_source == chosen_source:
        return {"ok": True, "item_id": item.item_id, "visibility": "hidden", "version": item.version, "source": item.compaction_source}, 0
    # mark hidden by updating visibility/version and compaction_source
    updated = replace(item, visibility="hidden", compaction_source=chosen_source, version=item.version + 1)
    res = store.put(scope, updated, expected_version=expected_version if expected_version is not None else item.version)
    if not res.ok:
        if res.error == "version_conflict":
            return {"ok": False, "error": "version_conflict", "item": res.item.__dict__ if res.item else None}, 4
        return {"ok": False, "error": res.error}, 3 if res.error in ("db_error", "db_full") else 2
    return {"ok": True, "item_id": res.item.item_id, "visibility": "hidden", "version": res.item.version, "source": res.item.compaction_source}, 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="session-navigation")
    sub = parser.add_subparsers(dest="command", required=True)

    p_db = sub.add_parser("db-info")
    p_db.add_argument("--path", default=None)
    p_scopes = sub.add_parser("scopes")
    p_scopes.add_argument("--path", default=None)


    p_list = sub.add_parser("list")
    p_list.add_argument("--scope", required=True)
    p_list.add_argument("--query", default="")
    p_list.add_argument("--path", default=None)

    p_hide = sub.add_parser("hide")
    p_hide.add_argument("--scope", required=True)
    hide_target = p_hide.add_mutually_exclusive_group(required=True)
    hide_target.add_argument("--item-id")
    hide_target.add_argument("--items-json")
    p_hide.add_argument("--expected-version", type=int, default=None)
    p_hide.add_argument("--mode", default="hide", choices=["hide", "summarize"])
    p_hide.add_argument("--path", default=None)

    p_unhide = sub.add_parser("unhide")
    p_unhide.add_argument("--scope", required=True)
    unhide_target = p_unhide.add_mutually_exclusive_group(required=True)
    unhide_target.add_argument("--item-id")
    unhide_target.add_argument("--items-json")
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

    batch_items = []
    if args.command in ("hide", "unhide") and args.items_json is not None:
        if args.expected_version is not None:
            parser.error("--expected-version requires --item-id")
        try:
            batch_items = json.loads(args.items_json)
            if not isinstance(batch_items, list) or any(
                not isinstance(item, dict) or not isinstance(item.get("item_id"), str)
                or not item["item_id"] or (
                    "expected_version" in item and type(item["expected_version"]) is not int
                ) for item in batch_items
            ):
                raise ValueError("expected a list of item_id and optional integer expected_version")
        except (ValueError, TypeError) as exc:
            parser.error(f"invalid --items-json: {exc}")

    try:
        if args.command == "db-info":
            _print(db_info(args.path))
            return 0

        if args.command == "scopes":
            store = _store(args.path)
            try:
                rows = store.list_scopes() if hasattr(store, "list_scopes") else []
                _print({"ok": True, "scopes": rows})
                return 0
            finally:
                store.close()

        if args.command == "list":
            store = _store(args.path)
            try:
                db_items_list = store.items(args.scope)
                db_items = {it.tool_call_id: it for it in db_items_list}
                timeline, omp_records = _load_omp_session_timeline(args.scope)
                session = _read_omp_session(args.scope) if timeline else None
                message_units = {u["unit_id"]: u for u in store.list_units(args.scope)
                                 if u.get("kind") in ("user", "assistant")} if timeline else {}
                spans = [(it.created_at, it.updated_at) for it in db_items_list
                         if it.version > 1 or it.visibility == "hidden"]
                # A message can only have been hidden after it was written, so its id's timestamp bounds the span.
                spans += [(int(key.split(":")[2]) / 1000, float(u.get("updated_at") or 0)) for key, u in message_units.items()
                          if key.startswith("msg:") and (int(u.get("version") or 1) > 1 or u.get("visibility") == "hidden")]
                row_tokens, context = (
                    _measured_tokens(session[0], session[1], spans, session[2]) if session else ({}, None)
                )
                out = []

                if timeline:
                    for entry in timeline:
                        kind = entry.get("kind", "tool")
                        if kind in ("user", "assistant"):
                            if args.query and args.query.lower() not in (entry.get("summary_line") or "").lower():
                                continue
                            unit = message_units.get(entry["item_id"])
                            hidden = bool(unit) and unit.get("visibility") == "hidden"
                            version = int(unit.get("version") or 1) if unit else 1
                            out.append({
                                "item_id": entry["item_id"],
                                "tool_call_id": "",
                                "kind": kind,
                                "tool_name": entry["tool_name"],
                                "status": "hidden" if hidden else ("unhidden" if version > 1 else "visible"),
                                "visibility": "hidden" if hidden else "visible",
                                "version": version,
                                "compaction_source": "explicit_user_hide" if hidden else entry["compaction_source"],
                                "summary_line": entry["summary_line"],
                                "bytes_size": entry["bytes_size"],
                                **_token_fields(row_tokens.get(entry["item_id"])),
                            })
                        else:
                            cid = entry.get("tool_call_id", "")
                            it = db_items.get(cid)
                            if it is not None:
                                status = "hidden" if it.visibility == "hidden" else ("unhidden" if it.version > 1 else "visible")
                                if it.visibility != "hidden" and entry.get("summary_line"):
                                    summary_line = entry["summary_line"]
                                else:
                                    summary_lines: list[str] = []
                                    source_text = (it.compacted or "") if it.visibility == "hidden" else (it.original or "")
                                    for ln in source_text.splitlines():
                                        collapsed = " ".join(ln.split())
                                        if collapsed and not collapsed.startswith("[hidden:") and not collapsed.startswith("나머지 결과는 보관됨"):
                                            summary_lines.append(collapsed)
                                            if len(summary_lines) >= 2:
                                                break
                                    if not summary_lines:
                                        for ln in (it.original or "").splitlines():
                                            collapsed = " ".join(ln.split())
                                            if collapsed:
                                                summary_lines.append(collapsed)
                                                if len(summary_lines) >= 2:
                                                    break
                                    summary_line = "\n".join(summary_lines[:2])[:220]
                                if args.query and args.query.lower() not in (it.compacted or "").lower() and args.query.lower() not in (summary_line or "").lower() and args.query.lower() not in it.item_id.lower() and args.query.lower() not in cid.lower():
                                    continue
                                out.append({
                                    "item_id": it.item_id,
                                    "tool_call_id": it.tool_call_id,
                                    "kind": "tool",
                                    "status": status,
                                    "visibility": it.visibility,
                                    "tool_name": it.tool_name,
                                    "version": it.version,
                                    "compaction_source": it.compaction_source,
                                    "summary_line": summary_line,
                                    "bytes_size": len((it.original or "").encode("utf-8")),
                                    **{key: entry[key] for key in ("tool_input",) if key in entry},
                                    "tool_output": _preview_text(it.original),
                                    **_token_fields(row_tokens.get(cid)),
                                })
                            else:
                                if args.query and args.query.lower() not in (entry.get("summary_line") or "").lower() and args.query.lower() not in entry.get("item_id", "").lower() and args.query.lower() not in cid.lower():
                                    continue
                                out.append({
                                    "item_id": entry["item_id"],
                                    "tool_call_id": cid,
                                    "kind": "tool",
                                    "status": "visible",
                                    "visibility": "visible",
                                    "version": 1,
                                    "compaction_source": "unrecorded",
                                    "tool_name": entry["tool_name"],
                                    "summary_line": entry["summary_line"],
                                    "bytes_size": entry["bytes_size"],
                                    **{key: entry[key] for key in ("tool_input", "tool_output") if key in entry},
                                    **_token_fields(row_tokens.get(cid)),
                                })
                else:
                    recorded_calls: set[str] = set()
                    for it in db_items_list:
                        recorded_calls.add(it.tool_call_id)
                        if args.query and args.query.lower() not in (it.compacted or "").lower() and args.query.lower() not in it.item_id.lower() and args.query.lower() not in (it.tool_call_id or "").lower():
                            continue
                        status = "hidden" if it.visibility == "hidden" else ("unhidden" if it.version > 1 else "visible")
                        summary_lines = []
                        source_text = (it.compacted or "") if it.visibility == "hidden" else (it.original or "")
                        for ln in source_text.splitlines():
                            collapsed = " ".join(ln.split())
                            if collapsed and not collapsed.startswith("[hidden:") and not collapsed.startswith("나머지 결과는 보관됨"):
                                summary_lines.append(collapsed)
                                if len(summary_lines) >= 2:
                                    break
                        if not summary_lines:
                            for ln in (it.original or "").splitlines():
                                collapsed = " ".join(ln.split())
                                if collapsed:
                                    summary_lines.append(collapsed)
                                    if len(summary_lines) >= 2:
                                        break
                        summary_line = "\n".join(summary_lines[:2])[:220]
                        out.append({
                            "item_id": it.item_id,
                            "tool_call_id": it.tool_call_id,
                            "kind": "tool",
                            "status": status,
                            "visibility": it.visibility,
                            "tool_name": it.tool_name,
                            "version": it.version,
                            "compaction_source": it.compaction_source,
                            "summary_line": summary_line,
                            "bytes_size": len((it.original or "").encode("utf-8")),
                            **_tool_preview(
                                it.invocation_snapshot.get("arguments", it.invocation_snapshot)
                                if isinstance(it.invocation_snapshot, dict) else None,
                                it.original,
                            ),
                        })

                    unrecorded_units = [u for u in store.list_units(args.scope) if u.get("kind") == "tool_result" and u.get("tool_call_id") not in recorded_calls]
                    for u in unrecorded_units:
                        cid = u.get("tool_call_id")
                        if not cid or cid in recorded_calls:
                            continue
                        recorded_calls.add(cid)
                        item_id = f"unit_{u.get('unit_id', cid)}"
                        summary_line = f"[{u.get('kind', 'tool_result')}] {cid}"
                        bytes_size = int(u.get("char_count", 0))
                        tool_name = "tool"
                        if args.query and args.query.lower() not in summary_line.lower() and args.query.lower() not in item_id.lower() and args.query.lower() not in (cid or "").lower():
                            continue
                        out.append({
                            "item_id": item_id,
                            "tool_call_id": cid,
                            "kind": "tool",
                            "status": "visible",
                            "visibility": "visible",
                            "version": 1,
                            "compaction_source": "unrecorded",
                            "tool_name": tool_name,
                            "summary_line": summary_line,
                            "bytes_size": bytes_size,
                        })

                _print({"ok": True, "items": out, **({"context": context} if context else {})})
                return 0
            finally:
                store.close()

        if args.command in ("hide", "unhide"):
            store = _store(args.path)
            try:
                if args.items_json is None:
                    payload, code = _mutate_item(store, args.command, args.scope, args.item_id,
                                                 args.expected_version, getattr(args, "mode", "hide"))
                    _print(payload)
                    return code
                results = []
                for request in batch_items:
                    item_id = request["item_id"]
                    expected = request.get("expected_version")
                    payload, _ = _mutate_item(store, args.command, args.scope, item_id,
                                             expected, getattr(args, "mode", "hide"), enforce_version=True)
                    if payload.get("error") in ("db_error", "db_full"):
                        if not results:
                            _print({"ok": False, "error": payload["error"]})
                            return 3
                        # Earlier items are already committed; report them so callers see what changed.
                        applied = sum(result["ok"] for result in results)
                        results.append({"item_id": item_id, "ok": False, "status": None, "visibility": None,
                                        "version": None, "error": payload["error"]})
                        _print({"ok": False, "error": payload["error"], "applied": applied,
                                "failed": len(results) - applied, "items": results})
                        return 3
                    current = store.get(args.scope, payload.get("item_id", item_id))
                    visibility = payload.get("visibility", current.visibility if current else None)
                    results.append({"item_id": payload.get("item_id", item_id),
                                    "ok": payload["ok"], "status": visibility,
                                    "visibility": visibility,
                                    "version": payload.get("version", current.version if current else None),
                                    **({"error": payload["error"]} if "error" in payload else {})})
                applied = sum(result["ok"] for result in results)
                failed = len(results) - applied
                _print({"ok": failed == 0, "applied": applied, "failed": failed, "items": results})
                return 0 if failed == 0 else 2
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
                remaining = max_items - len(items_out)
                if remaining > 0:
                    omp_records = _load_omp_session_records(args.scope)
                    recorded_calls = {it.tool_call_id for it in store.items(args.scope)}
                    from session_navigation.engine import SessionNavigationEngine
                    engine = SessionNavigationEngine(store=store)
                    for rec in omp_records.values():
                        if remaining <= 0:
                            break
                        if rec.call_id in recorded_calls:
                            continue
                        c_res = engine.compact_sync(args.scope, rec)
                        if c_res.ok and c_res.item is not None:
                            store.fence_set(
                                args.scope,
                                tool_call_id=rec.call_id,
                                content_sha256=rec.content_sha256,
                                invocation_digest=rec.invocation_digest or "",
                                result_position=rec.result_position,
                                item_id=c_res.item.item_id,
                                version=c_res.item.version,
                            )
                            recorded_calls.add(rec.call_id)
                            items_out.append({"tool_call_id": rec.call_id, "ok": True, "item_id": c_res.item.item_id})
                            remaining -= 1
                        else:
                            fallback_res = _explicit_hide_fallback(store, args.scope, rec)
                            if fallback_res.ok and fallback_res.item is not None:
                                recorded_calls.add(rec.call_id)
                                items_out.append({"tool_call_id": rec.call_id, "ok": True, "item_id": fallback_res.item.item_id})
                                remaining -= 1
                            else:
                                items_out.append({"tool_call_id": rec.call_id, "ok": False, "error": c_res.error or "compact_failed"})
                                remaining -= 1
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
