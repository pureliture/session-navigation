
"""B1.1-B1.4 regression tests: Python mirrors of the settled TS contract."""

import sqlite3

import pytest

from session_navigation.model import (
    ToolResultRecord,
    compute_invocation_digest,
    compute_sha256,
)
from session_navigation.sqlite_store import SQLiteContextStore


def _store(path):
    return SQLiteContextStore(path)


def _register(store, scope, adapter_id="hermes", **kwargs):
    params = dict(
        adapter_id=adapter_id,
        instance_id="i",
        capabilities={"hide": True, "summarize": False, "unhide": True},
    )
    params.update(kwargs)
    return store.register_adapter(scope, **params)


def _record(index=0, content="alpha details " * 200):
    invocation = {"tool_name": "read_file", "arguments": {"path": "source.txt"}}
    return ToolResultRecord(
        str(index),
        content=content,
        content_sha256=compute_sha256(content),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
    )


def test_adapter_control_rejects_colon_ids(tmp_path):
    """B1.1: ':' in adapter_id would shadow real sessions; reject it."""
    store = _store(tmp_path / "colon.db")
    with pytest.raises(ValueError, match="invalid_adapter_registration"):
        store.set_adapter_control("hermes:default", False)
    with pytest.raises(ValueError, match="invalid_adapter_registration"):
        store.set_adapter_control(":", True)
    assert store.get_adapter_control("hermes:default") is None
    with pytest.raises(ValueError, match="invalid_adapter_registration"):
        _register(store, "hermes:default:s:default", adapter_id="hermes:default")
    _register(store, "hermes:default:s:default")
    assert store.adapter_session("hermes:default:s:default")["adapter_id"] == "hermes"
    store.close()


def test_adapter_control_matching_is_case_sensitive_and_prefix_exact(tmp_path):
    """B1.2: no SQLite LIKE; adapter_id matches exactly, scope prefix is exact."""
    store = _store(tmp_path / "case.db")
    capabilities = {"hide": True, "summarize": False, "unhide": True}
    _register(store, "omp:default:lower:default", adapter_id="omp", capabilities=capabilities)
    _register(store, "OMP:default:upper:default", adapter_id="OMP", capabilities=capabilities)
    _register(store, "om:default:short:default", adapter_id="om", capabilities=capabilities)
    # Under the old LIKE matching, "omp" off would also disable "OMP:*" rows.
    store.set_adapter_control("omp", False)
    assert store.adapter_session("omp:default:lower:default")["enabled"] is False
    assert store.adapter_session("OMP:default:upper:default")["enabled"] is True
    assert store.adapter_session("om:default:short:default")["enabled"] is True
    store.set_adapter_control("OMP", False)
    assert store.adapter_session("OMP:default:upper:default")["enabled"] is False
    assert store.adapter_session("omp:default:lower:default")["enabled"] is False
    store.set_adapter_control("omp", True)
    assert store.adapter_session("omp:default:lower:default")["enabled"] is True
    assert store.adapter_session("OMP:default:upper:default")["enabled"] is False
    store.close()


def test_control_on_never_resurrects_self_disabled_sessions(tmp_path):
    """B1.3: control-on resurrects only rows the control-off path marked."""
    store = _store(tmp_path / "marker.db")
    owner = {"capabilities": {"hide": True, "summarize": False, "unhide": True}, "enabled": True}
    _register(store, "hermes:default:normal:unknown", **owner)
    # Unsupported api_mode equivalent: capabilities off, enabled false.
    _register(
        store,
        "hermes:default:legacy:unknown",
        capabilities={"hide": False, "summarize": False, "unhide": False},
        enabled=False,
    )
    store.set_adapter_control("hermes", False)
    assert store.adapter_session("hermes:default:normal:unknown")["enabled"] is False
    assert store.adapter_session("hermes:default:legacy:unknown")["enabled"] is False
    store.set_adapter_control("hermes", True)
    assert store.adapter_session("hermes:default:normal:unknown")["enabled"] is True
    assert store.adapter_session("hermes:default:legacy:unknown")["enabled"] is False
    assert store.adapter_can("hermes:default:legacy:unknown", "hide") is False
    # The marker is bookkeeping: never surfaced as a capability.
    assert store.adapter_session("hermes:default:normal:unknown")["capabilities"] == {
        "hide": True,
        "summarize": False,
        "unhide": True,
    }
    # A self-disable landing while control is on survives later toggles too.
    _register(store, "hermes:default:normal:unknown", **{**owner, "enabled": False})
    store.set_adapter_control("hermes", False)
    store.set_adapter_control("hermes", True)
    assert store.adapter_session("hermes:default:normal:unknown")["enabled"] is False
    # A mirrored disable written while control is off still round-trips.
    _register(store, "hermes:default:mirror:unknown", **owner)
    store.set_adapter_control("hermes", False)
    _register(store, "hermes:default:mirror:unknown", **{**owner, "enabled": False})
    store.set_adapter_control("hermes", True)
    assert store.adapter_session("hermes:default:mirror:unknown")["enabled"] is True
    store.close()


def test_register_clamps_stale_enabled_and_publish_couples_control(tmp_path):
    """B1.4: register re-reads control in-txn; publish fails closed on stale rows."""
    store = _store(tmp_path / "coupled.db")
    scope = "omp:default:s:default"
    _register(store, scope, adapter_id="omp")
    store.set_adapter_control("omp", False)
    # A stale enabled=true flag must not commit enabled=true.
    _register(store, scope, adapter_id="omp", enabled=True)
    assert store.adapter_session(scope)["enabled"] is False
    assert store.adapter_can(scope, "hide") is False
    # Simulate a cross-connection race: enabled=true committed before control-off.
    store.connection.execute(
        "UPDATE adapter_sessions SET enabled=1 WHERE scope_key=?", (scope,)
    )
    store.connection.commit()
    assert store.adapter_session(scope)["enabled"] is True
    assert store.adapter_can(scope, "hide") is False
    with pytest.raises(ValueError, match="adapter_disabled"):
        store.publish_targets(scope, [(_record("fresh", "race"), {})])
    assert store.adapter_targets(scope) == []
    store.set_adapter_control("omp", True)
    assert store.adapter_can(scope, "hide") is True
    store.publish_targets(scope, [(_record("fresh", "race"), {})])
    assert len(store.adapter_targets(scope)) == 1
    store.close()
