"""Session navigation common engine orchestrating store, policy, and summarization."""
from __future__ import annotations

import asyncio
import copy
from dataclasses import replace
from typing import Any

from session_navigation.model import (
    ContextItem,
    EngineConfig,
    ItemMetadata,
    MutationResult,
    ReplacementPlan,
    Scope,
    SpanChoice,
    ToolResultRecord,
    _item_id,
)
from session_navigation.policy import (
    RuleSpanSelector,
    excerpts_are_exact,
    refusal_reason,
    render_compaction,
    required_evidence_lines,
    verified_facts,
    normalize_keep_lines,
)
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.summary import selectable_text, validate_summary_text
from session_navigation.transport import Summarizer


def _run_sync(coro):
    """Run a coroutine from sync code, tolerating a running event loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _scope_key(scope):
    if hasattr(scope, 'scope_key') and callable(scope.scope_key):
        return str(scope.scope_key())
    return str(scope)


class SessionNavigationEngine:
    """Host-neutral tool result summarization and context compaction engine."""

    def __init__(
        self,
        store: SQLiteContextStore | None = None,
        config: EngineConfig | None = None,
    ) -> None:
        self.config = config or EngineConfig()
        self.store = store or SQLiteContextStore()

    async def _apply(
        self, scope: Scope, record: ToolResultRecord, summarizer: Summarizer | None = None,
        *, options_omitted: bool = False, allow_fallback: bool = True,
        keep_lines: list[str] | None = None,
    ) -> MutationResult:
        if keep_lines is not None and summarizer is not None:
            return MutationResult(ok=False, error="invalid_keep_lines_action")
        if keep_lines is not None and not isinstance(keep_lines, list):
            return MutationResult(ok=False, error="invalid_keep_lines")
        accepted, ignored, normalized = normalize_keep_lines(selectable_text(record.content), keep_lines or [])
        result = await self._apply_validated(scope, record, summarizer,
            options_omitted=options_omitted, allow_fallback=allow_fallback, keep_lines=accepted)
        return replace(result, keep_lines_ignored=tuple(ignored), keep_lines_normalized=tuple(normalized))

    async def _apply_validated(
        self,
        scope: Scope,
        record: ToolResultRecord,
        summarizer: Summarizer | None = None,
        *,
        options_omitted: bool = False,
        allow_fallback: bool = True,
        keep_lines: list[str] | None = None,
    ) -> MutationResult:
        """Compact/summarize a tool result. Fail-open on any failure.
        Guarantees: Fail-Open on any failure. Never crashes host loop.
        """
        rule_source = selectable_text(record.content)
        # 1. Policy & input validation
        refusal = refusal_reason(record, self.config)
        if refusal is not None:
            return MutationResult(ok=False, error=refusal)

        item_id = _item_id(
            _scope_key(scope),
            record.call_id,
            record.content_sha256,
            record.invocation_digest,
            record.result_position,
        )

        # 2. Re-compaction / Cache check (Re-summary exclusion)
        existing = self.store.get(scope, item_id)
        if existing is not None:
            if keep_lines and any(line not in existing.compacted for line in keep_lines):
                return MutationResult(ok=False, error="keep_lines_conflict")
            if existing.invocation_digest is not None and existing.invocation_digest != record.invocation_digest:
                return MutationResult(ok=False, error="invocation_conflict")
            if existing.visibility != "hidden":
                from dataclasses import replace
                updated = replace(existing, visibility="hidden", version=existing.version + 1)
                put_res = self.store.put(scope, updated, expected_version=existing.version)
                if not put_res.ok:
                    return put_res
                plan = ReplacementPlan(
                    item_id=updated.item_id,
                    expected_content_sha256=record.content_sha256,
                    replacement_text=updated.compacted,
                    visibility_version=updated.version,
                    tool_call_id=record.call_id,
                    host_handle=record.host_handle,
                )
                return MutationResult(ok=True, plan=plan, item=updated)
            plan = ReplacementPlan(
                item_id=existing.item_id,
                expected_content_sha256=record.content_sha256,
                replacement_text=existing.compacted,
                visibility_version=existing.version,
                tool_call_id=record.call_id,
                host_handle=record.host_handle,
            )
            return MutationResult(ok=True, plan=plan, item=existing)

        # 3. Baseline Rule Excerpt check
        selector = RuleSpanSelector(
            head_excerpts=self.config.head_excerpts,
            tail_excerpts=self.config.tail_excerpts,
            max_evidence=self.config.max_evidence_excerpts,
            max_line_length=self.config.max_excerpt_line_length,
        )
        baseline = selector.select(rule_source, keep_lines=tuple(keep_lines)) if keep_lines else selector.select(rule_source)
        if baseline is None:
            return MutationResult(ok=False, error="verification_failed")

        # 4. Pending reservation
        token, reserve_err = self.store.reserve(scope, item_id, record.invocation_digest)
        if reserve_err is not None:
            return MutationResult(ok=False, error=reserve_err)

        try:
            required = required_evidence_lines(record.content)
            rule_required = required_evidence_lines(rule_source)
            choice: SpanChoice | None = None

            # 5. Summarization attempt
            model_error: str | None = None
            if summarizer is not None:
                try:
                    summary_dict = await summarizer.summarize(
                        record.content,
                        required,
                        invocation=record.invocation,
                    )
                    choice = SpanChoice(required, "llm", summary_dict)
                except Exception as exc:
                    model_error = getattr(exc, "reason", None)
                    if not isinstance(model_error, str) or not model_error:
                        model_error = "summarization_failed"
                    if not allow_fallback:
                        self.store.release(scope, item_id, token)
                        return MutationResult(ok=False, error=model_error)
                    choice = None

            # Cancellation check
            task = asyncio.current_task()
            if task is not None and task.cancelling():
                raise asyncio.CancelledError

            # 6. Shared compaction decision (validation, rendering, bounds, final check)
            from session_navigation.compaction import evaluate_compaction
            choice, rendered, err = evaluate_compaction(
                original=record.content,
                item_id=item_id,
                rule_source=rule_source,
                baseline=baseline,
                choice=choice,
                invocation=record.invocation,
                options_omitted=options_omitted,
                allow_fallback=allow_fallback,
            )
            if err is not None:
                self.store.release(scope, item_id, token)
                return MutationResult(ok=False, error=err)
            if rendered is None:
                self.store.release(scope, item_id, token)
                return MutationResult(ok=False, error="verification_failed")

            # 7. Item construction & Store commit
            item = ContextItem(
                item_id=item_id,
                tool_call_id=record.call_id,
                content_sha256=record.content_sha256,
                original=record.content,
                compacted=rendered,
                excerpt_lines=choice.lines,
                visibility="hidden",
                version=1,
                expires_at=0.0,
                tool_name=record.invocation.get("tool_name"),
                compaction_source=choice.source,
                invocation_snapshot=copy.deepcopy(record.invocation) if choice.source == "llm" else None,
                invocation_digest=record.invocation_digest,
                context_hint=None,
                invocation_options_omitted=options_omitted if choice.source == "llm" else False,
                result_position=record.result_position,
            )
            put_res = self.store.put(scope, item, reservation=token)
            if not put_res.ok:
                return put_res

            plan = ReplacementPlan(
                item_id=item.item_id,
                expected_content_sha256=record.content_sha256,
                replacement_text=rendered,
                visibility_version=item.version,
                tool_call_id=record.call_id,
                host_handle=record.host_handle,
            )
            return MutationResult(ok=True, plan=plan, item=item)

        finally:
            self.store.release(scope, item_id, token)

    async def compact(
        self,
        scope: Scope,
        record: ToolResultRecord,
        *,
        options_omitted: bool = False,
        keep_lines: list[str] | None = None,
    ) -> MutationResult:
        """Deterministic compact (rule-based). No LLM call."""
        return await self._apply(scope, record, summarizer=None, options_omitted=options_omitted, allow_fallback=True, keep_lines=keep_lines)

    async def summarize(
        self,
        scope: Scope,
        record: ToolResultRecord,
        summarizer: Summarizer,
        *,
        options_omitted: bool = False,
    ) -> MutationResult:
        """LLM-based summarize. No silent fallback to rule on failure."""
        return await self._apply(scope, record, summarizer=summarizer, options_omitted=options_omitted, allow_fallback=False)

    def compact_sync(
        self,
        scope: Scope,
        record: ToolResultRecord,
        *,
        summarizer: Summarizer | None = None,
        options_omitted: bool = False,
        keep_lines: list[str] | None = None,
    ) -> MutationResult:
        """Synchronously compact content with an optional model and rule fallback."""
        return _run_sync(self._apply(
            scope, record, summarizer=summarizer,
            options_omitted=options_omitted, allow_fallback=True,
            keep_lines=keep_lines,
        ))

    def list_items(self, scope: Scope, query: str = "") -> list[ItemMetadata]:
        """List metadata of context items belonging to scope."""
        raw_items = self.store.items(scope)
        results: list[ItemMetadata] = []
        for item in raw_items:
            if query and query.lower() not in item.compacted.lower() and query.lower() not in item.item_id.lower():
                continue
            results.append(
                ItemMetadata(
                    item_id=item.item_id,
                    call_id=item.tool_call_id,
                    content_sha256=item.content_sha256,
                    visibility=item.visibility,
                    version=item.version,
                    expires_at=item.expires_at,
                    source=item.compaction_source,
                    bytes_size=item.bytes_size,
                    tool_name=item.tool_name,
                    excerpt_lines=item.excerpt_lines,
                    summary=item.compacted,
                    invocation_digest=item.invocation_digest,
                    result_position=item.result_position,
                    created_at=item.created_at,
                    updated_at=item.updated_at,
                )
            )
        return results

    def restore(self, scope: Scope, item_id: str, expected_version: int | None = None) -> MutationResult:
        """Restore item, marking visibility as visible without re-running tools."""
        return self.store.restore(scope, item_id, expected_version=expected_version)

    def project(self, scope: Scope, records: list[ToolResultRecord]) -> list[ReplacementPlan]:
        """Generate replacement plans for host transcript mutation."""
        plans: list[ReplacementPlan] = []
        for record in records:
            item_id = _item_id(
                _scope_key(scope),
                record.call_id,
                record.content_sha256,
                record.invocation_digest,
                record.result_position,
            )
            item = self.store.get(scope, item_id)
            if item is not None and item.visibility == "hidden":
                plans.append(
                    ReplacementPlan(
                        item_id=item.item_id,
                        expected_content_sha256=record.content_sha256,
                        replacement_text=item.compacted,
                        visibility_version=item.version,
                        tool_call_id=record.call_id,
                        host_handle=record.host_handle,
                    )
                )
        return plans
