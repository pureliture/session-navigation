"""Strict JSON-aware projection regression tests (synthetic fixtures only)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.json_projection import (
    project_json_tool_result,
    verify_projection,
)
from session_navigation.model import (
    Scope,
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.policy import required_evidence_lines

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[1] / "contracts/fixtures/json_projection.json").read_text()
)


def _record(content: str, tool_name: str, call_id: str = "call_json") -> ToolResultRecord:
    inv = {"tool_name": tool_name, "arguments": {"pattern": "synthetic"}}
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


def _content(case: dict) -> str:
    if "raw" in case:
        return case["raw"]
    if "generate" in case:
        spec = case["generate"]
        kind = spec["kind"]
        if kind == "repeat":
            value = spec["prefix"] + spec["char"] * spec["count"]
            data = {"files": [value], "total_count": case["total_count"]}
        elif kind == "matches":
            width = spec["line_chars"]
            lines = []
            for index in range(spec["line_count"]):
                if index == spec["special_line"]:
                    text = spec["special_text"]
                else:
                    text = f"Synthetic match row {index:02d} " + "alpha beta gamma " * 12
                lines.append(text[:width])
            data = {
                "matches_format": "Synthetic format: path:line:text",
                "matches_text": "\n".join(lines),
                "total_count": len(lines),
                "total_count_is_lower_bound": False,
                "truncated": False,
                "_hint": "Synthetic hint for the matches projection.",
            }
        elif kind == "files":
            count = spec["file_count"]
            evidence_count = spec.get("evidence_count", count)
            path_width = spec["path_chars"]
            padding_width = spec.get("padding_chars", path_width)
            files = []
            for index in range(count):
                if index < evidence_count:
                    suffix = f"row-{index:03d}.txt"
                    files.append("synthetic/fixtures/" + ("x" * max(0, path_width - 19 - len(suffix))) + suffix)
                else:
                    files.append(("synthetic filler " + "alpha beta gamma " * 40)[:padding_width])
            data = {"files": files, "total_count": count}
        elif kind == "plain_text":
            width = spec["line_chars"]
            lines = []
            for index in range(spec["line_count"]):
                text = f"Synthetic plain text row {index:03d} " + "alpha beta gamma " * 20
                lines.append(text[:width])
            return "\n".join(lines)
        else:
            raise AssertionError(f"unknown fixture generator: {kind}")
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return json.dumps(case["data"], ensure_ascii=False, separators=(",", ":"))


def _case(case_id: str) -> dict:
    return next(case for case in FIXTURES["cases"] if case["id"] == case_id)


@pytest.mark.parametrize("case", FIXTURES["cases"])
def test_fixture_decision_matches_contract(case: dict):
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    expected = case["expected"]
    if expected["refusal"] is not None:
        assert decision.refusal == expected["refusal"]
        assert decision.projection is None
        return
    assert decision.refusal is None
    if expected["schema"] is None:
        assert decision.projection is None
        return
    assert decision.projection is not None
    assert decision.projection.schema == expected["schema"]
    assert verify_projection(raw, case["tool_name"], decision.projection)
    assert all(len(line) <= 240 for line in decision.projection.lines)
    assert all(line in decision.projection.lines for line in decision.projection.required)
    assert set(required_evidence_lines(decision.projection.source)).issubset(decision.projection.required)


def test_matches_projection_compacts_and_restores_byte_exact():
    case = _case("matches_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-matches")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert result.plan is not None
    rendered = result.plan.replacement_text
    assert "Projected JSON excerpt:" in rendered
    assert "Original excerpt:" not in rendered
    assert len(rendered) < len(raw)
    assert result.plan.expected_content_sha256 == compute_sha256(raw)
    assert result.item is not None and result.item.original == raw
    restored = engine.restore(scope, result.item.item_id)
    assert restored.ok is True
    assert restored.item is not None and restored.item.original == raw


def test_files_projection_compacts_and_restores_byte_exact():
    case = _case("files_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-files")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert result.plan is not None
    assert "Projected JSON excerpt:" in result.plan.replacement_text
    assert result.item is not None and result.item.original == raw
    assert engine.restore(scope, result.item.item_id).ok is True


def test_middle_evidence_is_required_and_rendered():
    case = _case("matches_success")
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    projection = decision.projection
    assert projection is not None
    evidence = [line for line in projection.lines if "synthetic/middle/evidence.txt" in line]
    assert len(evidence) == 1
    assert evidence[0] in projection.required
    engine = SessionNavigationEngine()
    result = engine.compact_sync(Scope("hermes", "test", "sess-json-middle"), _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert evidence[0] in result.plan.replacement_text


def test_metadata_substring_does_not_create_required_line():
    case = _case("metadata_substring")
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    projection = decision.projection
    assert projection is not None
    assert len(projection.required) == 4
    assert not any("total_count = synthetic note" in line for line in projection.required)


def test_long_single_line_failures_stay_fail_closed():
    for case_id in (
        "duplicate_key", "malformed_json", "protected_error", "protected_business_state",
        "sensitive_value", "nested_value", "oversized_value", "split_evidence_boundary",
        "evidence_budget",
    ):
        case = _case(case_id)
        raw = _content(case)
        engine = SessionNavigationEngine()
        scope = Scope("hermes", "test", f"sess-json-{case_id}")
        result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
        assert result.ok is False
        assert result.error == case["expected"]["refusal"]
        assert result.item is None
        assert result.plan is None


@pytest.mark.parametrize("case_id", ["plain_text_success", "plain_text_large"])
def test_plain_text_falls_back_to_legacy_path(case_id: str):
    case = _case(case_id)
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    assert decision.projection is None
    assert decision.refusal is None
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-json-{case_id}")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert "Original excerpt:" in result.plan.replacement_text
    assert "Projected JSON excerpt:" not in result.plan.replacement_text
    assert result.item is not None and result.item.original == raw
    assert engine.restore(scope, result.item.item_id).ok is True


def test_keep_lines_are_normalized_against_projection_source():
    case = _case("matches_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-keep")
    result = engine.compact_sync(
        scope, _record(raw, case["tool_name"]), keep_lines=["배송 상태 확인", "Synthetic match row 03"]
    )
    assert result.ok is True, result.error
    assert result.keep_lines_ignored == ()
    assert "배송 상태 확인" in result.plan.replacement_text


def test_keep_lines_reject_newline_and_budget():
    case = _case("matches_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-keep-invalid")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]), keep_lines=["alpha\nbeta", "x" * 1100])
    assert result.ok is True, result.error
    assert len(result.keep_lines_ignored) == 2
    assert all(entry.get("reason") for entry in result.keep_lines_ignored)


def test_summarizer_path_does_not_claim_projection():
    case = _case("matches_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-summary")

    class RefusingSummarizer:
        async def summarize(self, source, required, *, invocation=None, context=None):
            raise RuntimeError("No model calls in regression tests")

    result = asyncio.run(
        engine._apply(scope, _record(raw, case["tool_name"]), summarizer=RefusingSummarizer())
    )
    assert result.ok is False
    assert result.error in {"summarization_failed", "verification_failed"}
