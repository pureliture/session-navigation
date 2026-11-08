"""Summary grounding: claims must come from the result, never invocation or purpose."""
from __future__ import annotations

from session_navigation.summary import validate_summary_text


def test_claims_are_grounded_in_result_not_invocation_or_purpose():
    invocation = {"tool_name": "read_file", "arguments": {"path": "invocation/only.py"}}
    assert validate_summary_text("Names use exact matching.", {"summary": "Names use exact matching."}, (), invocation=invocation) is not None
    assert validate_summary_text("Names use exact matching.", {"summary": "See invocation/only.py."}, (), invocation=invocation) is None
    assert validate_summary_text("10 tests passed.", {"summary": "999 tests passed."}, ()) is None
    assert validate_summary_text("10 tests passed.", {"summary": "Exit code 0."}, ()) is None
