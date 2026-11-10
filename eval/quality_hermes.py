"""Real Hermes pressure sessions with native-compaction before/after evidence."""
import copy
import gzip
import json
from pathlib import Path
import sys
import time
import traceback


def main():
    spec = json.loads(Path(sys.argv[1]).read_text())
    sys.path.insert(0, spec["hermes_source"])
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from run_agent import AIAgent
    output = Path(spec["output"])
    current_turn = 0
    events = (output / "events.jsonl").open("a")

    def record(**values):
        events.write(json.dumps({"time": time.time(), "turn": current_turn, **values}, default=str) + "\n")
        events.flush()

    discover_plugins()
    plugins = [item for item in get_plugin_manager().list_plugins() if item["name"] == "session-navigation"]
    (output / "plugins.json").write_text(json.dumps(plugins, default=str, indent=2))
    assert spec["arm"] == "A" or any(p["enabled"] and p["tools"] == 5 and p["middleware"] == 1 for p in plugins)
    agent = AIAgent(model=spec["model"], api_key="local-eval", api_mode="chat_completions",
                    base_url=spec["proxy"] + "/" + spec["id"] + "/v1", provider="custom",
                    max_iterations=20, max_tokens=4096,
                    enabled_toolsets=["file", "terminal"] + (["session_navigation"] if spec["arm"] != "A" else []),
                    skip_context_files=True, skip_memory=True, skip_background_review=True, load_soul_identity=False,
                    reasoning_config={"enabled": True}, quiet_mode=True, cwd=spec["workspace"],
                    session_id=spec["id"], run_budget_seconds=600)
    compressor = agent.context_compressor
    compressor.context_length = spec["window"]
    record(kind="compressor_config", context_length=compressor.context_length, threshold_percent=compressor.threshold_percent)
    original_compress = compressor.compress
    count = 0
    def compress(messages, *args, **kwargs):
        nonlocal count
        count += 1
        before = copy.deepcopy(messages)
        record(kind="native_start", sequence=count, messages=len(before))
        with gzip.open(output / f"native-{count:02}-before.json.gz", "wt") as stream:
            json.dump(before, stream)
        try:
            result = original_compress(messages, *args, **kwargs)
            changed = result != before
            with gzip.open(output / f"native-{count:02}-after.json.gz", "wt") as stream:
                json.dump(result, stream)
            record(kind="native_end", sequence=count, success=True, changed=changed,
                   before_chars=len(json.dumps(before)), after_chars=len(json.dumps(result)))
            return result
        except Exception as error:
            record(kind="native_end", sequence=count, success=False, error=type(error).__name__)
            raise
    compressor.compress = compress
    turns, history = [], []
    try:
        for current_turn, prompt in enumerate(spec["turns"], 1):
            record(kind="turn_start")
            result = agent.run_conversation(prompt, conversation_history=history)
            history = result.get("messages", [])
            turns.append({"turn": current_turn, "prompt": prompt, "answer": result.get("final_response", ""),
                          "completed": bool(result.get("completed")), "messages": copy.deepcopy(history)})
            with gzip.open(output / "turns.json.gz", "wt") as stream:
                json.dump(turns, stream)
            record(kind="turn_end", completed=result.get("completed"))
            if not result.get("completed"):
                record(kind="incomplete_work_unit")
                break
        record(kind="complete", turns=len(turns))
    except Exception:
        record(kind="host_error", detail=traceback.format_exc())
        raise
    finally:
        agent.close()
        events.close()
        decision = Path(spec["workspace"]) / "decision.json"
        if decision.exists():
            (output / "decision.json").write_bytes(decision.read_bytes())


if __name__ == "__main__":
    main()
