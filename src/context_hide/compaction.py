"""Shared compaction decision logic used by engine and store paths."""
from __future__ import annotations

from context_hide.policy import (
    excerpts_are_exact,
    render_compaction,
    required_evidence_lines,
    verified_facts,
)
from context_hide.summary import validate_summary_text


def evaluate_compaction(
    *,
    original: str,
    item_id: str,
    rule_source: str,
    baseline: object,
    choice: object | None,
    invocation: dict | None = None,
    options_omitted: bool = False,
    allow_fallback: bool = True,
) -> tuple[object | None, str | None, str | None]:
    """Return (final_choice, rendered, error). error None means success."""
    required = required_evidence_lines(original)
    rule_required = required_evidence_lines(rule_source)

    if choice is not None and getattr(choice, "source", None) == "llm":
        summary = validate_summary_text(
            original, getattr(choice, "summary_text", None), required, invocation=invocation,
        )
        if (
            getattr(choice, "summary_text", None) is None
            or not set(required).issubset(getattr(choice, "lines", ()))
            or not excerpts_are_exact(original, getattr(choice, "lines", ()))
            or summary is None
        ):
            if not allow_fallback:
                return None, None, "verification_failed"
            choice = baseline
        else:
            from context_hide.model import SpanChoice
            choice = SpanChoice(required, "llm", summary)
    else:
        choice = baseline

    rendered = render_compaction(
        item_id,
        getattr(choice, "lines", ()),
        summary_text=getattr(choice, "summary_text", None),
        facts=verified_facts(original),
        options_omitted=options_omitted,
    )
    if getattr(choice, "source", None) == "llm" and len(rendered.encode("utf-8")) > len(original.encode("utf-8")) * 0.8:
        if not allow_fallback:
            return None, None, "compression_insufficient"
        choice = baseline
        rendered = render_compaction(
            item_id,
            getattr(choice, "lines", ()),
            facts=verified_facts(original),
            options_omitted=options_omitted,
        )
    if len(rendered) >= len(original) and choice is not baseline:
        if not allow_fallback:
            return None, None, "compression_insufficient"
        choice = baseline
        rendered = render_compaction(
            item_id,
            getattr(choice, "lines", ()),
            facts=verified_facts(original),
            options_omitted=options_omitted,
        )

    if getattr(choice, "source", None) == "llm":
        check_source, check_required = original, required
    else:
        check_source, check_required = rule_source, rule_required
    if (
        not excerpts_are_exact(check_source, getattr(choice, "lines", ()))
        or any(line not in getattr(choice, "lines", ()) for line in check_required)
        or len(rendered) >= len(original)
    ):
        return None, None, "verification_failed"

    return choice, rendered, None