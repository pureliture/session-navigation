"""Real Hermes with instance-only observers; no installed runtime edits."""
import copy
import json
import sys
import time
from pathlib import Path

spec = json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0, spec["hermes_source"])
from hermes_cli.plugins import discover_plugins, get_plugin_manager
from run_agent import AIAgent

turn = 0


def record(**value):
    with Path(spec["output"], "events.jsonl").open("a") as handle:
        handle.write(json.dumps({"time": time.time(), "turn": turn, **value}, default=str) + "\n")


discover_plugins()
plugins = [item for item in get_plugin_manager().list_plugins() if item["name"] == "session-navigation"]
Path(spec["output"], "plugins.json").write_text(json.dumps(plugins, default=str, indent=2))
expected_middleware = 2 if spec.get("display_arm") == "B-current" else 1
assert spec["arm"] == "A" or any(p["enabled"] and p["tools"] == 5 and p["middleware"] == expected_middleware for p in plugins)
agent = AIAgent(model=spec["model"], provider="custom", api_mode="chat_completions",
    base_url=spec["proxy"] + "/" + spec["id"] + "/v1", api_key="local-eval", max_iterations=20, max_tokens=4096,
    enabled_toolsets=["file", "terminal"] + (["session_navigation"] if spec["arm"] != "A" else []),
    skip_context_files=True, skip_memory=True, skip_background_review=True, load_soul_identity=False,
    reasoning_config={"enabled": True}, quiet_mode=True, cwd=spec["workspace"], session_id=spec["id"], run_budget_seconds=600)
compressor = agent.context_compressor
compressor.context_length = spec["window"]
record(kind="compressor_config", context_length=compressor.context_length, threshold_percent=compressor.threshold_percent)
original_compress = compressor.compress


def observed_compress(*args, **kwargs):
    record(kind="host_event", event={"type": "native_compaction_start"})
    try:
        result = original_compress(*args, **kwargs)
        record(kind="host_event", event={"type": "native_compaction_end", "success": True})
        return result
    except Exception as error:
        record(kind="host_event", event={"type": "native_compaction_end", "success": False, "error": type(error).__name__})
        raise


compressor.compress = observed_compress
history, turns = [], []
try:
    for turn, prompt in enumerate(spec["turns"], 1):
        record(kind="user", prompt=prompt)
        result = agent.run_conversation(prompt, conversation_history=history)
        history = result.get("messages", history)
        turns.append({"turn": turn, "prompt": prompt, "answer": result.get("final_response", ""), "messages": copy.deepcopy(history)})
        Path(spec["output"], "turns.json").write_text(json.dumps(turns, default=str))
        record(kind="context_usage", usage={"contextWindow": compressor.context_length, "tokens": getattr(compressor, "last_prompt_tokens", None)})
        print(spec["id"], "turn", turn, "complete", flush=True)
finally:
    agent.close()
