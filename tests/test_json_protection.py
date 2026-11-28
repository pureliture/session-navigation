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
LONG_PAD = "routine synthetic line " * 500
DOC_EXAMPLE = json.dumps({"padding": PAD, "doc": "ERROR: example in handling documentation"})
NESTED_ESCAPED = json.dumps(
    {"padding": PAD, "outer": '{"payload":"\\u0045RROR: unresolved charge"}'}
)
LONG_NESTED_ESCAPED = json.dumps(
    {"padding": LONG_PAD, "outer": '{"payload":"\\u0045RROR: unresolved charge"}'}
)
LITERAL_BACKSLASH = json.dumps({"padding": PAD, "outer": "\\u0045RROR: unresolved charge"})
DUPLICATE_KEYS = (
    '{"padding":"' + PAD + '","v":"routine","v":"\\u0045RROR: unresolved charge"}'
)
DEEP = "[" * 300 + '"' + PAD + '\\u0045RROR: unresolved charge"' + "]" * 300
READ_ENVELOPE = "[~/fixture.txt#267D]\n" + "\n".join(
    f"{index}:Output row {index - 1} details" for index in range(1, 101)
)
TOP_LEVEL_ARRAY = json.dumps(["ERROR: synthetic protected array row", LONG_PAD])


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

    def test_long_padded_json_still_detects_escaped_error(self) -> None:
        self.assert_protected(LONG_NESTED_ESCAPED)

    def test_json_like_prefix_whitespace_is_fail_closed(self) -> None:
        for prefix in ("\ufeff", "\x1c", "\x1f", "\x85"):
            with self.subTest(prefix=repr(prefix)):
                self.assert_protected(prefix + LONG_NESTED_ESCAPED)

    def test_literal_backslash_u_is_ordinary_text(self) -> None:
        self.assertIsNone(refusal_reason_for_record(make_record(LITERAL_BACKSLASH)))

    def test_top_level_array_error_is_protected(self) -> None:
        self.assert_protected(TOP_LEVEL_ARRAY)

    def test_read_file_envelope_is_not_treated_as_json(self) -> None:
        self.assertIsNone(refusal_reason_for_record(make_record(READ_ENVELOPE)))

    def test_read_file_envelope_hides_without_protection_refusal(self) -> None:
        with tempfile.TemporaryDirectory(prefix="json-protection-hide-") as directory:
            store = SQLiteContextStore(db_path=str(Path(directory) / "state.db"))
            engine = SessionNavigationEngine(store=store)
            scope = Scope(adapter_id="omp", host_profile="synthetic", session_id="read-envelope")
            try:
                result = asyncio.run(engine.compact(scope, make_record(READ_ENVELOPE)))
                self.assertTrue(result.ok, result.error)
                self.assertIsNotNone(result.item)
                assert result.item is not None
                self.assertIn("Original excerpt", result.item.compacted)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
