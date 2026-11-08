"""Session Navigation common engine package."""
from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    ContextItem,
    EngineConfig,
    ItemMetadata,
    MutationResult,
    ReplacementPlan,
    Scope,
    SpanChoice,
    ToolResultRecord,
    canonical,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.policy import (
    RuleSpanSelector,
    check_refusal_reason,
    excerpts_are_exact,
    is_business_state_critical,
    is_destructive_command,
    is_protected_error,
    refusal_reason,
    render_compaction,
    required_evidence_indexes,
    required_evidence_lines,
    validate_evidence_retention,
    verified_facts,
)
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.store import MemoryContextStore
from session_navigation.summary import (
    is_lossless_encoded,
    prepare_result_source,
    restore_lossless_source,
    restore_repeated_source,
    validate_summary_text,
    verify_exit_claims,
)
from session_navigation.transport import (
    OnCall,
    Summarizer,
    SummarizerError,
    SummarizerUnavailable,
)

__version__ = "0.1.0"

__all__ = [
    "SessionNavigationEngine",
    "ContextItem",
    "EngineConfig",
    "ItemMetadata",
    "LFMUnavailable",
    "MemoryContextStore",
    "SQLiteContextStore",
    "MutationResult",
    "OnCall",
    "ReplacementPlan",
    "RuleSpanSelector",
    "Scope",
    "SpanChoice",
    "Summarizer",
    "SummarizerError",
    "SummarizerUnavailable",
    "ToolResultRecord",
    "canonical",
    "check_refusal_reason",
    "compute_invocation_digest",
    "compute_sha256",
    "excerpts_are_exact",
    "is_business_state_critical",
    "is_destructive_command",
    "is_lossless_encoded",
    "is_protected_error",
    "prepare_result_source",
    "refusal_reason",
    "render_compaction",
    "required_evidence_indexes",
    "required_evidence_lines",
    "restore_lossless_source",
    "restore_repeated_source",
    "validate_evidence_retention",
    "validate_summary_text",
    "verified_facts",
    "verify_exit_claims",
    "__version__",
]


def __getattr__(name: str):
    """Resolve deprecated model-specific names lazily."""
    if name == "LFMUnavailable":
        from session_navigation.transport import __getattr__ as transport_getattr

        return transport_getattr(name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
