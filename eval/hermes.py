"""Run actual Hermes agent, with plugin discovery in an isolated HERMES_HOME."""
import json
import sys
from pathlib import Path

spec = json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0, spec["hermes_source"])
from hermes_cli.plugins import discover_plugins, get_plugin_manager
from run_agent import AIAgent

discover_plugins()
plugins = [item for item in get_plugin_manager().list_plugins() if item["name"] == "session-navigation"]
Path(spec["output"], "plugins.json").write_text(json.dumps(plugins, default=str, indent=2))
assert spec["arm"] != "B" or any(item["enabled"] and item["tools"] == 5 and item["middleware"] == 1 for item in plugins), "B plugin must be loaded with all tools and middleware"
agent = AIAgent(model="z-ai/glm-5.3-flash", provider="custom", api_mode="chat_completions",
    base_url=spec["proxy"] + "/" + spec["id"] + "/v1", api_key="local-eval",
    max_iterations=15, max_tokens=4096, enabled_toolsets=["file", "terminal"] + (["session_navigation"] if spec["arm"] == "B" else []),
    skip_context_files=True, skip_memory=True, skip_background_review=True, load_soul_identity=False,
    reasoning_config={"enabled": True}, quiet_mode=True, cwd=spec["workspace"], session_id=spec["id"], run_budget_seconds=300)
history = []
turns = []
for index, prompt in enumerate(spec["turns"], 1):
    result = agent.run_conversation(prompt, conversation_history=history)
    history = result.get("messages", history)
    turns.append({"turn": index, "answer": result.get("final_response", ""), "messages": history, "result": result})
    Path(spec["output"], "turns.json").write_text(json.dumps(turns, default=str))
    print(spec["id"], "turn", index, "complete", flush=True)
agent.close()
