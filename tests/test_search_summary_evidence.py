"""Parsed JSON evidence on the search_files summarize path (synthetic fixtures only)."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from session_navigation.engine import SessionNavigationEngine
from session_navigation.generic_json import (
    MAX_EVIDENCE_BYTES,
    MAX_EVIDENCE_LINES,
    inspect_generic_json,
    inspect_generic_json_with_evidence,
    parsed_json_evidence,
    parsed_json_policy_lines,
)
from session_navigation.json_projection import reconstruct_files_projection
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


def _record(content: str, call_id: str = "call_search") -> ToolResultRecord:
    invocation = {"tool_name": "search_files", "arguments": {"pattern": "synthetic"}}
    return ToolResultRecord(
        call_id=call_id,
        result_position=0,
        content=content,
        content_sha256=compute_sha256(content),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
        status="ok",
        host_handle={"index": 1},
    )


class _CapturingSummarizer:
    """Deterministic stand-in model that records every request and replays replies."""

    def __init__(self, *responses: dict[str, Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def summarize(
        self,
        source: str,
        required_evidence: tuple[str, ...],
        *,
        invocation: dict[str, Any] | None = None,
        context: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "source": source,
                "required_evidence": tuple(required_evidence),
                "invocation": invocation,
                "context": dict(context) if context is not None else None,
            }
        )
        return self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]


def _files_json(file_count: int, path_chars: int, pad_reps: int) -> str:
    files = []
    for index in range(file_count):
        suffix = f"row-{index:03d}.txt"
        files.append("synthetic/fixtures/" + ("x" * max(0, path_chars - 19 - len(suffix))) + suffix)
    payload = {
        "files": files,
        "total_count": file_count,
        "padding": "beta gamma " * pad_reps,
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _matches_json(line_count: int = 4, line_chars: int = 1150) -> str:
    lines = []
    for index in range(line_count):
        text = f"synthetic/fixtures/row-{index:03d}.txt evidence=stable " + "alpha beta gamma " * 80
        lines.append(text[:line_chars])
    return json.dumps(
        {
            "matches_format": "Synthetic format: path:line:text",
            "matches_text": "\n".join(lines),
            "total_count": line_count,
            "total_count_is_lower_bound": False,
            "truncated": False,
            "_hint": "Synthetic hint for the matches evidence.",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _middle_critical_json(kind: str) -> str:
    middle = (
        "synthetic/fixtures/invoice.txt: FAILED duplicate invoice still unresolved"
        if kind == "protected"
        else "synthetic/fixtures/invoice.txt id: 01234567-89ab-cdef-0123-456789abcdef"
    )
    return json.dumps(
        {
            "matches_format": "Synthetic format: path:line:text",
            "matches_text": "\n".join(
                [
                    "synthetic/fixtures/header.txt previous step ok",
                    middle,
                    "synthetic/fixtures/footer.txt next step ok",
                ]
            ),
            "padding": "alpha beta gamma delta " * 60,
            "total_count": 3,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _budget_json(line_count: int, line_chars: int) -> str:
    lines = [
        f"synthetic/fixtures/row-{index:03d}.txt duplicate invoice " + "alpha " * line_chars
        for index in range(line_count)
    ]
    return json.dumps(
        {"matches_text": "\n".join(lines), "total_count": line_count},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _fixture_content(case_id: str) -> str:
    case = next(case for case in FIXTURES["cases"] if case["id"] == case_id)
    spec = case["generate"]
    files = []
    for index in range(spec["file_count"]):
        suffix = f"row-{index:03d}.txt"
        files.append("synthetic/fixtures/" + ("x" * max(0, spec["path_chars"] - 19 - len(suffix))) + suffix)
    return json.dumps(
        {"files": files, "total_count": spec["file_count"]},
        ensure_ascii=False,
        separators=(",", ":"),
    )


@pytest.mark.parametrize(
    ("case_id", "content", "expected_line", "summary"),
    [
        ("files_22", _files_json(22, 60, 300), "files: list(22)", "Found 22 synthetic fixture files."),
        ("files_40", _files_json(40, 40, 320), "files: list(40)", "Found 40 synthetic fixture files."),
        ("matches", _matches_json(), "total_count: 4", "Synthetic matches total_count 4."),
    ],
)
def test_search_files_summarize_sends_bounded_parsed_evidence(
    case_id: str, content: str, expected_line: str, summary: str
) -> None:
    decision = inspect_generic_json(content)
    evidence = parsed_json_evidence(content)
    assert decision.ok is True
    assert expected_line in evidence
    assert evidence != required_evidence_lines(content)
    assert len(evidence) <= MAX_EVIDENCE_LINES
    assert all(len(line) <= 240 for line in evidence)
    assert sum(len(line.encode("utf-8")) for line in evidence) <= MAX_EVIDENCE_BYTES

    record = _record(content, f"call_{case_id}")
    summarizer = _CapturingSummarizer({"summary": summary})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-evidence-{case_id}")

    result = asyncio.run(engine.summarize(scope, record, summarizer))

    assert result.ok is True, result.error
    assert len(summarizer.calls) == 1
    call = summarizer.calls[0]
    assert call["source"] == content
    assert call["required_evidence"] == evidence
    assert call["invocation"] == record.invocation
    metadata = json.loads(call["context"]["verified_json"])
    assert metadata == {"kind": decision.kind, "nodes": decision.nodes, "depth": decision.depth, "digest": decision.digest}
    assert content not in call["context"]["verified_json"]
    assert result.item is not None
    assert result.item.original == content
    assert result.item.compaction_source == "llm"
    assert f"Summary: {json.dumps(summary)}" in result.item.compacted
    assert all(line in result.item.compacted for line in evidence)


def test_replacement_plan_original_and_unhide_cas_are_stable() -> None:
    content = _files_json(22, 60, 300)
    record = _record(content, "call_plan")
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-evidence-plan")
    summary = "Found 22 synthetic fixture files."

    result = asyncio.run(engine.summarize(scope, record, _CapturingSummarizer({"summary": summary})))

    assert result.ok is True, result.error
    assert result.item is not None
    assert result.plan is not None
    assert result.plan.item_id == result.item.item_id
    assert result.plan.expected_content_sha256 == record.content_sha256
    assert result.plan.replacement_text == result.item.compacted
    assert result.plan.visibility_version == result.item.version
    assert result.plan.tool_call_id == record.call_id
    assert result.plan.host_handle == record.host_handle

    # A repeated summarize is idempotent and the host-side projection agrees.
    repeated = asyncio.run(engine.summarize(scope, record, _CapturingSummarizer({"summary": summary})))
    assert repeated.ok is True, repeated.error
    assert repeated.item is not None and repeated.plan is not None
    assert repeated.plan.replacement_text == result.plan.replacement_text
    assert repeated.plan.visibility_version == result.plan.visibility_version
    assert engine.project(scope, [record]) == [repeated.plan]

    # Restore uses compare-and-swap on the reported visibility version.
    stale = engine.restore(scope, result.item.item_id, expected_version=result.item.version + 1)
    assert stale.ok is False and stale.error == "version_conflict"
    restored = engine.restore(scope, result.item.item_id, expected_version=repeated.plan.visibility_version)
    assert restored.ok is True
    assert restored.item is not None
    assert restored.item.visibility == "visible"
    assert restored.item.version == repeated.plan.visibility_version + 1
    assert restored.item.original == content


@pytest.mark.parametrize(
    ("kind", "summary", "expected_ok"),
    [
        ("protected", "No issues found.", True),
        ("strong", "No issues found.", True),
        ("protected", "No issues found; 999999 records clean.", False),
        ("strong", "No issues found; 999999 records clean.", False),
    ],
)
def test_middle_critical_line_survives_fake_no_issue_summary(
    kind: str, summary: str, expected_ok: bool
) -> None:
    content = _middle_critical_json(kind)
    key = "FAILED duplicate invoice" if kind == "protected" else "01234567-89ab-cdef-0123-456789abcdef"
    evidence = parsed_json_evidence(content)
    assert any(key in line for line in evidence)
    assert any(key in line for line in parsed_json_policy_lines(content))
    if kind == "protected":
        assert parsed_json_policy_lines(content)

    record = _record(content, f"call_middle_{kind}_{expected_ok}")
    summarizer = _CapturingSummarizer({"summary": summary})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-middle-{kind}-{expected_ok}")

    result = asyncio.run(engine.summarize(scope, record, summarizer))

    assert all(call["required_evidence"] == evidence for call in summarizer.calls)
    if expected_ok:
        assert result.ok is True, result.error
        assert result.item is not None
        assert any(key in line for line in result.item.compacted.splitlines())
        assert engine.store.items(scope)[0].item_id == result.item.item_id
    else:
        assert result.ok is False
        assert len(summarizer.calls) == 2
        assert not engine.store.items(scope)
        assert not engine.store._pending
    assert record.content == content


def test_unverifiable_files_summary_leaves_original_and_store_unchanged() -> None:
    content = _files_json(22, 60, 300)
    digest = inspect_generic_json(content).digest
    evidence = parsed_json_evidence(content)
    record = _record(content, "call_unverifiable")
    summarizer = _CapturingSummarizer({"summary": "Found 999999 synthetic fixture files."})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-evidence-unverifiable")

    result = asyncio.run(engine.summarize(scope, record, summarizer))

    assert result.ok is False
    assert result.error == "verification_failed"
    assert len(summarizer.calls) == 2
    assert all(call["required_evidence"] == evidence for call in summarizer.calls)
    assert not engine.store.items(scope)
    assert record.content == content
    assert inspect_generic_json(content).digest == digest


@pytest.mark.parametrize(
    ("name", "content", "expected_error"),
    [
        ("duplicate_keys", '{"kind":"synthetic","status":"created","status":"created","payload":"' + "alpha beta gamma delta " * 40 + '"}', "verification_failed"),
        ("malformed", '{"kind":', "verification_failed"),
        ("nan_constant", '{"kind":"synthetic","value":NaN}', "verification_failed"),
        ("out_of_range", '{"value":1e999}', "verification_failed"),
        ("unsafe_unicode", json.dumps({"payload": "alpha" + chr(0x2028) + "beta " * 200}, ensure_ascii=False), "verification_failed"),
        ("oversized", json.dumps({"payload": "alpha" * 14000}), "input_too_large"),
    ],
)
def test_invalid_json_fails_closed_without_model_or_store_change(
    name: str, content: str, expected_error: str
) -> None:
    decision = inspect_generic_json(content)
    assert decision.ok is False and decision.refusal == expected_error
    assert parsed_json_evidence(content) == ()
    record = _record(content, f"call_invalid_{name}")
    summarizer = _CapturingSummarizer({"summary": "Synthetic record created."})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-invalid-{name}")

    result = asyncio.run(engine.summarize(scope, record, summarizer))

    assert result.ok is False
    assert result.error == expected_error
    assert summarizer.calls == []
    assert not engine.store.items(scope)
    assert not engine.store._pending
    assert record.content == content


@pytest.mark.parametrize(
    ("name", "content"),
    [("lines", _budget_json(70, 5)), ("bytes", _budget_json(40, 50))],
)
def test_parsed_evidence_budget_overflow_fails_closed(name: str, content: str) -> None:
    decision = inspect_generic_json(content)
    with_evidence, evidence = inspect_generic_json_with_evidence(content)
    assert decision.ok is False and decision.refusal == "verification_failed"
    assert with_evidence == decision
    assert evidence == ()
    assert parsed_json_evidence(content) == ()

    record = _record(content, f"call_budget_{name}")
    summarizer = _CapturingSummarizer({"summary": "No issues found."})
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", f"sess-budget-{name}")

    result = asyncio.run(engine.summarize(scope, record, summarizer))

    assert result.ok is False
    assert result.error == "verification_failed"
    assert summarizer.calls == []
    assert not engine.store.items(scope)
    assert not engine.store._pending


def test_hide_projection_regression_still_reconstructs_and_restores() -> None:
    content = _fixture_content("files_success")
    parsed = json.loads(content)
    engine = SessionNavigationEngine()
    scope = Scope("hermes", "test", "sess-hide-projection-evidence")

    compacted = engine.compact_sync(scope, _record(content, "call_hide"))

    assert compacted.ok is True, compacted.error
    assert compacted.item is not None and compacted.plan is not None
    assert "prefix+suffix" in compacted.plan.replacement_text
    assert "restore with unhide_context" in compacted.plan.replacement_text
    label = "Projected JSON (prefix+suffix; restore with unhide_context): "
    marker = "The remaining result is preserved. Restore it with unhide_context("
    rows = compacted.plan.replacement_text.split("\n", 1)[1].split(marker, 1)[0].rstrip("\n").split("\n")
    decoded = "\n".join(row[len(label):] for row in rows)
    assert reconstruct_files_projection(decoded) == parsed["files"]
    assert compacted.item.original == content
    assert engine.restore(scope, compacted.item.item_id).ok is True


def test_summarize_path_does_not_claim_projection() -> None:
    content = _files_json(22, 60, 300)
    summary = "Found 22 synthetic fixture files."
    summarizer = _CapturingSummarizer({"summary": summary})
    engine = SessionNavigationEngine()

    result = asyncio.run(
        engine.summarize(Scope("hermes", "test", "sess-evidence-no-projection"), _record(content), summarizer)
    )

    assert result.ok is True, result.error
    assert result.item is not None
    assert "Projected JSON" not in result.item.compacted
    assert "Original excerpt:" in result.item.compacted
    assert summarizer.calls[0]["required_evidence"] == parsed_json_evidence(content)
