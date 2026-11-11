"""Exercise the real Hermes summary request builder with a fake host LLM."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from _adapter_loader import hermes_adapter
from session_navigation.policy import required_evidence_lines
from session_navigation.summary import validate_summary_text
from session_navigation.transport import SummarizerUnavailable
from test_hermes_nav import FakeCtx


def read_envelope(evidence=()):
    lines = [f"Synthetic row {i:03d} detail line" for i in range(500)] + list(evidence)
    content = "\n".join(f"{i}|{line}" for i, line in enumerate(lines, 1))
    return json.dumps({"content": content, "total_lines": len(lines), "file_size": len(content),
                       "truncated": False, "is_binary": False, "is_image": False, "not_found": False})


class CapturingLlm:
    def __init__(self, summary):
        self.summary = summary
        self.requests = []

    def complete(self, **kwargs):
        self.requests.append(kwargs)
        return SimpleNamespace(text=json.dumps({"summary": self.summary}), usage=None)


def test_whole_source_includes_late_fact_and_oversize_never_calls_host():
    source = "\n".join(f"Routine telemetry row {i}" for i in range(700)) + "\nlatency_budget_ms=151"
    assert source.index("latency_budget_ms") > 12000
    llm = CapturingLlm("latency_budget_ms=151")
    summarizer = hermes_adapter().llm.CtxLlmSummarizer(SimpleNamespace(llm=llm))
    assert asyncio.run(summarizer.summarize(source, [])) == {"summary": "latency_budget_ms=151"}
    assert json.loads(llm.requests[0]["messages"][1]["content"])["source"] == source
    for oversized in ["x" * 32769, "😀" * 8193]:
        with pytest.raises(SummarizerUnavailable, match="input_too_large"):
            asyncio.run(summarizer.summarize(oversized, []))
    assert len(llm.requests) == 1


def test_filtered_hermes_listing_does_not_invent_unrecorded_rows(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.db"))
    ctx = FakeCtx(config={"enabled": True})
    hermes_adapter().plugin.register(ctx)
    source = "\n".join(f"Output row {i} details" for i in range(100))
    request = {"messages": [
        {"role": "assistant", "tool_calls": [{"id": "listed", "type": "function", "function": {
            "name": "read_file", "arguments": '{"path":"audit-01.jsonl"}'}}]},
        {"role": "tool", "tool_call_id": "listed", "content": source},
    ]}
    ctx.middlewares["llm_request"][0](request=request, session_id="filtered", api_mode="chat_completions")
    hidden = json.loads(ctx.tools["hide_context"]["handler"]({"tool_call_id": "listed"}, session_id="filtered"))
    assert hidden["ok"]
    handler = ctx.tools["list_context_items"]["handler"]
    assert json.loads(handler({"query": "audit-01.jsonl"}, session_id="filtered"))["items"] == []
    items = json.loads(handler({}, session_id="filtered"))["items"]
    assert len(items) == 1 and items[0]["visibility"] == "hidden"
    assert items[0]["item_id"] == hidden["item_id"]


@pytest.mark.parametrize("evidence", [(), ("WARNING: constraints apply", "results/report.json", "3 tests passed", "left | right")])
@pytest.mark.parametrize("incoming", ["raw-envelope", "empty", "canonical"])
def test_actual_summary_request_recomputes_decoded_evidence(evidence, incoming):
    raw = read_envelope(evidence)
    summary = "Synthetic rows contain detail lines. " + "\n".join(evidence)
    llm = CapturingLlm(summary)
    summarizer = hermes_adapter().llm.CtxLlmSummarizer(SimpleNamespace(llm=llm))
    supplied = {"raw-envelope": [raw], "empty": [], "canonical": required_evidence_lines(raw)}[incoming]
    result = asyncio.run(summarizer.summarize(raw, supplied))
    assert result == {"summary": summary.strip()}
    assert len(llm.requests) == 1
    packet = json.loads(llm.requests[0]["messages"][1]["content"])
    assert packet["source"] == raw
    assert packet["required_evidence"] == list(evidence)
    assert raw not in packet["required_evidence"]
    assert all(line in json.loads(raw)["content"] for line in packet["required_evidence"])


def test_real_request_builder_and_nav_accept_quoted_decoded_evidence():
    evidence = ("WARNING: constraints apply", "results/report.json", "3 tests passed")
    raw = read_envelope(evidence)
    summary = "Synthetic rows contain detail lines. " + "\n".join(evidence)
    ctx = FakeCtx(config={"enabled": True})
    ctx.llm = CapturingLlm(summary)
    adapter = hermes_adapter()
    state = adapter.plugin.register(ctx)
    assert isinstance(state.summarizer, adapter.llm.CtxLlmSummarizer)
    request = {"messages": [
        {"role": "assistant", "content": None, "tool_calls": [{"id": "call_env", "type": "function",
         "function": {"name": "read_file", "arguments": '{"path":"rows.txt"}'}}]},
        {"role": "tool", "tool_call_id": "call_env", "content": raw},
    ]}
    middleware = ctx.middlewares["llm_request"][0]
    middleware(request=request, session_id="llm-envelope", api_mode="chat_completions")
    out = ctx.commands["nav"]("summarize call_env", session_id="llm-envelope")
    assert "Summarized call_env" in out, out
    packet = json.loads(ctx.llm.requests[0]["messages"][1]["content"])
    assert packet["required_evidence"] == list(evidence)
    rewritten = middleware(request=request, session_id="llm-envelope", api_mode="chat_completions")["request"]
    replacement = rewritten["messages"][-1]["content"]
    assert all(line in replacement for line in evidence)
    assert json.dumps(summary, ensure_ascii=False) in replacement
    assert len(replacement.encode()) < len(raw.encode()) * 0.8
    assert request["messages"][-1]["content"] == raw
    assert "Unhidden" in ctx.commands["nav"]("unhide 1", session_id="llm-envelope")
    assert middleware(request=request, session_id="llm-envelope", api_mode="chat_completions")["request"] == request


def test_request_normalization_keeps_summary_factual_validation():
    raw = read_envelope()
    llm = CapturingLlm("9999 tests passed.")
    summarizer = hermes_adapter().llm.CtxLlmSummarizer(SimpleNamespace(llm=llm))
    with pytest.raises(SummarizerUnavailable, match="verification_failed"):
        asyncio.run(summarizer.summarize(raw, [raw]))
    assert json.loads(llm.requests[0]["messages"][1]["content"])["required_evidence"] == []


def test_captured_inventory_summary_passes_real_request_builder_unchanged():
    lines = ["Inventory alpha; owner=Cedar; region=west; cutoff=2026-11-12. All entries are test data."]
    lines.extend(
        f"alpha-{i:03d}: owner Cedar, region west, color amber, cutoff 2026-11-12, "
        f"quantity {i % 17 + 1}, retention routine."
        for i in range(160)
    )
    raw = json.dumps({
        "content": "\n".join(f"{i}|{line}" for i, line in enumerate(lines, 1)),
        "total_lines": 161, "file_size": 16161, "truncated": False,
        "is_binary": False, "is_image": False, "not_found": False,
    })
    assert len(raw) == 16990
    summary = (
        "Inventory alpha test data: 160 entries alpha-000 to alpha-159, all owner Cedar, "
        "region west, color amber, cutoff 2026-11-12, retention routine, quantities cycling "
        "1-17; 161 lines, 16161 bytes, not truncated, not binary/image, found."
    )
    expected = {"summary": summary}
    assert validate_summary_text(raw, expected, required_evidence_lines(raw)) == expected
    llm = CapturingLlm(summary)
    summarizer = hermes_adapter().llm.CtxLlmSummarizer(SimpleNamespace(llm=llm))
    assert asyncio.run(summarizer.summarize(raw, [raw])) == expected
    assert json.loads(llm.requests[0]["messages"][1]["content"])["required_evidence"] == []
