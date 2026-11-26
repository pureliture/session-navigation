import json
import sys
import types

import pytest

from _adapter_loader import hermes_adapter
from test_hermes_nav import FakeCtx

adapter = hermes_adapter()
SESSION = "usage-session"


class HookCtx(FakeCtx):
    def __init__(self):
        super().__init__(config={"enabled": True})
        self.hooks = {}

    def register_hook(self, name, callback):
        self.hooks[name] = callback


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = HookCtx()
    state = adapter.plugin.register(ctx)
    body = "\n".join(f"row {i:03}: " + "details " * 12 for i in range(100))
    ctx.middlewares["llm_request"][0](request={"messages": [
        {"role": "user", "content": "old prompt " * 20},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {
                "name": "read_file", "arguments": '{"path":"sample.txt"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": body},
    ]}, session_id=SESSION, api_mode="chat_completions")
    return ctx, state


def nav(ctx, text="list", session=SESSION):
    return ctx.commands["nav"](text, session_id=session)


def observe(ctx, **extra):
    values = {"session_id": SESSION, "usage": {"prompt_tokens": 7365}, "context_length": 65536}
    values.update(extra)
    ctx.hooks["post_api_request"](**values)


def test_footer_unknown_formatting_and_session_isolation(setup):
    ctx, _state = setup
    assert nav(ctx).endswith("context — tokens")
    assert nav(ctx, "messages").endswith("context — tokens")
    observe(ctx)
    expected = "context 7.4K / 65.5K tokens (11.2%)"
    assert nav(ctx).endswith(expected)
    assert nav(ctx, "messages").endswith(expected)
    assert nav(ctx, session="another-session").endswith("context — tokens")
    observe(ctx, usage={"prompt_tokens": 0})
    assert nav(ctx).endswith("context 0 / 65.5K tokens (0.0%)")


def test_hide_unhide_net_estimate_and_new_usage_reset(setup):
    ctx, state = setup
    observe(ctx)
    assert nav(ctx, "hide c1").startswith("Hidden")
    scope = adapter.factories.scope_for(state, SESSION)
    item, = state.engine.store.items(scope)
    saved = adapter.usage.estimate_tokens(item.original) - adapter.usage.estimate_tokens(item.compacted)
    assert saved > 0
    suffix = "next ≈ −" + adapter.usage.compact_tokens(saved)
    assert nav(ctx).endswith(suffix)
    assert nav(ctx, "messages").endswith(suffix)
    nav(ctx, "hide c1")
    assert nav(ctx).endswith(suffix)
    nav(ctx, "unhide " + item.item_id)
    assert "next ≈" not in nav(ctx)
    nav(ctx, "hide c1")
    observe(ctx, usage={"prompt_tokens": 5000})
    assert nav(ctx).endswith("context 5.0K / 65.5K tokens (7.6%)")
    nav(ctx, "unhide " + item.item_id)
    assert nav(ctx).endswith("next ≈ +" + adapter.usage.compact_tokens(saved))


def test_message_hide_estimates_idempotence_and_errors(setup):
    ctx, state = setup
    observe(ctx)
    nav(ctx, "hide-msg 1")
    assert nav(ctx, "messages").endswith("next ≈ −55")
    nav(ctx, "hide-msg 1")
    assert nav(ctx).endswith("next ≈ −55")
    assert "not_found" in nav(ctx, "hide-msg 999")
    assert "not_found" in nav(ctx, "hide absent")
    assert nav(ctx).endswith("next ≈ −55")
    observe(ctx)
    nav(ctx, "unhide-msg 1")
    assert nav(ctx).endswith("next ≈ +55")
    assert "next ≈" not in nav(ctx, session="other")


@pytest.mark.parametrize("action", ["hide", "summarize", "auto"])
def test_partial_manage_tracks_only_applied_savings(setup, monkeypatch, action):
    ctx, state = setup
    if action != "hide":
        state.summarizer = object()
        monkeypatch.setattr(adapter.factories, "_engine_summarize",
                            lambda engine, store, scope, call_id, summarizer:
                            adapter.handlers.compact(engine, store, scope, call_id))
    observe(ctx)
    handler = ctx.tools["manage_context"]["handler"]
    params = {"tool_call_ids": ["c1", "missing"], "action": action}
    result = json.loads(handler(params, session_id=SESSION))
    assert result["ok"] is False
    assert (result["applied"], result["failed"]) == (1, 1)
    item, = state.engine.store.items(adapter.factories.scope_for(state, SESSION))
    saved = adapter.usage.estimate_tokens(item.original) - adapter.usage.estimate_tokens(item.compacted)
    assert saved > 0
    suffix = "next ≈ −" + adapter.usage.compact_tokens(saved)
    assert nav(ctx).endswith(suffix)
    assert nav(ctx, "messages").endswith(suffix)
    repeated = json.loads(handler(params, session_id=SESSION))
    assert (repeated["applied"], repeated["failed"]) == (0, 2)
    assert nav(ctx).endswith(suffix)
    nav(ctx, "unhide " + item.item_id)
    assert "next ≈" not in nav(ctx)
    handler(params, session_id=SESSION)
    observe(ctx, usage={"prompt_tokens": 5000})
    assert nav(ctx).endswith("context 5.0K / 65.5K tokens (7.6%)")


def test_invalid_or_auxiliary_usage_does_not_reset_pending_estimate(setup):
    ctx, _state = setup
    observe(ctx)
    nav(ctx, "hide c1")
    before = nav(ctx).splitlines()[-1]
    for values in ({"usage": None}, {"usage": {"prompt_tokens": True}},
                   {"usage": {"prompt_tokens": -1}}, {"session_id": ""},
                   {"aux_task": "plugin:summary"}, {"is_auxiliary": True}):
        observe(ctx, **values)
        assert nav(ctx).splitlines()[-1] == before


def test_missing_hook_api_keeps_registration_working(tmp_path, monkeypatch):
    monkeypatch.setenv("SESSION_NAVIGATION_STATE_PATH", str(tmp_path / "state.sqlite3"))
    ctx = FakeCtx(config={"enabled": True})
    adapter.plugin.register(ctx)
    assert "nav" in ctx.commands and "llm_request" in ctx.middlewares
    assert nav(ctx).endswith("context — tokens")


def test_summarize_tracks_replacement_and_auxiliary_cannot_clear_it(setup, monkeypatch):
    ctx, state = setup
    scope = adapter.factories.scope_for(state, SESSION)
    entry, = state.store.entries(scope.scope_key())
    state.summarizer = object()

    def summarize(engine, store, scope, call_id, summarizer):
        observe(ctx, aux_task="session-navigation-summarize")
        return adapter.handlers.compact(engine, store, scope, call_id)

    monkeypatch.setattr(adapter.factories, "_engine_summarize", summarize)
    observe(ctx)
    result = json.loads(ctx.tools["summarize_context"]["handler"]({"tool_call_id": entry.call_id},
                                                                session_id=SESSION))
    assert result["ok"]
    assert "next ≈ −" in nav(ctx)


def test_estimator_does_not_import_or_use_private_host_module(monkeypatch):
    host = types.ModuleType("agent.model_metadata")

    def _fail(_text):
        raise AssertionError("must not call private host estimate_tokens_rough")

    host.estimate_tokens_rough = _fail
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.model_metadata", host)
    assert adapter.usage.estimate_tokens("漢字") == 2
    assert adapter.usage.estimate_tokens("안녕하세요 hello 🚀") == 8


@pytest.mark.parametrize(
    ("sample", "expected"),
    [
        ("", 0),
        ("a", 1),
        ("abcd", 1),
        ("abcde", 2),
        ("x" * 400, 100),
        ("\n\t\r!@#$%^&*()_+-=[]{}|;':\",./<>?", 8),
        ("\ud800", 1),
        ("한\ud800a", 2),
        ("안녕", 2),
        ("안녕하세요", 5),
        ("ㅋㅋㅋ", 3),
        ("\u1100\u1161", 2),
        ("漢字", 2),
        ("こんにちは", 5),
        ("ＡＢ", 2),
        ("🚀", 1),
        ("🚀🔥✨🎉", 4),
        ("👨‍👩‍👧‍👦", 7),
        ("🇰🇷", 2),
        ("café", 2),
        ("привет", 3),
        ("مرحبا", 3),
        ("오류 발생: read_file 실패 🚨 (line 42)", 13),
        ("a" * 100_000, 25_000),
        ("가" * 50_000, 50_000),
        ("가a🚀" * 10_000, 22_500),
    ],
)
def test_estimate_tokens_unicode_boundaries(sample, expected):
    assert adapter.usage.estimate_tokens(sample) == expected


def test_estimate_tokens_matches_current_hermes_reference_if_installed():
    import importlib.util
    import os
    from pathlib import Path

    hermes_root = Path(
        os.environ.get("HERMES_REPO", str(Path.home() / ".hermes" / "hermes-agent"))
    ).resolve()
    metadata_path = hermes_root / "agent" / "model_metadata.py"
    if not metadata_path.is_file():
        pytest.skip(f"installed Hermes reference not found at {metadata_path}")

    spec = importlib.util.spec_from_file_location("hermes_ref_model_metadata", metadata_path)
    assert spec is not None and spec.loader is not None
    host = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(host)
    except Exception as exc:
        pytest.skip(f"could not load installed Hermes model_metadata: {exc}")

    samples = [
        "",
        "a",
        "abcd",
        "abcde",
        "\n\t\r!@#$%^&*()_+-=[]{}|;':\",./<>?",
        "\ud800",
        "한\ud800a",
        "안녕",
        "안녕하세요",
        "ㅋㅋㅋ",
        "\u1100\u1161",
        "漢字",
        "こんにちは",
        "ＡＢ",
        "🚀",
        "🚀🔥✨🎉",
        "👨‍👩‍👧‍👦",
        "🇰🇷",
        "café",
        "привет",
        "مرحبا",
        "오류 발생: read_file 실패 🚨 (line 42)",
        "a" * 10_000,
        "가" * 5_000,
        "가a🚀" * 2_000,
    ]
    for sample in samples:
        assert adapter.usage.estimate_tokens(sample) == host.estimate_tokens_rough(sample)


def test_reminders_and_restore_do_not_depend_on_estimate_tokens(setup, monkeypatch):
    from session_navigation.reminders import BoundaryReminders, WORTHWHILE_BYTES

    reminders = BoundaryReminders()
    small = [{"tool_call_id": "t1", "bytes_size": WORTHWHILE_BYTES - 1}]
    large = [{"tool_call_id": "t2", "bytes_size": WORTHWHILE_BYTES}]
    # Reminder eligibility depends on byte size, never _tokens/_window.
    assert reminders.note("s", "1", 999_999, 100, small, after_tool=True) is None
    assert reminders.note("s", "1", 0, None, large, after_tool=True) is not None

    ctx, state = setup
    observe(ctx)
    scope = adapter.factories.scope_for(state, SESSION)
    large_body = "\n".join(f"row {i:04d}: " + "details " * 14 for i in range(300))

    def _boom(_text):
        raise AssertionError("middleware reminder path must not call estimate_tokens")

    monkeypatch.setattr(adapter.factories, "estimate_tokens", _boom)
    mw_out = ctx.middlewares["llm_request"][0](
        request={
            "messages": [
                {"role": "user", "content": "한글 요청 🚀"},
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "c2",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": '{"path":"big2.txt"}'},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "c2", "content": large_body},
            ]
        },
        session_id=SESSION,
        api_mode="chat_completions",
    )
    assert any(
        isinstance(m.get("content"), str) and "[context-navigation]" in m["content"]
        for m in mw_out["request"]["messages"]
    )

    monkeypatch.setattr(
        adapter.factories, "estimate_tokens", lambda text: 50_000 if len(text) > 5_000 else 100
    )
    hidden = json.loads(ctx.tools["hide_context"]["handler"]({"tool_call_id": "c2"}, session_id=SESSION))
    assert hidden["ok"] is True, hidden
    # Only the display footer uses the estimator; exact restoration is unaffected.
    assert "next ≈ −49.9K" in nav(ctx)
    restored = json.loads(
        ctx.tools["unhide_context"]["handler"]({"item_id": hidden["item_id"]}, session_id=SESSION)
    )
    assert restored["ok"] is True
    assert state.engine.store.get(scope, hidden["item_id"]).original == large_body


def test_usage_cache_is_bounded():
    tracker = adapter.usage.UsageTracker(max_sessions=2)
    for sid in ("a", "b", "c"):
        tracker.observe(session_id=sid, usage={"prompt_tokens": 100}, context_length=1000)
    assert tracker.footer("a") == "context — tokens"
