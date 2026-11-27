"""Shared compaction decision logic used by engine and store paths."""
from __future__ import annotations

from session_navigation.policy import (
    excerpts_are_exact,
    render_compaction,
    required_evidence_lines,
    verified_facts,
)
from session_navigation.summary import validate_summary_text


def _lines_are_exact(
    original: str, lines: tuple[str, ...] | list[str], evidence: tuple[str, ...]
) -> bool:
    if evidence:
        return all(line in evidence for line in lines)
    return excerpts_are_exact(original, lines)


def evaluate_compaction(
    original: str,
    item_id: str,
    rule_source: str,
    baseline: object,
    choice: object | None,
    invocation: dict | None = None,
    options_omitted: bool = False,
    allow_fallback: bool = True,
    required_override: tuple[str, ...] | list[str] | None = None,
    rule_required_override: tuple[str, ...] | list[str] | None = None,
    excerpt_label: str = "Original excerpt",
    evidence_source: tuple[str, ...] | list[str] | None = None,
) -> tuple[object | None, str | None, str | None]:
    """Return (final_choice, rendered, error). error None means success."""
    evidence = tuple(evidence_source) if evidence_source is not None else ()
    required = tuple(required_override) if required_override is not None else required_evidence_lines(original)
    rule_required = tuple(rule_required_override) if rule_required_override is not None else required_evidence_lines(rule_source)

    if choice is not None and getattr(choice, "source", None) == "llm":
        summary = validate_summary_text(
            original, getattr(choice, "summary_text", None), required, invocation=invocation,
            evidence_source=evidence,
        )
        if (
            getattr(choice, "summary_text", None) is None
            or not set(required).issubset(getattr(choice, "lines", ()))
            or not _lines_are_exact(original, getattr(choice, "lines", ()), evidence)
            or summary is None
        ):
            if not allow_fallback:
                return None, None, "verification_failed"
            choice = baseline
        else:
            from session_navigation.model import SpanChoice
            choice = SpanChoice(required, "llm", summary)
    else:
        choice = baseline

    rendered = render_compaction(
        item_id,
        getattr(choice, "lines", ()),
        summary_text=getattr(choice, "summary_text", None),
        facts=verified_facts(original),
        options_omitted=options_omitted,
        excerpt_label=excerpt_label,
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
            excerpt_label=excerpt_label,
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
            excerpt_label=excerpt_label,
        )

    if getattr(choice, "source", None) == "llm":
        check_source, check_required = original, required
        evidence_for_check = evidence
    else:
        check_source, check_required = rule_source, rule_required
        evidence_for_check = ()
    if (
        not _lines_are_exact(check_source, getattr(choice, "lines", ()), evidence_for_check)
        or any(line not in getattr(choice, "lines", ()) for line in check_required)
        or len(rendered) >= len(original)
    ):
        return None, None, "verification_failed"

    return choice, rendered, None