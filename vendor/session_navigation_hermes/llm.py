"""Hermes adapter summarizer backed by the host ``ctx.llm`` facade (D5)."""

from __future__ import annotations

import json
import time
from typing import Any

from session_navigation.policy import required_evidence_lines
from session_navigation.summary import validate_summary_text
from session_navigation.transport import Summarizer, SummarizerError, SummarizerUnavailable


class CtxLlmSummarizer:
    def __init__(
        self,
        ctx: Any,
        *,
        store: Any = None,
        scope_key: str | None = None,
        timeout: float = 25.0,
        max_tokens: int = 384,
    ) -> None:
        self._ctx = ctx
        self._store = store
        self._scope_key = scope_key
        self._timeout = timeout
        self._max_tokens = max_tokens
        self.current_scope_key: str | None = scope_key

    @property
    def ctx_llm(self) -> Any:
        return getattr(self._ctx, "llm", None)

    async def summarize(
        self,
        original: str,
        required_evidence: tuple[str, ...] | list[str],
        on_call: Any = None,
        *,
        invocation: dict[str, Any] | None = None,
        context: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        llm = self.ctx_llm
        if llm is None:
            raise SummarizerUnavailable("summarizer_unavailable")

        scope_key = None
        if isinstance(context, dict):
            scope_key = context.get("scope_key") or context.get("scope")
        if scope_key is None:
            scope_key = self.current_scope_key
        if scope_key is None:
            scope_key = self._scope_key

        required_evidence = required_evidence_lines(original)
        messages = [
            {
                "role": "system",
                "content": (
                    "Summarize the tool result. Reply with JSON only: "
                    '{"summary": "<concise factual summary>"}.'
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {"source": original, "required_evidence": list(required_evidence)},
                    ensure_ascii=False,
                ),
            },
        ]

        if on_call is not None:
            on_call()

        try:
            result = llm.complete(
                messages=messages,
                timeout=self._timeout,
                max_tokens=self._max_tokens,
                purpose="session-navigation-summarize",
            )
        except Exception as exc:
            reason = getattr(exc, "reason", None) or getattr(exc, "code", None)
            if not isinstance(reason, str) or not reason:
                reason = "request_failed"
            raise SummarizerUnavailable(reason) from exc

        text = getattr(result, "text", None)
        if not isinstance(text, str):
            raise SummarizerUnavailable("missing_text")

        try:
            decoded = json.loads(text)
        except (ValueError, TypeError):
            raise SummarizerUnavailable("invalid_json") from None
        if not isinstance(decoded, dict) or set(decoded) != {"summary"}:
            raise SummarizerUnavailable("invalid_schema")

        summary = validate_summary_text(
            original, decoded, required_evidence, invocation=invocation,
        )
        if summary is None:
            raise SummarizerUnavailable("verification_failed")

        usage = getattr(result, "usage", None)
        if self._store is not None and hasattr(self._store, "record_call"):
            prompt_tokens = getattr(usage, "input_tokens", 0) if usage is not None else 0
            completion_tokens = getattr(usage, "output_tokens", 0) if usage is not None else 0
            total_tokens = getattr(usage, "total_tokens", 0) if usage is not None else 0
            cost_usd = getattr(usage, "cost_usd", None) if usage is not None else None
            call_key = f"ctx_llm:{id(result)}"
            audit = getattr(result, "audit", None)
            if isinstance(audit, dict):
                response_id = audit.get("response_id") or audit.get("id")
                if isinstance(response_id, str) and response_id:
                    call_key = response_id
            try:
                self._store.record_call(
                    scope_key if isinstance(scope_key, str) else "",
                    call_key,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    cost_usd=cost_usd,
                    recorded_at=time.time(),
                )
            except TypeError:
                try:
                    self._store.record_call(
                        scope_key if isinstance(scope_key, str) else "",
                        call_key,
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                        cost_usd,
                        time.time(),
                    )
                except Exception:
                    pass
            except Exception:
                pass

        return summary
