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
        elif kind == "matches_boundary":
            def _fill(unit: str, width: int) -> str:
                text = (unit * (width // len(unit) + 1))[:width]
                return text if text.endswith(" ") else text[:-1] + " "

            token = {
                "uuid": "01234567-89ab-cdef-0123-456789abcdef",
                "path": "synthetic/fixtures/invoice-2026-11-28.txt",
                "protected_error": "ERROR: unresolved synthetic failure remains protected",
                "none": "",
            }[spec["evidence"]]
            prefix = _fill(spec.get("prefix_unit", "alpha beta gamma "), spec.get("prefix_chars", 184))
            suffix = " " + _fill(spec.get("suffix_unit", "delta epsilon zeta "), spec.get("suffix_chars", 400) - 1)
            lines = [prefix + token + suffix, "synthetic tail row after boundary"]
            data = {
                "matches_format": "Synthetic format: path:line:text",
                "matches_text": "\n".join(lines),
                "total_count": len(lines),
                "total_count_is_lower_bound": False,
                "truncated": False,
                "_hint": "Synthetic hint for the long-evidence boundary.",
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


def _large_matches_content() -> str:
    lines = []
    for index in range(40):
        if index < 8:
            prefix = f"synthetic/fixtures/row-{index:03d}.txt evidence=stable "
        else:
            prefix = "synthetic filler "
        lines.append((prefix + "alpha beta gamma " * 8)[:100])
    data = {
        "matches_format": "Synthetic format: path:line:text",
        "matches_text": "\n".join(lines),
        "total_count": len(lines),
        "total_count_is_lower_bound": False,
        "truncated": False,
        "_hint": "Synthetic hint for the large matches projection.",
    }
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


@pytest.mark.parametrize(
    ("case_id", "raw"),
    [
        ("matches_success", _content(_case("matches_success"))),
        ("matches_large", _large_matches_content()),
    ],
)
def test_matches_projection_hides_verifies_and_restores(case_id: str, raw: str):
    decision = project_json_tool_result(raw, "search_files")
    projection = decision.projection
    assert decision.refusal is None
    assert projection is not None and projection.schema == "search_files_matches_v1"
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-{case_id}-projection")
    result = engine.compact_sync(scope, _record(raw, "search_files", f"call_{case_id}"))
    assert result.ok is True, result.error
    assert result.item is not None and result.plan is not None
    rendered = result.plan.replacement_text
    assert "Projected JSON excerpt:" in rendered
    assert "unhide_context(" in rendered
    assert len(rendered.encode("utf-8")) < len(raw.encode("utf-8"))
    assert verify_projection_render(rendered, raw, "search_files", projection)
    assert all(line in rendered for line in projection.required)
    assert result.item.original == raw
    restored = engine.restore(scope, result.item.item_id)
    assert restored.ok is True
    assert restored.item is not None and restored.item.original == raw


def test_matches_render_verification_fails_closed_on_tampering():
    raw = _content(_case("matches_success"))
    projection = project_json_tool_result(raw, "search_files").projection
    assert projection is not None
    engine = SessionNavigationEngine()
    result = engine.compact_sync(
        Scope("hermes", "test", "sess-matches-tamper"), _record(raw, "search_files", "call_tamper")
    )
    assert result.ok is True, result.error
    rendered = result.plan.replacement_text
    marker = "The remaining result is preserved. Restore it with unhide_context("
    head, body_and_tail = rendered.split("\n", 1)
    body, tail = body_and_tail.split(marker, 1)
    rows = body.rstrip("\n").split("\n")
    assert len(rows) >= 2

    def wrap(rows):
        return head + "\n" + "\n".join(rows) + "\n" + marker + tail

    assert verify_projection_render(wrap(rows), raw, "search_files", projection)
    label = "Projected JSON excerpt: "
    required_rows = [row for row in rows if row[len(label):] in projection.required]
    assert required_rows
    assert not verify_projection_render(
        wrap([row for row in rows if row != required_rows[0]]), raw, "search_files", projection
    )
    reordered = list(rows)
    reordered[0], reordered[-1] = reordered[-1], reordered[0]
    assert not verify_projection_render(wrap(reordered), raw, "search_files", projection)
    assert not verify_projection_render(
        wrap(rows + [label + "projected injected evidence"]), raw, "search_files", projection
    )
    assert not verify_projection_render(
        wrap(["Original excerpt:" + row[len(label):] for row in rows]),
        raw, "search_files", projection,
    )


LONG_EVIDENCE_CASE_IDS = (
    "matches_long_uuid_boundary",
    "matches_long_path_boundary",
    "matches_long_unicode_boundary",
    "matches_long_escape_boundary",
    "matches_long_protected_error",
)


@pytest.mark.parametrize("case_id", LONG_EVIDENCE_CASE_IDS)
def test_long_evidence_boundary_refuses_and_keeps_original(case_id: str) -> None:
    case = _case(case_id)
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    assert decision.refusal == case["expected"]["refusal"]
    assert decision.projection is None
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-boundary-{case_id}")
    record = _record(raw, case["tool_name"], f"call_{case_id}")
    result = engine.compact_sync(scope, record)
    assert result.ok is False
    assert result.error == case["expected"]["refusal"]
    assert result.item is None and result.plan is None
    assert engine.store.visible_content(scope, record.call_id, raw) == raw


@pytest.mark.parametrize("case_id", LONG_EVIDENCE_CASE_IDS)
def test_vendored_projection_refuses_long_evidence_boundary(case_id: str) -> None:
    import importlib.util
    import sys

    vendor = Path(__file__).resolve().parents[1] / "hermes-plugin/vendor/session_navigation/json_projection.py"
    spec = importlib.util.spec_from_file_location("vendor_json_projection", vendor)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    case = _case(case_id)
    raw = _content(case)
    decision = module.project_json_tool_result(raw, case["tool_name"])
    assert decision.refusal == case["expected"]["refusal"]
    assert decision.projection is None


def test_long_non_evidence_line_still_chunks_in_order() -> None:
    case = _case("matches_long_non_evidence_chunks")
    raw = _content(case)
    decision = project_json_tool_result(raw, case["tool_name"])
    projection = decision.projection
    assert decision.refusal is None
    assert projection is not None and projection.schema == "search_files_matches_v1"
    chunks = [line for line in projection.lines if line.startswith("projected search_files_matches_v1 matches_text[")]
    by_line: dict[str, list[int]] = {}
    for line in chunks:
        index = line.split("matches_text[", 1)[1].split("]", 1)[0]
        offset = int(line.split("+", 1)[1].split(":", 1)[0])
        by_line.setdefault(index, []).append(offset)
    assert by_line["0"][0] == 0
    assert by_line["0"] == sorted(by_line["0"])
    assert by_line["1"] == [0]
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-boundary-control")
    result = engine.compact_sync(scope, _record(raw, case["tool_name"], "call_boundary_control"))
    assert result.ok is True, result.error
    assert verify_projection_render(result.plan.replacement_text, raw, case["tool_name"], projection)
    assert result.item is not None and result.item.original == raw
    assert engine.restore(scope, result.item.item_id).ok is True


def test_projection_render_rejects_trailing_injection_and_forged_digest_and_keeps_empty_fields() -> None:
    files_payload = json.dumps(
        {"files": ["synthetic/fixtures/a.txt", "synthetic/fixtures/b.txt"], "total_count": 2},
        separators=(",", ":"),
    )
    files_proj = project_json_tool_result(files_payload, "search_files").projection
    assert files_proj is not None
    item_id = "item_files_parity"
    label = "Projected JSON (prefix+suffix; restore with unhide_context): "
    valid_rendered = "\n".join(
        [
            f"[hidden:{item_id}]",
            *(f"{label}{line}" for line in files_proj.lines),
            f"The remaining result is preserved. Restore it with unhide_context({item_id}).",
        ]
    )
    assert verify_projection_render(valid_rendered, files_payload, "search_files", files_proj) is True
    assert verify_projection_render(valid_rendered + "\nINJECTED", files_payload, "search_files", files_proj) is False
    assert verify_projection_render(valid_rendered + " extra", files_payload, "search_files", files_proj) is False
    mismatched_id = valid_rendered.replace(f"unhide_context({item_id})", "unhide_context(other_id)")
    assert verify_projection_render(mismatched_id, files_payload, "search_files", files_proj) is False

    empty_matches = json.dumps(
        {
            "matches_format": "",
            "matches_text": "synthetic/a.txt:1:alpha\nsynthetic/b.txt:2:beta",
            "total_count": 2,
            "total_count_is_lower_bound": False,
            "truncated": False,
            "_hint": "",
        },
        separators=(",", ":"),
    )
    matches_proj = project_json_tool_result(empty_matches, "search_files").projection
    assert matches_proj is not None
    assert 'projected search_files_matches_v1 matches_format+0: ""' in matches_proj.lines
    assert 'projected search_files_matches_v1 _hint+0: ""' in matches_proj.lines
