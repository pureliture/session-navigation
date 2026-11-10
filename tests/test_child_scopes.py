import pytest
from contextlib import closing

from session_navigation.sqlite_store import SQLiteContextStore


def test_child_scope_metadata_roundtrip_and_legacy_rows(tmp_path):
    path = tmp_path / "state.db"
    parent, child = "hermes:default:parent:unknown", "hermes:default:child:unknown"
    owner = dict(adapter_id="hermes", instance_id="test", capabilities=dict(hide=True, summarize=False, unhide=True))
    with closing(SQLiteContextStore(path)) as store:
        store.register_adapter(parent, **owner)
        assert store.adapter_session(parent)["parent_scope"] is None
        assert store.child_scopes(parent) == []
        store.link_children(parent, "delegate", ["sa"])
        store.register_adapter(parent, **owner)
        store.register_adapter(child, **owner, parent_scope=parent, subagent_id="sa")
        store.register_adapter(child, **owner)
    with closing(SQLiteContextStore(path)) as store:
        rows = store.child_scopes(parent)
        assert [(row["scope_key"], row["tool_call_id"], row["subagent_id"]) for row in rows] == [(child, "delegate", "sa")]
        assert store.child_scopes(child) == []
        listed = {row["scope_key"]: row for row in store.list_scopes()}
        assert listed[child]["parent_scope"] == parent
        assert listed[parent]["parent_scope"] is None
        assert store.adapter_can(child, "hide")
        assert not store.adapter_can(child, "summarize")
        store.link_children(parent, "updated-delegate", ["sa"])
        assert store.adapter_session(child)["tool_call_id"] == "updated-delegate"


@pytest.mark.parametrize("metadata", [{"parent_scope": "hermes:default:self:unknown"},
    {"parent_scope": "malformed"}, {"subagent_id": 3}, {"tool_call_id": ""}])
def test_invalid_child_registration_is_atomic(tmp_path, metadata):
    with closing(SQLiteContextStore(tmp_path / "state.db")) as store:
        with pytest.raises(ValueError, match="invalid_adapter_registration"):
            store.register_adapter("hermes:default:self:unknown", adapter_id="hermes", instance_id="test",
                capabilities=dict(hide=True), **metadata)
        assert store.list_scopes() == []
