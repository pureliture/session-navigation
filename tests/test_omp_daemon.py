"""OMP adapter와 Python 엔진의 RPC 계약을 검증한다."""
from session_navigation_omp.daemon import Daemon
from session_navigation_omp.daemon import MAX_CHUNK_BYTES, MAX_CHUNK_RECORDS, MAX_SCOPES


def record(call_id="call-1", text=None):
    return {"call_id": call_id, "tool_name": "read", "arguments": {"path": "sample.txt"},
            "status": "ok", "content": text or "\n".join(f"Output row {i:03} details" for i in range(100))}


def call(daemon, method, **params):
    return daemon.handle({"method": method, "params": {"session_id": "a", **params}})


def test_manage_requires_explicit_ids_and_reports_unknown_ids():
    daemon = Daemon()
    for params in ({}, {"tool_call_ids": []}):
        assert call(daemon, "manage", **params)["error"] == "tool_call_ids_required"
    assert call(daemon, "manage", tool_call_ids="all")["error"] == "invalid_tool_call_ids"
    call(daemon, "prepare", snapshot_id="one", records=[record()])
    result = call(daemon, "manage", snapshot_id="one", tool_call_ids=["missing"], action="hide")
    assert result["items"] == [{"tool_call_id": "missing", "ok": False, "error": "not_found"}]


def test_cleanup_candidates_are_visible_eligible_newest_first_with_metadata():
    daemon = Daemon()
    records = [record(f"r{i}") for i in range(40)]
    records += [record("short", "tiny"), {**record("danger"), "tool_name": "bash", "arguments": {"command": "rm -rf demo"}}]
    assert call(daemon, "prepare", snapshot_id="one", records=records)["ok"]
    assert call(daemon, "manage", snapshot_id="one", tool_call_ids=["r39"], action="hide")["applied"] == 1
    items = call(daemon, "list_candidates", snapshot_id="one")["items"]
    assert [i["tool_call_id"] for i in items] == [f"r{i}" for i in range(38, 8, -1)]
    assert items[0] == {"tool_call_id": "r38", "tool_name": "read", "hint": "sample.txt",
                        "bytes_size": len(records[0]["content"].encode()), "tokens_display": "—"}
    assert len(call(daemon, "list_candidates", snapshot_id="one", limit=2)["items"]) == 2
    assert call(daemon, "list_candidates", snapshot_id="one", limit=0)["error"] == "invalid_limit"
    result = call(daemon, "manage", snapshot_id="one", tool_call_ids=["r39", "short", "danger"], action="summarize")
    assert [i["error"] for i in result["items"]] == ["already_hidden", "not_long", "destructive_command"]


def test_manage_has_no_id_cap_or_discovery_requirement_and_repeats_across_snapshots():
    daemon = Daemon()
    records = [record(f"r{i}") for i in range(80)]
    call(daemon, "prepare", snapshot_id="one", records=records[:64])
    call(daemon, "prepare", snapshot_id="one", append=True, records=records[64:])
    result = call(daemon, "manage", snapshot_id="one", tool_call_ids=[r["call_id"] for r in records], action="hide")
    assert result["ok"] and result["applied"] == 80
    assert call(daemon, "list_candidates", snapshot_id="one")["items"] == []
    response = call(daemon, "prepare", snapshot_id="two", records=records[:2] + [record("next-turn")])
    assert len(response["patches"]) == 2
    result = call(daemon, "manage", snapshot_id="two", tool_call_ids=["next-turn"], action="hide")
    assert result["applied"] == 1


def test_snapshot_requires_matching_token_and_preserves_session_isolation():
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    assert call(daemon, "compact", snapshot_id="wrong", tool_call_id="call-1")["error"] == "unconfirmed_snapshot"
    result = call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")
    assert result["ok"]
    assert daemon.handle({"method": "restore", "params": {"session_id": "b", "item_id": result["item_id"]}})["ok"] is False
    assert call(daemon, "prepare", snapshot_id="two", records=[record()])["patches"][0]["call_id"] == "call-1"
    assert call(daemon, "restore", item_id=result["item_id"])["ok"]
    assert call(daemon, "prepare", snapshot_id="three", records=[record()])["patches"] == []


def test_duplicate_and_error_records_never_become_candidates():
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    assert not call(daemon, "prepare", snapshot_id="two", records=[record(), record()])["ok"]
    assert call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")["error"] == "unconfirmed_snapshot"
    error_record = {**record(), "status": "error"}
    assert not call(daemon, "prepare", snapshot_id="three", records=[error_record])["ok"]
    assert not call(daemon, "prepare", snapshot_id="four", records=[{**record(), "tool_name": "bash"}])["ok"]


def test_same_content_and_call_id_with_changed_invocation_is_not_reused():
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    assert call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")["ok"]
    changed = {**record(), "arguments": {"path": "different.txt"}}
    assert call(daemon, "prepare", snapshot_id="two", records=[changed])["patches"] == []
    assert call(daemon, "compact", snapshot_id="two", tool_call_id="call-1")["error"] == "invocation_conflict"


def test_two_thousand_records_keep_early_and_late_stored_hides():
    daemon = Daemon()
    records = [record(f"call-{i}") for i in range(1, 2001)]
    assert call(daemon, "prepare", snapshot_id="seed", records=[records[0], records[1499]])["ok"]
    for call_id in ("call-1", "call-1500"):
        assert call(daemon, "compact", snapshot_id="seed", tool_call_id=call_id)["ok"]
    patches = []
    for offset in range(0, len(records), MAX_CHUNK_RECORDS):
        response = call(daemon, "prepare", snapshot_id="whole", append=offset > 0,
                        records=records[offset:offset + MAX_CHUNK_RECORDS])
        assert response["ok"]
        patches.extend(response["patches"])
    assert [patch["call_id"] for patch in patches] == ["call-1", "call-1500"]
    assert len(daemon.snapshots["a"][1]) == 2000
    assert len(call(daemon, "list_items", snapshot_id="whole")["items"]) == 2000
    assert call(daemon, "compact", snapshot_id="whole", tool_call_id="call-2000")["ok"]


def test_append_requires_matching_token_and_rejects_cross_chunk_duplicates():
    daemon = Daemon()
    assert call(daemon, "prepare", snapshot_id="missing", append=True, records=[])["error"] == "unconfirmed_snapshot"
    assert call(daemon, "prepare", snapshot_id="one", records=[record()])["ok"]
    assert call(daemon, "prepare", snapshot_id="wrong", append=True, records=[])["error"] == "unconfirmed_snapshot"
    assert "a" in daemon.snapshots
    assert call(daemon, "prepare", snapshot_id="one", append=True, records=[record()])["error"] == "invalid_record"
    assert call(daemon, "compact", snapshot_id="one", tool_call_id="call-1")["error"] == "unconfirmed_snapshot"
    assert call(daemon, "prepare", snapshot_id="empty", records=[]) == {
        "ok": True, "patches": [], "hidden_messages": [], "pending_summaries": []}


def test_bytes_and_record_limits_apply_to_chunks_not_combined_snapshot():
    daemon = Daemon()
    content = "x" * (MAX_CHUNK_BYTES // 2 + 1)
    assert call(daemon, "prepare", snapshot_id="one", records=[record("a", content)])["ok"]
    assert call(daemon, "prepare", snapshot_id="one", append=True, records=[record("b", content)])["ok"]
    assert len(daemon.snapshots["a"][1]) == 2
    assert call(daemon, "prepare", snapshot_id="too-large",
                records=[record("a", content), record("b", content)])["error"] == "snapshot_too_large"
    assert "a" not in daemon.snapshots
    assert call(daemon, "prepare", snapshot_id="too-many",
                records=[record(str(i)) for i in range(MAX_CHUNK_RECORDS + 1)])["error"] == "invalid_snapshot"
    assert call(daemon, "prepare", snapshot_id="oversized",
                records=[record("a", "x" * (MAX_CHUNK_BYTES + 1))])["error"] == "snapshot_too_large"


def test_append_refreshes_snapshot_eviction_and_new_prepare_replaces_it():
    daemon = Daemon()
    for i in range(MAX_SCOPES):
        assert daemon.handle({"method": "prepare", "params": {
            "session_id": str(i), "snapshot_id": "one", "records": []}})["ok"]
    assert daemon.handle({"method": "prepare", "params": {
        "session_id": "0", "snapshot_id": "one", "append": True, "records": [record()]}})["ok"]
    response = daemon.handle({"method": "prepare", "params": {
        "session_id": "new", "snapshot_id": "two", "records": []}})
    assert response["evicted_snapshots"] == ["1"]
    assert len(daemon.snapshots) == MAX_SCOPES
    assert "0" in daemon.snapshots
    assert daemon.handle({"method": "prepare", "params": {
        "session_id": "0", "snapshot_id": "replace", "records": []}})["ok"]
    assert daemon.snapshots["0"] == ("replace", {})
