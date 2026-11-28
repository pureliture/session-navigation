"""Synthetic parity tests for bounded JSON protection. No model calls."""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from session_navigation.engine import SessionNavigationEngine
from session_navigation.json_protection import is_json_like, refusal_reason_for_record
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

    def test_read_file_envelopes_hide_and_summarize_without_protection_refusal(self) -> None:
        envelopes = (
            READ_ENVELOPE,
            READ_ENVELOPE.replace("[~/fixture.txt#267D]", "[fixture.txt#267D]"),
            READ_ENVELOPE.replace("[~/fixture.txt#267D]", "[tests/test_json_protection.py#77C3]"),
            READ_ENVELOPE.replace("[~/fixture.txt#267D]", "[01-migration.sql#1A2B]"),
            READ_ENVELOPE.replace("[~/fixture.txt#267D]", "[.worktrees/session-navigation/pyproject.toml#D83D]"),
            "[Skill file: /opt/skills/paseo/SKILL.md]\n---\n"
            + "\n".join(f"Step {i}: routine skill instruction line" for i in range(80)),
        )
        for idx, env_text in enumerate(envelopes):
            with self.subTest(idx=idx):
                self.assertFalse(is_json_like(env_text))
                self.assertIsNone(refusal_reason_for_record(make_record(env_text)))
                with tempfile.TemporaryDirectory(prefix=f"json-protection-env-{idx}-") as directory:
                    store = SQLiteContextStore(db_path=str(Path(directory) / "state.db"))
                    engine = SessionNavigationEngine(store=store)
                    summarizer = DummySummarizer()
                    hide_scope = Scope(adapter_id="omp", host_profile="synthetic", session_id=f"env-hide-{idx}")
                    sum_scope = Scope(adapter_id="omp", host_profile="synthetic", session_id=f"env-sum-{idx}")
                    try:
                        hide_res = asyncio.run(engine.compact(hide_scope, make_record(env_text)))
                        self.assertTrue(hide_res.ok, hide_res.error)
                        assert hide_res.item is not None
                        self.assertIn("Original excerpt", hide_res.item.compacted)

                        sum_res = asyncio.run(engine.summarize(sum_scope, make_record(env_text), summarizer))
                        self.assertTrue(sum_res.ok, sum_res.error)
                        self.assertEqual(summarizer.calls, 1)
                        assert sum_res.item is not None
                        self.assertEqual(sum_res.item.original, env_text)
                        restored = engine.restore(sum_scope, sum_res.item.item_id)
                        self.assertTrue(restored.ok)
                        assert restored.item is not None
                        self.assertEqual(restored.item.original, env_text)
                    finally:
                        store.close()

    def test_clean_json_summarizes_and_abnormal_array_whitespace_fails_closed(self) -> None:
        clean_json = json.dumps(
            {"padding": PAD * 2, "status": "ok", "items": ["alpha", "beta", "gamma"]}
        )
        self.assertTrue(is_json_like(clean_json))
        self.assertIsNone(refusal_reason_for_record(make_record(clean_json)))
        with tempfile.TemporaryDirectory(prefix="json-protection-clean-") as directory:
            store = SQLiteContextStore(db_path=str(Path(directory) / "state.db"))
            engine = SessionNavigationEngine(store=store)
            summarizer = DummySummarizer()
            scope = Scope(adapter_id="omp", host_profile="synthetic", session_id="clean-json")
            try:
                res = asyncio.run(engine.summarize(scope, make_record(clean_json), summarizer))
                self.assertTrue(res.ok, res.error)
                self.assertEqual(summarizer.calls, 1)
            finally:
                store.close()

        suspicious_payloads = (
            f'[\f"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[\u00a0"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[\ufeff"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[\x1c"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[\v"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[\u200b"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[,"{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f"['{PAD * 2}', '\\u0045RROR: unresolved synthetic failure']",
            f'[NaN, "{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f'[invalid, "{PAD * 2}", "\\u0045RROR: unresolved synthetic failure"]',
            f"[note] {PAD * 2}",
            f"[2026-11-28] {PAD * 2}",
        )
        for payload in suspicious_payloads:
            with self.subTest(payload=repr(payload[:24])):
                self.assertTrue(is_json_like(payload))
                self.assert_protected(payload)

    def test_envelope_header_over_json_body_never_bypasses_protection(self) -> None:
        spoofed_json = f'[fixture.txt#267D]\n{{"padding":"{PAD * 2}","doc":"\\u0045RROR: unresolved charge"}}'
        spoofed_array = f'[fixture.txt#267D]\n[\f"{PAD * 2}", "\\u0045RROR: unresolved charge"]'
        double_header = f'[a.txt#1234]\n[b.txt#5678]\n{{"padding":"{PAD * 2}","doc":"\\u0045RROR: unresolved charge"}}'
        nested_spoof = json.dumps(
            {
                "padding": PAD * 2,
                "outer": '[fixture.txt#267D]\n{"payload":"\\u0045RROR: unresolved charge"}',
            }
        )
        self.assertEqual(refusal_reason_for_record(make_record(spoofed_json)), "protected_error")
        self.assertEqual(refusal_reason_for_record(make_record(spoofed_array)), "verification_failed")
        self.assertEqual(refusal_reason_for_record(make_record(double_header)), "verification_failed")
        self.assertEqual(refusal_reason_for_record(make_record(nested_spoof)), "protected_error")
        for payload in (spoofed_json, spoofed_array, double_header, nested_spoof):
            self.assert_protected(payload)

if __name__ == "__main__":
    unittest.main()
