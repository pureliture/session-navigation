"""Envelope-shaped tool results must be selectable by the rule path.

Real Hermes sessions deliver tool results as single-line JSON envelopes:
``{"content": "1|..\\n2|..", "total_lines": ..}`` for read_file and
``{"output": "..", "exit_code": 0}`` for terminal runs. The rule selector works
line by line, so selection has to run on the decoded, line-number-free text the
reader sees — not on the raw envelope, which is one long escaped line that can
never be excerpted.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.policy import excerpts_are_exact, required_evidence_lines


def _record(content: str, call_id: str = "call_env") -> ToolResultRecord:
    inv = {"tool_name": "read_file", "arguments": {"path": "/synthetic/rows.txt"}}
    return ToolResultRecord(
        call_id=call_id,
        result_position=0,
        content=content,
        content_sha256=compute_sha256(content),
        invocation=inv,
        invocation_digest=compute_invocation_digest(inv),
        status="ok",
        host_handle={"index": 1},
    )


def _read_file_envelope(rows: int = 60) -> str:
    body = "\n".join(f"{i}|Synthetic row {i:03d} detail line" for i in range(1, rows + 1))
    return json.dumps(
        {
            "content": body,
            "total_lines": rows,
            "file_size": 4096,
            "truncated": False,
            "is_binary": False,
            "is_image": False,
            "not_found": False,
        }
    )


def _terminal_envelope(lines: int = 80) -> str:
    out = "\n".join(f"Synthetic trace line {i:03d}" for i in range(1, lines + 1))
    return json.dumps({"output": out, "exit_code": 0, "error": None})


def test_rule_path_compacts_read_file_envelope_and_restores():
    raw = _read_file_envelope()
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-env-read")

    result = engine.compact_sync(scope, _record(raw))
    assert result.ok is True, result.error
    assert result.plan is not None
    assert result.plan.expected_content_sha256 == compute_sha256(raw)

    rendered = result.plan.replacement_text
    assert "[hidden:" in rendered
    assert "원문 발췌:" in rendered
    assert len(rendered) < len(raw)
    # The line-number noise the read_file tool adds must not ride along.
    assert "1|Synthetic row" not in rendered
    assert "Synthetic row 001" in rendered

    # Restored items produce no replacement plan again.
    assert engine.restore(scope, result.plan.item_id).ok is True
    assert engine.project(scope, [_record(raw)]) == []


def test_rule_path_compacts_terminal_output_envelope():
    raw = _terminal_envelope()
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-env-out")

    result = engine.compact_sync(scope, _record(raw))
    assert result.ok is True, result.error
    assert result.plan is not None
    assert len(result.plan.replacement_text) < len(raw)
    assert "Synthetic trace line 001" in result.plan.replacement_text


def test_unknown_json_shape_still_refuses():
    """An envelope the decoder does not recognize must stay fail-open."""
    raw = json.dumps({"unmapped_entries": ["x" * 40 for _ in range(40)]})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-env-unknown")

    result = engine.compact_sync(scope, _record(raw))
    assert result.ok is False
    assert result.error == "verification_failed"


def test_llm_compacts_numbered_hermes_read_envelope_without_retaining_transport_pipes():
    raw = _read_file_envelope(500)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-env-summary")

    class Summarizer:
        async def summarize(self, original, required_evidence, **kwargs):
            assert original == raw
            assert required_evidence == ()
            return {"summary": "Synthetic rows contain detail lines."}

    result = asyncio.run(engine.summarize(scope, _record(raw), Summarizer()))
    assert result.ok, result.error
    assert result.item.compaction_source == "llm"
    assert "Synthetic rows contain detail lines." in result.plan.replacement_text
    assert len(result.plan.replacement_text.encode()) < len(raw.encode()) * 0.8
    assert result.plan.expected_content_sha256 == compute_sha256(raw)
    assert engine.restore(scope, result.plan.item_id).ok
    assert engine.project(scope, [_record(raw)]) == []


@pytest.mark.parametrize("key", ["content", "output"])
def test_decoded_envelope_retains_genuine_evidence_and_rejects_invented_lines(key):
    evidence = ("WARNING: constraints apply", "results/output.json", "10 tests passed; exit_code: 0")
    body = "\n".join([*(f"Ordinary row {i}" for i in range(80)), *evidence])
    raw = json.dumps({key: "\n".join(f"{i}|{line}" for i, line in enumerate(body.splitlines(), 1))})
    assert required_evidence_lines(raw) == evidence
    assert excerpts_are_exact(raw, evidence)
    assert not excerpts_are_exact(raw, ["Invented evidence"])

    class Summarizer:
        async def summarize(self, original, required_evidence, **kwargs):
            assert required_evidence == evidence
            return {"summary": "Ordinary rows with constraints. 10 tests passed."}

    result = asyncio.run(SessionNavigationEngine().summarize(Scope("hermes", "test", key), _record(raw), Summarizer()))
    assert result.ok, result.error
    assert all(line in result.plan.replacement_text for line in evidence)


@pytest.mark.parametrize("original", ["", '{"content":', '{"content": null}', '1|left\n3|right'])
def test_empty_malformed_and_unrecognized_envelopes_keep_exact_evidence_rules(original):
    expected = tuple(line for line in original.splitlines() if "|" in line)
    assert required_evidence_lines(original) == expected
    assert excerpts_are_exact(original, expected)


def test_numbered_envelope_protected_error_keeps_the_original():
    raw = json.dumps({"content": "1|FAILED verification\n2|" + "detail " * 400})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-env-error")
    record = _record(raw)
    result = engine.compact_sync(scope, record)
    assert not result.ok
    assert result.error == "protected_error"
    assert engine.project(scope, [record]) == []
