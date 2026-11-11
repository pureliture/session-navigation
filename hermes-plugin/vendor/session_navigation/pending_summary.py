"""CAS settlement of an explicitly requested cross-surface summary."""
from dataclasses import replace
import re

from .model import MutationResult
from .policy import required_evidence_lines
from .summary import validate_summary_text


def settle_summary(store, scope, item_id: str, expected_version: int, text: str | None) -> MutationResult:
    item = store.get(scope, item_id)
    if item is None or item.version != expected_version:
        return MutationResult(ok=False, error="version_conflict", item=item)
    if item.visibility != "hidden" or item.compaction_source != "summarize_pending":
        return MutationResult(ok=False, error="not_pending", item=item)
    valid = False
    if isinstance(text, str) and text.strip() and len(text) < len(item.original):
        grounded = set(re.findall(r"\w{4,}", item.original.lower())) & set(re.findall(r"\w{4,}", text.lower()))
        valid = bool(grounded) and validate_summary_text(item.original, {"summary": text},
            required_evidence_lines(item.original), invocation=item.invocation_snapshot) is not None
    updated = replace(item, compacted=text if valid else item.compacted,
                      compaction_source="llm_summary" if valid else "explicit_user_hide", version=item.version + 1)
    result = store.put(scope, updated, expected_version=expected_version)
    if result.ok and text is not None and not valid:
        return MutationResult(ok=False, error="verification_failed", item=result.item)
    return result
