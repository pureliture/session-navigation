"""Unit tests for summary validation and fact coverage."""
from __future__ import annotations

import pytest

from session_navigation.summary import validate_summary_text

INVOCATION = {"tool_name": "terminal", "arguments": {"command": "pytest"}}
SUMMARY = {"summary": "sample-addon component registry: 12 checks passed; exit code 0."}


def _source() -> str:
    lines = [f"Synthetic catalog row {i:03d} description" for i in range(80)]
    lines.extend([
        "sample-addon package exposes a registry.",
        "12 synthetic checks passed; exit code 0.",
        "Created artifact /synthetic/path/result.json",
    ])
    return "\n".join(lines)


def _evidence() -> tuple[str, ...]:
    return (
        "12 synthetic checks passed; exit code 0.",
        "Created artifact /synthetic/path/result.json",
    )


@pytest.mark.parametrize("text", [
    "Execution details are not provided as per instructions.",
    "The result includes observations from the recorded output.",
    "The recorded output was provided as detailed in the provided string.",
    "결과의 구체적인 내용이 제공되지 않음.",
    "Concrete findings from result.source",
    "주어진 결과는 명확한 주요 결과와 상태를 반영하지만 구체적인 주요 findings은 명시되지 않음",
])
def test_summary_rejects_observed_generic_non_summary(text: str):
    assert validate_summary_text(_source(), {"summary": text}, _evidence(), invocation=INVOCATION) is None


@pytest.mark.parametrize("text", [
    "The catalog uses exact-name matching; optional descriptions are omitted.",
    "The violet-module catalog uses exact-name matching.",
    "The violet-module catalog uses exact-name matching; descriptions are available.",
    "The summary captures violet-module, exact-name, descriptions and omitted.",
])
def test_summary_rejects_narrow_subject_warning_omissions_and_metacommentary(text: str):
    original = "The violet-module catalog uses exact-name matching.\nWarning: optional descriptions are omitted."
    assert validate_summary_text(original, {"summary": text}, ()) is None


@pytest.mark.parametrize("text", [
    "The output indicates multiple repeated annotations.",
    "2 synthetic checks passed.",
    "Exit code 0.",
])
def test_summary_rejects_explicit_check_result_omissions(text: str):
    original = "2 synthetic checks passed; exit code 0.\nRepeated ordinary annotation."
    assert validate_summary_text(original, {"summary": text}, ()) is None


def test_summary_accepts_check_result_paraphrase():
    original = "2 synthetic checks passed; exit code 0."
    summary = {"summary": "2 checks passed (return code 0)."}
    assert validate_summary_text(original, summary, ()) == summary


@pytest.mark.parametrize("shorthand", ["binary/image", "input/output", "read/write", "pass/fail"])
def test_plain_word_slash_shorthand_is_not_an_invented_path(shorthand):
    original = "The data is text, not binary and not an image. Input and output support read and write."
    summary = {"summary": f"Text data; {shorthand} classification."}
    assert validate_summary_text(original, summary, ()) == summary


@pytest.mark.parametrize("path", [
    "/invented", "./invented", "../invented", "~/invented", r"C:\invented",
    r"C:/invented", r"\\server\invented", "new/dir/result", r"new\dir\result",
    "new/report.json", "report.json", ".gitignore",
])
def test_invented_paths_with_real_path_signals_are_rejected(path):
    assert validate_summary_text("Read /known/data/result.json.", {"summary": f"Read {path}."}, ()) is None


@pytest.mark.parametrize("path", [
    "/known", "./known", "../known", "~/known", r"C:\known", r"C:/known",
    r"\\server\known", "known/dir/result", r"known\dir\result",
    "known/report.json", "report.json", ".gitignore",
])
def test_paths_with_real_path_signals_remain_valid_when_grounded(path):
    summary = {"summary": f"Read {path}."}
    assert validate_summary_text(f"Read {path}", summary, ()) == summary


@pytest.mark.parametrize("subject,topic,state", [
    ("cobalt-plugin", "signatures", "unavailable"),
    ("silver-addon", "attachments", "missing"),
    ("birch-library", "examples", "absent"),
])
def test_summary_warning_coverage_is_source_derived(subject: str, topic: str, state: str):
    source = f"The {subject} package exposes a registry.\nWarning: {topic} are {state}."
    assert validate_summary_text(source, {"summary": f"{subject} exposes a registry."}, ()) is None
    paraphrase = {"summary": f"{subject} registry; {topic} {state}."}
    assert validate_summary_text(source, paraphrase, ()) == paraphrase


def test_summary_accepts_subject_warning_paraphrase_without_full_word_overlap():
    original = "The violet-module catalog uses exact-name matching.\nWarning: optional descriptions are omitted."
    summary = {"summary": "violet-module matches exact names; optional descriptions omitted."}
    assert validate_summary_text(original, summary, ()) == summary


def test_summary_explicit_missing_details_quote_remains_valid_evidence():
    original = "Warning: execution details are not provided."
    summary = {"summary": original}
    assert validate_summary_text(original, summary, (), invocation=INVOCATION) == summary



def test_ordinary_annotations_cannot_be_reclassified_as_source_warnings():
    source = (
        "The orbit-widget catalog uses exact-name matching.\n"
        "Warning: optional descriptions are omitted.\n"
        + "Repeated ordinary catalog annotation.\n" * 55
    )
    bad = {
        "summary": "The orbit-widget catalog uses exact-name matching, with warnings about omitted optional descriptions and repeated annotations."
    }
    assert validate_summary_text(source, bad, ()) is None
    noted = {
        "summary": "The orbit-widget catalog uses exact-name matching; descriptions omitted; repeated annotations noted as warnings."
    }
    assert validate_summary_text(source, noted, ()) is None
    good = {
        "summary": "The orbit-widget catalog uses exact-name matching; optional descriptions are omitted."
    }
    assert validate_summary_text(source, good, ()) == good
    separate = {
        "summary": "The orbit-widget catalog uses exact-name matching. Warning: optional descriptions are omitted. Repeated annotations are ordinary."
    }
    assert validate_summary_text(source, separate, ()) == separate
    genuine_source = source + "Warning: repeated annotations are invalid.\n"
    assert validate_summary_text(genuine_source, bad, ()) == bad


@pytest.mark.parametrize("source", [
    "Warning: optional descriptions are omitted.",
    '{"stdout": "Warning: optional descriptions are omitted."}',
])
def test_explicit_optional_omission_warning_cannot_be_generalized(source: str):
    unqualified = {"summary": "Warning: descriptions are omitted."}
    assert validate_summary_text(source, unqualified, ()) is None
    qualified = {"summary": "Warning: optional descriptions are omitted."}
    assert validate_summary_text(source, qualified, ()) == qualified
    ordinary_source = "Warning: descriptions are omitted."
    assert validate_summary_text(ordinary_source, unqualified, ()) == unqualified
