import http.client
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from proxy import serve
from v2_fixtures import build, component, document
from v2_run import child_environment, STAGES, positive_int
from v2_analyze import adoption_gate, boundary_index, eligible, match_fact
from analyze import native_operations, response_failure_kind
from v2_cost import projection
from v2_archive import archive
from analyze import read_wire
from v2_cache import transitions
from v2_rereads import session_rereads
from v2_answer_surface import unit_answer, final_backreference
from v4_assemble import check_settings, SETTINGS, case_name
import gzip


class V2Tests(unittest.TestCase):
    def test_reuse_requires_identical_settings_and_recognizes_case(self):
        check_settings(dict(SETTINGS))
        for field, value in (("model", "wrong"), ("provider", {"order": ["Other"]}),
                             ("reasoning", None), ("window", 128000)):
            with self.assertRaises(AssertionError):
                check_settings({**SETTINGS, field: value})
        with self.assertRaises(KeyError):
            check_settings({})
        self.assertEqual(case_name({"id": "v4-hermes-boreal-B-old-2"}), "boreal")

    def test_final_backreferences_not_earlier_visible_answers(self):
        for answer in ("Reported above.", "See above", "Values already provided.", "As earlier, done.",
                       "Memo above stands.", "Extracted values retained above.", "Facts retained in the reports above."):
            self.assertTrue(final_backreference(answer))
        for answer in ("", "owner=Orchid; seal=atlas-123; budget=73", "Cleanup complete.", "Budget above 150 ms."):
            self.assertFalse(final_backreference(answer))

    def test_resume_repetition_numbers_are_positive(self):
        self.assertEqual(positive_int("1"), 1)
        self.assertEqual(positive_int("2"), 2)
        for value in ("", "0", "-1", "invalid"):
            with self.assertRaises(argparse.ArgumentTypeError):
                positive_int(value)

    def test_answer_before_cleanup_is_visible_but_previous_turn_is_not(self):
        turn = {"prompt": "Unit 2", "answer": "Reported above", "messages": [
            {"role": "user", "content": "Unit 1"},
            {"role": "assistant", "content": "old fact"},
            {"role": "user", "content": "Unit 2"},
            {"role": "assistant", "content": [{"type": "text", "text": "owner=Orchid"},
                                                {"type": "toolCall", "name": "hide_context"}]},
            {"role": "assistant", "content": "Reported above"}]}
        answer, captured = unit_answer(turn)
        self.assertTrue(captured)
        self.assertIn("owner=Orchid", answer)
        self.assertNotIn("old fact", answer)
        self.assertEqual(unit_answer({"prompt": "absent", "answer": ""}), ("", False))

    def test_nemotron_stage_has_exact_free_model_and_single_provider(self):
        self.assertEqual(STAGES["nemotron"], ("nvidia/nemotron-3.5-lightning:free", "Nvidia"))

    def test_rereads_empty_events_and_rejected_cleanup(self):
        self.assertEqual(session_rereads([], [])["work_calls"], 0)
        events = [{"time": index, "turn": index, "kind": "host_event",
                   "event": {"type": "tool_execution_start", "toolCallId": str(index),
                             "toolName": "read", "args": {"path": "audit-01.jsonl"}}}
                  for index in (1, 3)]
        events.append({"time": 2, "turn": 1, "kind": "nav_end", "id": "n"})
        rejected = [{"id": "n", "name": "hide_context", "turn": 1,
                     "args": {"tool_call_id": "1"}, "result": {"ok": False}}]
        report = session_rereads(events, rejected)
        self.assertEqual((report["after_compaction"], report["repeat_visible"]), (0, 1))

    def test_rereads_separate_hidden_targets_from_still_visible_repeats(self):
        def start(time, turn, call_id, tool, args):
            return {"time": time, "turn": turn, "kind": "host_event",
                    "event": {"type": "tool_execution_start", "toolCallId": call_id,
                              "toolName": tool, "args": args}}

        events = [
            start(1, 1, "c1", "read", {"path": "audit-01.jsonl"}),
            start(2, 1, "c2", "bash", {"command": "wc -l audit-02.jsonl"}),
            {"time": 3, "turn": 1, "kind": "nav_end", "id": "n1"},
            start(4, 1, "c3", "bash", {"command": "grep seal audit-01.jsonl"}),
            start(5, 3, "c4", "read", {"path": "audit-02.jsonl"}),
            start(6, 3, "c5", "read", {"path": "audit-09.jsonl"}),
        ]
        operations = [{"id": "n1", "name": "manage_context", "turn": 1,
                       "args": {"action": "hide", "tool_call_ids": ["c1"]},
                       "result": {"ok": True, "item_id": "item_1"}}]
        summary = session_rereads(events, operations)
        self.assertEqual(summary["after_compaction"], 1)
        self.assertEqual(summary["repeat_visible"], 1)
        self.assertEqual(summary["new"], 3)
        self.assertEqual((summary["same_turn"], summary["later_turn"]), (1, 0))
        self.assertEqual(summary["bash"], {"after_compaction": 1, "repeat_visible": 0, "new": 1})
        self.assertEqual(summary["read"]["repeat_visible"], 1)

    def test_unhide_clears_the_hidden_file_before_a_later_read(self):
        events = [
            {"time": 1, "turn": 1, "kind": "host_event",
             "event": {"type": "tool_execution_start", "toolCallId": "c1", "toolName": "read",
                       "args": {"path": "audit-01.jsonl"}}},
            {"time": 2, "turn": 1, "kind": "nav_end", "id": "n1"},
            {"time": 3, "turn": 2, "kind": "nav_end", "id": "n2"},
            {"time": 4, "turn": 2, "kind": "host_event",
             "event": {"type": "tool_execution_start", "toolCallId": "c2", "toolName": "read",
                       "args": {"path": "audit-01.jsonl"}}},
        ]
        operations = [
            {"id": "n1", "name": "hide_context", "turn": 1, "args": {"tool_call_id": "c1"},
             "result": {"ok": True, "item_id": "item_1"}},
            {"id": "n2", "name": "unhide_context", "turn": 2, "args": {"item_id": "item_1"},
             "result": {"ok": True}},
        ]
        summary = session_rereads(events, operations)
        self.assertEqual((summary["after_compaction"], summary["repeat_visible"]), (0, 1))
        self.assertEqual(summary["unhide_calls"], 1)

    def test_empty_length_answer_has_distinct_failure_kind(self):
        body = {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
        self.assertEqual(response_failure_kind(body), "empty_answer_length")
        self.assertIsNone(response_failure_kind({"choices": [{"finish_reason": "length", "message": {"content": "partial"}}]}))
        self.assertIsNone(response_failure_kind({"choices": [{"finish_reason": "stop", "message": {"content": ""}}]}))

    def test_cache_transitions_deduplicate_batches_and_preserve_missing_usage(self):
        def request(identity, content):
            return {"id": identity, "kind": "request", "path": "/run/v1", "body": {"tools": ["read"], "messages": [{"role": "tool", "content": content}]}}
        wire = [request("old", "original"), request("new", "[hidden:item1] [hidden:item2]")]
        replacements = [{"run": "run", "actually_sent": True, "item_id": identity, "replacement": f"[hidden:{identity}]"} for identity in ["item1", "item2"]]
        usage = [{"id": "old", "prompt": 100, "cached": 90, "cost": .001}, {"id": "new", "prompt": 60, "cached": 20, "cost": .0008}]
        report = {"id": "run", "arm": "B-new", "usage": usage}
        result = transitions(wire, replacements, [report])
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["uncached_growth"], 30)
        self.assertAlmostEqual(result["groups"]["B-new"]["native_growth_sensitivity_usd"], .00000003)
        self.assertEqual(transitions([], [], [report])["events"], [])
        usage[1]["cached"] = None
        self.assertIsNone(transitions(wire, replacements, [report])["groups"]["B-new"]["reference_growth_sensitivity_usd"])

    @unittest.skipUnless(shutil.which("bun") and Path("/opt/homebrew/lib/node_modules/@oh-my-pi/pi-coding-agent").exists(), "Installed OMP SDK required")
    def test_empty_sdk_session_binds_model_and_loads_native_dependency_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = Path(__file__).resolve().parents[2]
            for name in ("home", "workspace", "output"):
                (root / name).mkdir()
            spec = {"id": "offline-binding", "arm": "B-new", "repo": str(repo), "model": "stealth/crouton-alpha",
                    "window": 65536, "proxy": "http://127.0.0.1:1", "turns": [],
                    **{name: str(root / name) for name in ("home", "workspace", "output")}}
            (root / "spec.json").write_text(json.dumps(spec))
            result = subprocess.run(["bun", str(repo / "eval/v2_omp.ts"), str(root / "spec.json")],
                env=child_environment(root / "home", repo, root, root / "workspace"), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            events = [json.loads(line) for line in (root / "output/events.jsonl").read_text().splitlines()]
            self.assertTrue(next(row for row in events if row["kind"] == "host_dependency")["native_loaded"])
            bound = next(row for row in events if row["kind"] == "extension_binding")
            self.assertEqual((bound["model"], bound["window"]), (spec["model"], spec["window"]))

    def test_numeric_budget_accepts_attached_unit_not_other_numbers(self):
        self.assertTrue(match_fact("Latency budget: `151ms`", "151"))
        self.assertTrue(match_fact("151 ms", "151"))
        self.assertTrue(match_fact("Exit code: 23.", "23"))
        self.assertFalse(match_fact("1151ms", "151"))
        self.assertFalse(match_fact("151foo", "151"))
        self.assertFalse(match_fact("151.2ms", "151"))

    def test_both_sides_of_one_boundary_are_not_two_boundaries(self):
        calls = {"read1": {"name": "read", "turn": 1}, "clean1": {"name": "manage_context", "turn": 1},
                 "clean2": {"name": "manage_context", "turn": 2}, "read2": {"name": "read", "turn": 2},
                 "middle": {"name": "manage_context", "turn": 2}, "read3": {"name": "read", "turn": 2}}
        self.assertEqual(boundary_index({"id": "clean1", "turn": 1}, calls), 1)
        self.assertEqual(boundary_index({"id": "clean2", "turn": 2}, calls), 1)
        self.assertIsNone(boundary_index({"id": "middle", "turn": 2}, calls))

    def test_wire_archive_preserves_all_bytes_and_model_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = [{"kind": "request", "body": {"model": "approved", "messages": ["large" * 1000]}}]
            with gzip.open(root / "wire.jsonl.gz", "wt") as packed:
                packed.write(json.dumps(rows[0]) + "\n")
            archive(root)
            self.assertEqual(read_wire(root), rows)
            self.assertFalse((root / "wire.jsonl.gz").exists())

    def test_pilot_cost_gate_rejects_missing_cost_and_over_budget(self):
        groups = {f"omp/{arm}": {"n": 1, "complete": 1, "cost": .2, "output_tokens": 1000, "prompt_tokens": 10000, "cached_tokens": 100, "missing_cost": 0} for arm in ("A", "B-new")}
        self.assertTrue(projection({"groups": groups})["continue"])
        self.assertAlmostEqual(projection({"groups": groups})["projected_total_usd"], 2.4)
        self.assertAlmostEqual(projection({"groups": groups}, prior_cost=.4)["projected_total_usd"], 2.8)
        groups["omp/A"]["missing_cost"] = 1
        self.assertFalse(projection({"groups": groups})["continue"])
        groups["omp/A"].update(missing_cost=0, cost=1)
        self.assertFalse(projection({"groups": groups})["continue"])
        self.assertFalse(projection({"groups": {}})["continue"])

    def test_deferred_singleton_is_not_misreported_as_zero_navigation(self):
        calls = {"bridge": {"name": "tool_call", "turn": 3, "args": {"calls": [
            {"name": "manage_context", "arguments": {"tool_call_ids": ["real-id"], "action": "hide"}}]}}}
        records = {"bridge": {"original": '{"ok":true,"applied":1}'}}
        operations = native_operations(calls, records)
        self.assertEqual(len(operations), 1)
        self.assertEqual(operations[0]["args"]["tool_call_ids"], ["real-id"])
        self.assertEqual(operations[0]["result"]["applied"], 1)

    def test_eligibility_and_predeclared_adoption_gate(self):
        record = {"id": "r", "original": "\n".join(f"measured observation {i}" for i in range(100)),
                  "label_info": {"protected": False}, "name": "read", "args": {"path": "audit.jsonl"}}
        self.assertTrue(eligible(record))
        self.assertFalse(eligible({**record, "label_info": {"protected": True}}))
        self.assertFalse(eligible({**record, "original": "tiny"}))
        rows = [{"arm": "B-new", "component": None, "literal_ids_valid": 10, "literal_ids_selected": 10,
                 "successful_cleanup_boundaries": [1, 3]}]
        self.assertTrue(adoption_gate(rows)["pass"])
        self.assertFalse(adoption_gate([{**rows[0], "literal_ids_valid": 1}])["pass"])
        self.assertFalse(adoption_gate([{**rows[0], "component": "hide"}])["pass"])

    def test_distinct_long_fixtures_and_separate_obligations(self):
        with tempfile.TemporaryDirectory() as tmp:
            cases = build(Path(tmp))
            for case in cases:
                self.assertEqual(len(case["turns"]), 25)
                self.assertEqual(len(case["answers"]), 25)
                self.assertEqual(len({document(case["id"], i)[0] for i in range(1, 21)}), 20)
                eligible = [item for item in case["results"] if not item["protected"]]
                self.assertEqual(sum(item["announced"] for item in eligible), 3)
                self.assertEqual(sum(item["surprise_probe"] for item in eligible), 1)
                self.assertEqual(case["fixture_sha256"], build(Path(tmp))[cases.index(case)]["fixture_sha256"])
            self.assertIn("Do not clean", component("hide")["turns"][0])

    def test_child_does_not_receive_key_and_uses_versioned_core(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret", "OTHER_KEY": "other-secret"}):
            env = child_environment(Path("home"), Path("versioned"), Path("work"), Path("workspace"))
            self.assertNotIn("OPENROUTER_API_KEY", env)
            self.assertNotIn("OTHER_KEY", env)
            self.assertEqual(env["PYTHONPATH"], "versioned/src")
            self.assertTrue(env["NODE_PATH"].endswith("pi-coding-agent/node_modules"))

    def test_one_model_and_forced_provider_no_fallback(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-secret"}):
            server = serve(Path(tmp), model="stealth/crouton-alpha", provider="Stealth", reasoning={"enabled": False, "exclude": True})
            try:
                def post(body):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
                    connection.request("POST", "/test", json.dumps(body))
                    response = connection.getresponse()
                    value = response.read()
                    connection.close()
                    return response.status, value
                with patch("urllib.request.urlopen") as upstream:
                    self.assertEqual(post({"model": "z-ai/glm-5.3-flash"})[0], 400)
                    upstream.assert_not_called()
                    upstream.return_value.__enter__.return_value.read.return_value = json.dumps({"choices": [{"message": {"content": "OK", "reasoning_details": [{"type": "reasoning.encrypted", "data": "opaque"}]}}]}).encode()
                    code, value = post({"model": "stealth/crouton-alpha", "provider": {"order": ["wrong"]}, "stream": True})
                    self.assertEqual(code, 200)
                    self.assertIn(b"opaque", value)
                    upstream_body = json.loads(upstream.call_args.args[0].data)
                    self.assertEqual(upstream_body["provider"], {"order": ["Stealth"], "allow_fallbacks": False})
                    self.assertEqual(upstream_body["reasoning"], {"enabled": False, "exclude": True})
            finally:
                server.shutdown()
                server.server_close()
