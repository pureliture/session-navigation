"""OMP daemon."""
from __future__ import annotations
import re
import json, sys
from collections import OrderedDict
from typing import Any
from session_navigation.db import DBError, DBFullError
from session_navigation.engine import SessionNavigationEngine, _run_sync
from session_navigation.model import Scope, ToolResultRecord, _item_id, compute_invocation_digest, compute_sha256, pair_unit_id
from session_navigation.policy import is_destructive_command, required_evidence_lines, refusal_reason
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.summary import validate_summary_text

PROTOCOL = 3
MAX_SCOPES = 32
MAX_CHUNK_RECORDS = 64
MAX_CHUNK_BYTES = 4 * 1024 * 1024
_MISSING = object()


class Daemon:
    def __init__(self, store=None):
        self.store = store if store is not None else SQLiteContextStore()
        self.engine = SessionNavigationEngine(store=self.store)
        self.snapshots = OrderedDict()

    @staticmethod
    def _scope(session_id):
        return Scope(adapter_id="pi", host_profile="default", session_id=session_id, branch_scope="default")

    def _db_error_response(self, exc):
        if "full" in str(exc).lower() or "disk" in str(exc).lower():
            return {"ok": False, "error": "db_full"}
        return {"ok": False, "error": getattr(exc, "code", "db_error"), "choices": ["abort_request", "send_original"]}

    def handle(self, req):
        try:
            return self._handle(req)
        except (DBError, DBFullError) as exc:
            return self._db_error_response(exc)
        except Exception as exc:
            if "sqlite" in str(exc).lower() or "database" in str(exc).lower():
                return self._db_error_response(exc)
            raise

    def _handle(self, req):
        method = req.get("method")
        if method == "ping":
            return {"ok": True, "protocol": PROTOCOL}
        if method == "fork_scope":
            params = req.get("params", {})
            if not isinstance(params, dict):
                return {"ok": False, "error": "invalid_params"}
            src = params.get("src_session_id", params.get("source_session_id", params.get("src_scope_key")))
            dst = params.get("dst_session_id", params.get("destination_session_id", params.get("dst_scope_key")))
            if not isinstance(src, str) or not src or not isinstance(dst, str) or not dst:
                return {"ok": False, "error": "invalid_session"}
            src_scope = src if (":" in src and src.count(":") >= 3) else self._scope(src)
            dst_scope = dst if (":" in dst and dst.count(":") >= 3) else self._scope(dst)
            counts = self.store.fork_scope(src_scope, dst_scope)
            payload = counts.to_dict() if hasattr(counts, "to_dict") else counts
            return {"ok": True, "counts": payload}

        params = req.get("params")
        if not isinstance(params, dict):
            return {"ok": False, "error": "invalid_params"}
        session = params.get("session_id")
        if not isinstance(session, str) or not session or len(session) > 256 or ":" in session:
            return {"ok": False, "error": "invalid_session"}
        scope = self._scope(session)

        if method in ("apply_summary", "summary_failed"):
            return self._finish_summary(method, scope, params)
        if method == "prepare":
            token = params.get("snapshot_id")
            append = params.get("append", False)
            snapshot = self.snapshots.get(session)
            if append is True and (snapshot is None or snapshot[0] != token):
                return {"ok": False, "error": "unconfirmed_snapshot"}
            self.snapshots.pop(session, None)
            records = params.get("records")
            if (not isinstance(append, bool) or not isinstance(token, str)
                    or not isinstance(records, list) or len(records) > MAX_CHUNK_RECORDS):
                return {"ok": False, "error": "invalid_snapshot"}
            previous = snapshot[1] if append else {}
            selected = {}
            total = 0
            for raw in records:
                if not isinstance(raw, dict):
                    return {"ok": False, "error": "invalid_record"}
                call_id = raw.get("call_id")
                content = raw.get("content")
                args = raw.get("arguments")
                tool_name = raw.get("tool_name")
                status = raw.get("status", "ok")
                result_position = raw.get("result_position", 0)
                if (not isinstance(call_id, str) or not call_id or call_id in selected or call_id in previous
                        or not isinstance(content, str)
                        or not isinstance(args, dict)
                        or tool_name not in ("read", "bash")
                        or status != "ok"):
                    return {"ok": False, "error": "invalid_record"}
                if not isinstance(result_position, int) or isinstance(result_position, bool):
                    return {"ok": False, "error": "invalid_record"}
                if tool_name == "read":
                    if (not isinstance(args.get("path"), str)
                            or not str(args.get("path")).strip()):
                        return {"ok": False, "error": "invalid_record"}
                else:
                    if ("command" not in args
                            or not isinstance(args.get("command"), str)
                            or not str(args.get("command")).strip()):
                        return {"ok": False, "error": "invalid_record"}
                total += len(content.encode("utf-8"))
                if total > MAX_CHUNK_BYTES:
                    return {"ok": False, "error": "snapshot_too_large"}
                invocation = {"tool_name": tool_name, "arguments": args}
                selected[call_id] = ToolResultRecord(
                    call_id=call_id,
                    content=content,
                    content_sha256=str(raw.get("content_sha256") or compute_sha256(content)),
                    invocation=invocation,
                    invocation_digest=compute_invocation_digest(invocation),
                    status="ok",
                    result_position=result_position,
                )
            # Pair-atomic units: one pair_ row per confirmed record (call+result).
            try:
                for record in selected.values():
                    self.store.upsert_unit(scope, unit_id=pair_unit_id(scope.scope_key(), record.call_id, record.content_sha256),
                                           kind="tool_result", tool_call_id=record.call_id,
                                           content_sha256=record.content_sha256,
                                           char_count=len(record.content))
            except (DBError, DBFullError):
                raise
            except Exception:
                pass
            previous.update(selected)
            self.snapshots[session] = (token, previous)
            evicted: list[str] = []
            while len(self.snapshots) > MAX_SCOPES:
                key, _ = self.snapshots.popitem(last=False)
                evicted.append(key)
            items_by_key = {}
            for item in self.store.items(scope):
                items_by_key.setdefault((item.tool_call_id, item.content_sha256, item.invocation_digest or ""), item)
            patches = []
            for record in selected.values():
                item = items_by_key.get((record.call_id, record.content_sha256, record.invocation_digest or ""))
                if item is not None and item.visibility == "hidden":
                    patches.append({
                        "call_id": record.call_id,
                        "sha256": record.content_sha256,
                        "text": item.compacted,
                    })
            pending = [
                {"item_id": item.item_id, "call_id": record.call_id, "version": item.version, "content": record.content}
                for record in selected.values()
                for item in [items_by_key.get((record.call_id, record.content_sha256, record.invocation_digest or ""))]
                if item is not None and item.visibility == "hidden" and item.compaction_source == "summarize_pending"
            ]
            out: dict[str, Any] = {"ok": True, "patches": patches,
                                   "hidden_messages": self.store.hidden_message_keys(scope),
                                   "pending_summaries": pending}
            if evicted:
                out["evicted_snapshots"] = evicted
            return out

        if method in ("compact", "summarize"):
            return self._compact_or_summarize(method, scope, session, params)

        if method == "list_items":
            query = params.get("query", "")
            if not isinstance(query, str):
                query = ""
            items = self.engine.list_items(scope, query)
            result_items = []
            for item in items:
                d = item.to_dict()
                d.setdefault("status", item.visibility)
                d["tokens_display"] = "—"
                result_items.append(d)
            snapshot_id = params.get("snapshot_id")
            snapshot = self.snapshots.get(session)
            if isinstance(snapshot_id, str) and snapshot is not None and snapshot[0] == snapshot_id:
                recorded_calls = {item.call_id for item in items}
                for record in snapshot[1].values():
                    if record.call_id in recorded_calls:
                        continue
                    result_items.append({
                        "item_id": None,
                        "call_id": record.call_id,
                        "tool_call_id": record.call_id,
                        "content_sha256": record.content_sha256,
                        "visibility": "unhidden",
                        "status": "unhidden",
                        "version": 1,
                        "source": "unrecorded",
                        "bytes_size": len(record.content.encode("utf-8")),
                        "tool_name": record.invocation.get("tool_name"),
                        "tokens_display": "—",
                    })
            return {"ok": True, "items": result_items}

        if method == "restore":
            item_id = params.get("item_id", "")
            expected_version = params.get("expected_version", None)
            if expected_version is not None and not isinstance(expected_version, int):
                return {"ok": False, "error": "invalid_version"}
            result = self.engine.restore(scope, item_id, expected_version=expected_version)
            return {
                "ok": result.ok,
                "error": result.error,
                "item_id": result.item.item_id if result.item else None,
                "version": result.item.version if result.item else None,
            }

        if method == "manage":
            return self._manage(scope, session, params)
        if method == "list_candidates":
            return self._list_candidates(scope, session, params)

        return {"ok": False, "error": "unknown_method"}

    def _finish_summary(self, method, scope, params):
        """Swap a pending summarize hide for the session model's summary, or fall back to a plain hide."""
        from dataclasses import replace
        item = self.store.get(scope, params.get("item_id"))
        if item is None or item.compaction_source != "summarize_pending":
            return {"ok": False, "error": "not_found"}
        if method == "summary_failed":
            updated = replace(item, compaction_source="explicit_user_hide", version=item.version + 1)
        else:
            text = params.get("summary_text")
            if not isinstance(text, str) or not text.strip():
                return {"ok": False, "error": "summarizer_unavailable"}
            invocation = item.invocation_snapshot if isinstance(item.invocation_snapshot, dict) else None
            # A summary must be smaller than the result and share its wording; otherwise keep the plain hide.
            original_words = set(re.findall(r"\w{4,}", item.original.lower()))
            grounded = bool(original_words & set(re.findall(r"\w{4,}", text.lower())))
            if len(text) >= len(item.original) or not grounded or validate_summary_text(
                    item.original, {"summary": text}, required_evidence_lines(item.original), invocation=invocation) is None:
                res = self.store.put(scope, replace(item, compaction_source="explicit_user_hide", version=item.version + 1),
                                     expected_version=item.version)
                return {"ok": False, "error": "verification_failed" if res.ok else res.error, "item_id": item.item_id}
            updated = replace(item, compacted=text, compaction_source="llm_summary", version=item.version + 1)
        res = self.store.put(scope, updated, expected_version=item.version)
        return {"ok": res.ok, "error": res.error, "item_id": item.item_id,
                "version": res.item.version if res.item else None}

    def _identity_state(self, scope, record, method):
        item_id = _item_id(scope.scope_key(), record.call_id, record.content_sha256, record.invocation_digest, record.result_position)
        expected_fence_digest = record.invocation_digest or ""
        try:
            rows = self.store.connection.execute(
                "SELECT invocation_digest FROM identities WHERE scope_key=? AND tool_call_id=? AND content_sha256=? AND result_position=?",
                (scope.scope_key(), record.call_id, record.content_sha256, int(record.result_position)),
            ).fetchall()
        except Exception:
            rows = []
        digests = {str(r["invocation_digest"]) for r in rows}
        if digests and expected_fence_digest not in digests:
            return "invocation_conflict"
        existing = self.store.get(scope, item_id)
        try:
            fence_id = self.store.fence_get(
                scope,
                tool_call_id=record.call_id,
                content_sha256=record.content_sha256,
                invocation_digest=expected_fence_digest,
                result_position=record.result_position,
            )
        except Exception:
            fence_id = None
        if fence_id is None and existing is not None:
            return "identity_expired"
        return None

    def _fence_set(self, scope, record, item, method):
        expected_fence_digest = record.invocation_digest or ""
        item_id = getattr(item, "item_id", None) or _item_id(scope.scope_key(), record.call_id, record.content_sha256, record.invocation_digest, record.result_position)
        version = getattr(item, "version", 1) if item is not None else 1
        try:
            self.store.fence_set(
                scope,
                tool_call_id=record.call_id,
                content_sha256=record.content_sha256,
                invocation_digest=expected_fence_digest,
                result_position=record.result_position,
                item_id=item_id,
                version=version,
            )
        except Exception:
            pass

    def _compact_or_summarize(self, method, scope, session, params):
        snapshot = self.snapshots.get(session)
        if not snapshot or params.get("snapshot_id") != snapshot[0]:
            return {"ok": False, "error": "unconfirmed_snapshot"}
        record = snapshot[1].get(params.get("tool_call_id"))
        if record is None:
            return {"ok": False, "error": "not_found"}
        err = self._identity_state(scope, record, method)
        if err is not None:
            return {"ok": False, "error": err}

        summary_text = params.get("summary_text", _MISSING)
        if summary_text is _MISSING:
            summary_text = None

        if method == "summarize":
            if not isinstance(summary_text, str) or not summary_text.strip():
                return {"ok": False, "error": "summarizer_unavailable"}
            required = required_evidence_lines(record.content)
            validated = validate_summary_text(record.content, {"summary": summary_text}, required, invocation=record.invocation)
            if validated is None:
                return {"ok": False, "error": "verification_failed"}

            class _SuppliedSummarizer:
                async def summarize(self, original, required_evidence, on_call=None, *, invocation=None, context=None):
                    return {"summary": summary_text}

            result = _run_sync(self.engine.summarize(scope, record, _SuppliedSummarizer()))
        else:
            result = self.engine.compact_sync(scope, record)

        if result.ok and result.plan is not None and result.item is not None:
            self._fence_set(scope, record, result.item, method)
        return {
            "ok": result.ok,
            "error": result.error,
            "item_id": result.plan.item_id if result.plan else None,
            "version": result.item.version if result.item else None,
        }

    def _cleanup_error(self, scope, record):
        error = self._identity_state(scope, record, "compact")
        if error:
            return error
        item = self.store.get(scope, _item_id(scope.scope_key(), record.call_id, record.content_sha256,
                                             record.invocation_digest, record.result_position))
        if item is not None and item.visibility == "hidden":
            return "already_hidden"
        try:
            if is_destructive_command(record.invocation.get("tool_name"), record.invocation.get("arguments")):
                return "destructive_command"
        except Exception:
            return "destructive_check_failed"
        return refusal_reason(record, self.engine.config)

    def _list_candidates(self, scope, session, params):
        snapshot = self.snapshots.get(session)
        if not snapshot or params.get("snapshot_id") != snapshot[0]:
            return {"ok": False, "error": "unconfirmed_snapshot"}
        limit = params.get("limit", 30)
        if type(limit) is not int or not 1 <= limit <= 200:
            return {"ok": False, "error": "invalid_limit"}
        wanted = params.get("tool_call_ids")
        if wanted is not None and (not isinstance(wanted, list) or not all(isinstance(x, str) for x in wanted)):
            return {"ok": False, "error": "invalid_tool_call_ids"}
        wanted = set(wanted) if wanted is not None else None
        items = []
        total = 0
        for record in reversed(list(snapshot[1].values())):
            if wanted is not None and record.call_id not in wanted:
                continue
            if self._cleanup_error(scope, record) is not None:
                continue
            total += 1
            if len(items) >= limit:
                continue
            args = record.invocation.get("arguments", {})
            items.append({"tool_call_id": record.call_id, "tool_name": record.invocation.get("tool_name"),
                          "hint": str(args.get("command") or args.get("path") or "")[:160],
                          "bytes_size": len(record.content.encode("utf-8")), "tokens_display": "—"})
        return {"ok": True, "items": items, "total": total}

    def _manage(self, scope, session, params):
        want = params.get("tool_call_ids")
        if want is None or want == []:
            return {"ok": False, "error": "tool_call_ids_required"}
        if not isinstance(want, list) or not all(isinstance(x, str) and x.strip() for x in want):
            return {"ok": False, "error": "invalid_tool_call_ids"}
        snapshot = self.snapshots.get(session)
        if not snapshot or params.get("snapshot_id") != snapshot[0]:
            return {"ok": False, "error": "unconfirmed_snapshot"}
        action = params.get("action", "auto")
        if action not in ("auto", "hide", "summarize"):
            return {"ok": False, "error": "invalid_action"}
        keep_lines = params.get("keep_lines")
        if keep_lines is not None and action != "hide":
            return {"ok": False, "error": "invalid_keep_lines_action"}
        summaries = params.get("summaries")
        if summaries is not None and not isinstance(summaries, dict):
            return {"ok": False, "error": "invalid_summaries"}
        if isinstance(summaries, dict):
            for k, v in summaries.items():
                if not isinstance(k, str) or not isinstance(v, str):
                    return {"ok": False, "error": "invalid_summaries"}

        items = []
        for call_id in dict.fromkeys(want):
            record = snapshot[1].get(call_id)
            if record is None:
                items.append({"tool_call_id": call_id, "ok": False, "error": "not_found"})
                continue
            err = self._cleanup_error(scope, record)
            if err is not None:
                items.append({"tool_call_id": record.call_id, "ok": False, "error": err})
                continue

            summary_text = None
            if isinstance(summaries, dict):
                summary_text = summaries.get(record.call_id)

            do_summarize = False
            if action == "summarize":
                do_summarize = True
            elif action == "auto":
                do_summarize = isinstance(summary_text, str) and bool(summary_text.strip())

            if do_summarize:
                if not isinstance(summary_text, str) or not summary_text.strip():
                    items.append({"tool_call_id": record.call_id, "ok": False, "error": "summarizer_unavailable"})
                    continue
                required = required_evidence_lines(record.content)
                validated = validate_summary_text(record.content, {"summary": summary_text}, required, invocation=record.invocation)
                if validated is None:
                    items.append({"tool_call_id": record.call_id, "ok": False, "error": "verification_failed"})
                    continue

                class _SuppliedSummarizer:
                    async def summarize(self, original, required_evidence, on_call=None, *, invocation=None, context=None):
                        return {"summary": summary_text}

                result = _run_sync(self.engine.summarize(scope, record, _SuppliedSummarizer()))
            else:
                result = self.engine.compact_sync(scope, record, keep_lines=keep_lines)

            if result.ok and result.plan is not None and result.item is not None:
                self._fence_set(scope, record, result.item, "summarize" if do_summarize else "compact")
                items.append({"tool_call_id": record.call_id, "ok": True, "item_id": result.plan.item_id})
            else:
                items.append({"tool_call_id": record.call_id, "ok": False, "error": result.error or "not_found"})
            if result.keep_lines_ignored:
                items[-1]["keep_lines_ignored"] = list(result.keep_lines_ignored)
            if result.keep_lines_normalized:
                items[-1]["keep_lines_normalized"] = list(result.keep_lines_normalized)

        applied = sum(1 for row in items if row.get("ok"))
        ok_all = all(bool(row.get("ok")) for row in items) if items else True
        return {"ok": ok_all, "applied": applied, "failed": len(items) - applied, "items": items}


def main():
    daemon = Daemon()
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid_request")
            response = daemon.handle(request)
            response["id"] = request.get("id")
        except Exception:
            try:
                rid = json.loads(line).get("id")
            except Exception:
                rid = None
            response = {"ok": False, "error": "invalid_request", "id": rid}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
