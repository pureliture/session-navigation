"""Strict JSON-aware projection regression tests (synthetic fixtures only)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from session_navigation.json_projection import (
    project_json_tool_result,
    reconstruct_files_projection,
    verify_projection,
    verify_projection_render,
)
from session_navigation.engine import SessionNavigationEngine
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
            lines = []
            for index in range(spec["line_count"]):
                text = spec["special_text"] if index == spec["special_line"] else (
                    f"Synthetic match row {index:02d} " + "alpha beta gamma " * 12
                )
                lines.append(text[:spec["line_chars"]])
            data = {
                "matches_format": "Synthetic format: path:line:text",
                "matches_text": "\n".join(lines),
                "total_count": len(lines),
                "total_count_is_lower_bound": False,
                "truncated": False,
                "_hint": "Synthetic hint for the matches projection.",
            }
        elif kind == "matches_realistic":
            lines = []
            for index in range(spec["line_count"]):
                if index < spec["evidence_count"]:
                    prefix = f"synthetic/fixtures/row-{index:03d}.txt evidence=stable "
                    width = spec["long_chars"] if index < spec["long_count"] else spec["line_chars"]
                else:
                    prefix, width = "synthetic filler ", spec["line_chars"]
                lines.append((prefix + "alpha beta gamma " * 40)[:width])
            data = {
                "matches_format": "Synthetic format: path:line:text",
                "matches_text": "\n".join(lines),
                "total_count": len(lines),
                "total_count_is_lower_bound": False,
                "truncated": False,
                "_hint": "Synthetic hint for the realistic projection.",
            }
        elif kind == "files_basename":
            files = []
            for index in range(40):
                value = "synthetic-shared-basename-" + "x" * 250 + f"-row-{index % 20:02d}.txt"
                files.append(value)
            data = {"files": files, "total_count": len(files)}
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
        elif kind == "files_varied":
            files = [
                "alpha/first/one.txt", "beta/second/two.txt", "alpha/first/one.txt",
                "gamma/third/three.txt", "", "beta/second/two.txt", "delta/four/four.txt",
            ]
            data = {"files": files, "total_count": len(files)}
        elif kind == "files_empty":
            files = ["", "synthetic/alpha/one.txt", "synthetic/beta/two.txt", "synthetic/alpha/one.txt"]
            data = {"files": files, "total_count": len(files)}
        elif kind == "plain_text":
            lines = []
            for index in range(spec["line_count"]):
                text = f"Synthetic plain text row {index:03d} " + "alpha beta gamma " * 20
                lines.append(text[:spec["line_chars"]])
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
    projection = decision.projection
    assert projection is not None
    assert projection.schema == expected["schema"]
    assert verify_projection(raw, case["tool_name"], projection)
    line_limit = 1024 if projection.schema == "search_files_files_v2" else 240
    assert all(len(line) <= line_limit for line in projection.lines)
    assert all(line in projection.lines for line in projection.required)
    if projection.schema == "search_files_files_v2":
        parsed = json.loads(raw)
        assert reconstruct_files_projection(projection.source) == parsed["files"]
        assert f"items={len(parsed['files'])}" in projection.lines[0]
        assert f"verified={len(parsed['files'])}" in projection.lines[0]
        assert "prefix+suffix" in projection.lines[0]
    else:
        assert set(required_evidence_lines(projection.source)).issubset(projection.required)


@pytest.mark.parametrize("case_id", ["files_success", "files_realistic_shape"])
def test_files_projection_compacts_reconstructs_and_restores(case_id: str):
    case = _case(case_id)
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    projection = decision.projection
    assert projection is not None
    parsed = json.loads(raw)
    assert reconstruct_files_projection(projection.source) == parsed["files"]
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-{case_id}")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert result.plan is not None
    rendered = result.plan.replacement_text
    assert "prefix+suffix" in rendered
    assert "restore with unhide_context" in rendered
    assert len(rendered.encode("utf-8")) < len(raw.encode("utf-8"))
    assert verify_projection_render(rendered, raw, case["tool_name"], projection)
    label = "Projected JSON (prefix+suffix; restore with unhide_context): "
    marker = "The remaining result is preserved. Restore it with unhide_context("
    rows = rendered.split("\n", 1)[1].split(marker, 1)[0].rstrip("\n").split("\n")
    decoded = "\n".join(row[len(label):] for row in rows)
    assert reconstruct_files_projection(decoded) == parsed["files"]
    assert result.item is not None and result.item.original == raw
    assert engine.restore(scope, result.item.item_id).ok is True


def test_tampered_projection_is_rejected():
    case = _case("files_success")
    raw = _content(case)
    projection = project_json_tool_result(raw, case["tool_name"]).projection
    tampered = list(projection.lines)
    tampered[0] = tampered[0] + " tampered"
    from session_navigation.json_projection import JsonProjection
    bad = JsonProjection(
        schema=projection.schema, source="\n".join(tampered), lines=tuple(tampered),
        required=projection.required, digest=projection.digest,
    )
    assert verify_projection(raw, case["tool_name"], bad) is False


@pytest.mark.parametrize("case_id", [
    "matches_realistic_shape", "duplicate_key", "malformed_json", "nested_value",
    "oversized_value", "lone_surrogate",
])
def test_fail_closed_cases_stay_original(case_id: str):
    case = _case(case_id)
    raw = _content(case)
    engine = SessionNavigationEngine()
    result = engine.compact_sync(Scope("hermes", "test", f"sess-{case_id}"), _record(raw, case["tool_name"]))
    assert result.ok is False
    assert result.error == case["expected"]["refusal"]
    assert result.item is None and result.plan is None


@pytest.mark.parametrize("case_id", ["plain_text_success", "plain_text_large"])
def test_plain_text_falls_back_to_legacy_path(case_id: str):
    case = _case(case_id)
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    assert decision.projection is None and decision.refusal is None
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-{case_id}")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"]))
    assert result.ok is True, result.error
    assert "Original excerpt:" in result.plan.replacement_text
    assert "prefix+suffix" not in result.plan.replacement_text
    assert engine.restore(scope, result.item.item_id).ok is True


def test_keep_lines_are_normalized_against_projection_source():
    case = _case("files_success")
    raw = _content(case)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-json-keep")
    result = engine.compact_sync(
        scope, _record(raw, case["tool_name"]), keep_lines=["fixtures", "alpha\nbeta", "x" * 1100]
    )
    assert result.ok is True, result.error
    assert len(result.keep_lines_ignored) == 2
    conflict = engine.compact_sync(
        Scope("hermes", "test", "sess-json-keep-conflict"),
        _record(raw, case["tool_name"], "call_conflict"),
        keep_lines=["row-000"],
    )
    assert conflict.ok is False
    assert conflict.error == "keep_lines_conflict"


def test_summarizer_path_does_not_claim_projection():
    case = _case("files_success")
    raw = _content(case)
    engine = SessionNavigationEngine()

    class RefusingSummarizer:
        async def summarize(self, source, required, *, invocation=None, context=None):
            raise RuntimeError("No model calls in regression tests")

    result = asyncio.run(
        engine._apply(Scope("hermes", "test", "sess-json-summary"), _record(raw, case["tool_name"]), summarizer=RefusingSummarizer())
    )
    assert result.ok is False
