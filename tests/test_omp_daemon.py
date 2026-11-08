"""OMP adapter와 Python 엔진의 RPC 계약을 검증한다."""
from session_navigation_omp.daemon import Daemon


def record(call_id="call-1", text=None):
    return {"call_id": call_id, "tool_name": "read", "arguments": {"path": "sample.txt"},
            "status": "ok", "content": text or "\n".join(f"Output row {i:03} details" for i in range(100))}


def call(daemon, method, **params):
    return daemon.handle({"method": method, "params": {"session_id": "a", **params}})


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
