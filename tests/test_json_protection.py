"""Synthetic parity tests for bounded JSON protection. No model calls."""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from session_navigation.engine import SessionNavigationEngine
from session_navigation.json_protection import refusal_reason_for_record
from session_navigation.model import (
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.sqlite_store import SQLiteContextStore

PAD = "routine synthetic line " * 40
DOC_EXAMPLE = json.dumps({"padding": PAD, "doc": "ERROR: example in handling documentation"})
NESTED_ESCAPED = json.dumps(
    {"padding": PAD, "outer": '{"payload":"\\u0045RROR: unresolved charge"}'}
)
LITERAL_BACKSLASH = json.dumps({"padding": PAD, "outer": "\\u0045RROR: unresolved charge"})
DUPLICATE_KEYS = (
    '{"padding":"' + PAD + '","v":"routine","v":"\\u0045RROR: unresolved charge"}'
)
DEEP = "[" * 300 + '"' + PAD + '\\u0045RROR: unresolved charge"' + "]" * 300


class DummySummarizer:
    def __init__(self) -> None:
        self.calls = 0

    async def summarize(self, original, required_evidence, on_call=None, *, invocation=None, context=None):
        self.calls += 1
        return {"summary": "Synthetic compact note retained."}


def make_record(content: str) -> ToolResultRecord:
    invocation = {"tool_name": "read", "arguments": {"path": "synthetic.md"}}
    return ToolResultRecord(
        call_id="call-protection",
        result_position=0,
        content=content,
        content_sha256=compute_sha256(content),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
        status="ok",
    )


class JsonProtectionTest(unittest.TestCase):
    def assert_protected(self, content: str) -> None:
        record = make_record(content)
        reason = refusal_reason_for_record(record)
        self.assertIsNotNone(reason)
        self.assertNotEqual(reason, "not_long")

        with tempfile.TemporaryDirectory(prefix="json-protection-") as directory:
            store = SQLiteContextStore(db_path=str(Path(directory) / "state.db"))
            engine = SessionNavigationEngine(store=store)
            summarizer = DummySummarizer()
            scope = Scope(
                adapter_id="omp", host_profile="synthetic", session_id="protection"
            )
            try:
                result = asyncio.run(engine.summarize(scope, record, summarizer))
                self.assertFalse(result.ok)
                self.assertIsNone(result.item)
                self.assertEqual(summarizer.calls, 0)
                self.assertEqual(store.items(scope), ())
            finally:
                store.close()

    def test_document_error_example_keeps_original(self) -> None:
        self.assert_protected(DOC_EXAMPLE)

    def test_valid_nested_json_with_escaped_error(self) -> None:
        self.assert_protected(NESTED_ESCAPED)

    def test_duplicate_keys_keep_original(self) -> None:
        self.assert_protected(DUPLICATE_KEYS)

    def test_over_depth_json_keeps_original(self) -> None:
        self.assert_protected(DEEP)

    def test_literal_backslash_u_is_ordinary_text(self) -> None:
        self.assertIsNone(refusal_reason_for_record(make_record(LITERAL_BACKSLASH)))


if __name__ == "__main__":
    unittest.main()
