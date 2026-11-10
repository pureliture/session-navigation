"""Differential vectors and cross-writer tests; local runtimes, no model calls."""

from __future__ import annotations
import asyncio
from dataclasses import asdict, replace
import json
from pathlib import Path
import subprocess
import tempfile

from session_navigation.engine import SessionNavigationEngine
from session_navigation.model import (
    ToolResultRecord,
    canonical,
    compute_invocation_digest,
    compute_sha256,
    _item_id,
)
from session_navigation.policy import (
    RuleSpanSelector,
    is_destructive_command,
    normalize_keep_lines,
    refusal_reason,
    required_evidence_lines,
    selectable_text,
    verified_facts,
)
from session_navigation.sqlite_store import SQLiteContextStore
from session_navigation.summary import validate_summary_text
from session_navigation.pending_summary import settle_summary

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = json.loads((ROOT / "contracts/fixtures/core.json").read_text())


def body(vector):
    content = "\n".join([vector["line"]] * vector["repeat"]) + (
        "\n" + vector["suffix"] if vector["suffix"] else ""
    )
    if vector.get("numbered"):
        content = "\n".join(
            f"{index + 1}|{line}" for index, line in enumerate(content.splitlines())
        )
    return (
        json.dumps(
            {"content": content, "exit_code": 0},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        if vector.get("envelope")
        else content
    )


def record(content, call_id="call"):
    invocation = {"tool_name": "read_file", "arguments": {"path": "source.txt"}}
    return ToolResultRecord(
        call_id,
        content=content,
        content_sha256=compute_sha256(content),
        invocation=invocation,
        invocation_digest=compute_invocation_digest(invocation),
    )


def snapshot(store):
    result = {}
    for table in (
        "meta",
        "items",
        "identities",
        "units",
        "calls",
        "adapter_sessions",
        "adapter_targets",
    ):
        rows = []
        for row in store.connection.execute(f"SELECT * FROM {table} ORDER BY 1,2"):
            data = dict(row)
            for key in ("created_at", "updated_at", "recorded_at", "last_seen"):
                if key in data:
                    data[key] = 0
            for key in (
                "excerpt_lines",
                "invocation_snapshot",
                "context_hint",
                "capabilities",
            ):
                if isinstance(data.get(key), str):
                    data[key] = json.loads(data[key])
            rows.append(data)
        result[table] = rows
    return result


def result_view(result):
    item = asdict(result.item) if result.item else None
    if item:
        item.pop("expires_at")
        item.update(created_at=0, updated_at=0)
    plan = asdict(result.plan) if result.plan else None
    if plan:
        plan.pop("host_handle", None)
    return {
        "ok": result.ok,
        "error": result.error,
        "plan": plan,
        "item": item,
        "keep_lines_ignored": result.keep_lines_ignored,
        "keep_lines_normalized": result.keep_lines_normalized,
    }


async def vectors():
    scope = FIXTURES["scope"]
    policies = []
    for vector in FIXTURES["policies"]:
        content = body(vector)
        tool_record = record(content)
        accepted, ignored, normalized = normalize_keep_lines(
            selectable_text(content), vector.get("keep", [])
        )
        selected = RuleSpanSelector().select(
            selectable_text(content), keep_lines=tuple(accepted)
        )
        policies.append(
            {
                "name": vector["name"],
                "sha": compute_sha256(content),
                "digest": tool_record.invocation_digest,
                "id": _item_id(
                    scope,
                    tool_record.call_id,
                    tool_record.content_sha256,
                    tool_record.invocation_digest,
                ),
                "refusal": refusal_reason(tool_record),
                "source": selectable_text(content),
                "evidence": required_evidence_lines(content),
                "selected": selected.lines if selected else None,
                "retention": {
                    "accepted": accepted,
                    "ignored": ignored,
                    "normalized": normalized,
                },
                "facts": verified_facts(content),
            }
        )
    operations = []

    class Summary:
        async def summarize(self, *args, **kwargs):
            return {"summary": self.text}

    for vector in FIXTURES["engine"]:
        with tempfile.TemporaryDirectory() as directory:
            store = SQLiteContextStore(Path(directory) / "state.db")
            engine = SessionNavigationEngine(store)
            tool_record = record(body(vector))
            summary = Summary() if vector.get("summary") else None
            if summary:
                summary.text = vector["summary"]
            hide = await engine._apply(scope, tool_record, summarizer=summary)
            item_id = _item_id(
                scope,
                tool_record.call_id,
                tool_record.content_sha256,
                tool_record.invocation_digest,
            )
            conflict = engine.restore(scope, item_id, 99)
            unhide = engine.restore(scope, item_id, 1)
            rehide = await engine.compact(scope, tool_record)
            fork = store.fork_scope(scope, "hermes:default:child:unknown").to_dict()
            operations.append(
                {
                    "name": vector["name"],
                    "hide": result_view(hide),
                    "conflict": result_view(conflict),
                    "unhide": result_view(unhide),
                    "rehide": result_view(rehide),
                    "fork": fork,
                    "rows": snapshot(store),
                }
            )
            store.close()
    with tempfile.TemporaryDirectory() as directory:
        store = SQLiteContextStore(
            Path(directory) / "shared.db",
            scope_aliases={"hermes": ("unknown", "default")},
        )
        owner = dict(
            adapter_id="hermes",
            adapter_protocol=1,
            capabilities=dict(hide=True, summarize=False, unhide=True),
            enabled=True,
            instance_id="fixture",
        )
        registered = [
            store.register_adapter(scope, **owner, now=100),
            store.register_adapter(scope, **owner, now=101),
            store.register_adapter(scope, **owner, now=400),
        ]
        capability = [
            store.adapter_can(scope, "hide"),
            store.adapter_can(scope, "summarize"),
            store.adapter_can(scope.replace(":unknown", ":default"), "hide"),
        ]
        store.publish_targets(
            scope,
            [(record(f"original {index}", str(index)), {}) for index in range(258)],
        )
        target_calls = [row["tool_call_id"] for row in store.adapter_targets(scope)]
        store.ensure_message_units(
            scope, [("message", "user", compute_sha256("hi"), 2)]
        )
        messages = [
            store.set_message_visibility(
                scope,
                "message",
                kind="user",
                content_sha256=compute_sha256("hi"),
                char_count=2,
                visibility="hidden",
                expected_version=1,
            ),
            store.set_message_visibility(
                scope,
                "message",
                kind="user",
                content_sha256=compute_sha256("hi"),
                char_count=2,
                visibility="visible",
                expected_version=1,
            ),
        ]
        store.record_call(scope, "usage", 10, 20, 30, 0.25, 100)
        schema_info = {
            table: [
                dict(row)
                for row in store.connection.execute(f"PRAGMA table_info({table})")
            ]
            for table in (
                "meta",
                "items",
                "identities",
                "units",
                "calls",
                "adapter_sessions",
                "adapter_targets",
            )
        }
        shared = dict(
            registered=registered,
            capability=capability,
            targetCalls=target_calls,
            messages=messages,
            hidden=store.hidden_message_keys(scope),
            rows=snapshot(store),
            schemaInfo=schema_info,
        )
        engine = SessionNavigationEngine(store)
        tool_record = record(body(FIXTURES["engine"][0]), "pending")
        item = (await engine.compact(scope, tool_record)).item
        store.put(
            scope,
            replace(item, compaction_source="summarize_pending", version=2),
            expected_version=1,
        )
        pending = [
            result_view(
                settle_summary(
                    store,
                    scope,
                    item.item_id,
                    2,
                    "Routine catalog annotation with no special facts.",
                )
            ),
            result_view(
                settle_summary(
                    store, scope, item.item_id, 2, "Routine catalog annotation."
                )
            ),
        ]
        store.close()
    return json.loads(
        json.dumps(
            {
                "canonical": [
                    canonical(json.loads(raw)) for raw in FIXTURES["canonical"]
                ],
                "aliases": [scope, scope.removesuffix("unknown") + "default"],
                "policies": policies,
                "summaries": [
                    validate_summary_text(
                        vector["source"], {"summary": vector["text"]}, ()
                    )
                    for vector in FIXTURES["summaries"]
                ],
                "commands": [
                    is_destructive_command("bash", {"command": command})
                    for command in FIXTURES["commands"]
                ],
                "operations": operations,
                "shared": shared,
                "pending": pending,
            }
        )
    )


def differences(expected, actual, path="root"):
    if isinstance(expected, dict) and isinstance(actual, dict):
        assert expected.keys() == actual.keys(), (
            f"{path}: keys {expected.keys()} != {actual.keys()}"
        )
        for key in expected:
            differences(expected[key], actual[key], f"{path}.{key}")
    elif isinstance(expected, list) and isinstance(actual, list):
        assert len(expected) == len(actual), (
            f"{path}: length {len(expected)} != {len(actual)}"
        )
        for index, (expected_value, actual_value) in enumerate(zip(expected, actual)):
            differences(expected_value, actual_value, f"{path}[{index}]")
    else:
        assert expected == actual, f"{path}: {expected!r} != {actual!r}"


def main():
    expected = asyncio.run(vectors())
    for runtime in ("node", "bun"):
        output = subprocess.run(
            [runtime, str(ROOT / "packages/core/test/conformance-run.ts")],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        differences(expected, json.loads(output.stdout))
        print(
            f"PASS differential Python vs TS+{runtime}: canonical, policy, summaries, mutations, replacements and final rows"
        )
        cross_writer(runtime)


def cross_writer(runtime):
    with tempfile.TemporaryDirectory() as directory:
        path = str(Path(directory) / "cross.db")
        scope = FIXTURES["scope"]
        tool_record = record(body(FIXTURES["engine"][0]))
        store = SQLiteContextStore(path)
        engine = SessionNavigationEngine(store)
        item = engine.compact_sync(scope, tool_record).item
        replacement = item.compacted
        store.close()
        subprocess.run(
            [
                runtime,
                str(ROOT / "packages/core/test/cross-writer.ts"),
                path,
                "read-python",
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        store = SQLiteContextStore(path)
        saved = store.get(scope, item.item_id)
        assert saved.visibility == "visible" and saved.version == 2
        assert (
            saved.original == tool_record.content
            and saved.content_sha256 == tool_record.content_sha256
        )
        assert saved.compacted == replacement
        assert len(store.adapter_targets(scope)) == 1
        store.close()
        reverse = str(Path(directory) / "reverse.db")
        subprocess.run(
            [
                runtime,
                str(ROOT / "packages/core/test/cross-writer.ts"),
                reverse,
                "write-ts",
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        store = SQLiteContextStore(reverse)
        item = store.items(scope)[0]
        assert (
            item.visibility == "hidden"
            and item.version == 1
            and item.original == tool_record.content
        )
        assert item.compacted == replacement
        assert store.restore(scope, item.item_id, expected_version=1).ok
        store.close()
        subprocess.run(
            [
                runtime,
                str(ROOT / "packages/core/test/cross-writer.ts"),
                reverse,
                "verify-python",
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        print(f"PASS cross-writer Python -> TS+{runtime} -> Python and reverse")


if __name__ == "__main__":
    main()
