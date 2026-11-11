"""No-network completions for exercising real hosts and the projection pipeline."""
import io
import json
import re
import uuid

from v2_fixtures import document


def respond(request, **_):
    body = json.loads(request.data)
    messages = body["messages"]
    system = str(messages[0].get("content", ""))
    facts = document("component", 1)[1]
    summary = "Summarize this tool result" in system or system.startswith("Summarize the tool result.")
    def content(message):
        raw = message.get("content", "")
        return raw if isinstance(raw, str) else "\n".join(p.get("text", "") for p in raw or [])
    users = [i for i, m in enumerate(messages) if m["role"] == "user" and not content(m).startswith("[context-navigation]")]
    start = users[-1] if users else 0
    prompt = content(messages[start])
    tail = messages[start + 1:]
    completed = [m for m in tail if m["role"] == "tool"]
    tools = {t["function"]["name"] for t in body.get("tools", [])}
    call = None
    answer = "; ".join(facts)
    if not summary:
        if ("Read audit-01.jsonl in full" in prompt or "Work unit " in prompt or "Inspect incident.log" in prompt) and not completed:
            name = "read" if "read" in tools else "read_file"
            match = re.search(r"audit-\d+\.jsonl|incident\.log", prompt)
            call = (name, {"path": match.group()})
        elif ("using rule-based Hide" in prompt or "using the session LLM" in prompt) and not completed:
            read_ids = [m["tool_call_id"] for m in messages[:start] if m["role"] == "tool"]
            if "using rule-based Hide" in prompt:
                call = ("manage_context", {"tool_call_ids": [read_ids[0]], "action": "hide", "keep_lines": facts})
            else:
                call = ("summarize_context", {"tool_call_id": read_ids[0]})
        elif "restore the original result" in prompt and not completed:
            ids = re.findall(r"item_[a-f0-9]+", json.dumps(messages[:start]))
            if ids:
                call = ("unhide_context", {"item_id": ids[-1]})
        elif "Diagnose the rounding bug" in prompt and not completed:
            command = "python3 -c \"from pathlib import Path; p=Path('ledger.py'); p.write_text(p.read_text().replace('// 100 + 1', '// 100'))\" && python3 -m unittest -v"
            name = "bash" if "bash" in tools else "terminal"
            call = (name, {"command": command})
        elif "final independent verification" in prompt and not completed:
            call = ("bash" if "bash" in tools else "terminal", {"command": "python3 -m unittest -v"})
        campaign = "boreal" if "boreal" in json.dumps(messages) else "atlas"
        match = re.search(r"Work unit (\d+):", prompt)
        if match:
            answer = "; ".join(document(campaign, int(match.group(1)))[1]) + "; us-east,eu-west,ap-south"
        elif "final release memo" in prompt:
            answer = "; ".join(f for phase in (1, 8, 15) for f in document(campaign, phase)[1]) + "; checksum mismatch; blocked; 23; do not retry"
        elif "Recovery probe" in prompt:
            answer = "; ".join(document(campaign, 2)[1])
        elif "incident.log" in prompt:
            answer = "checksum mismatch; blocked; 23; do not retry"
        elif "rounding bug" in prompt or "independent verification" in prompt:
            answer = "All tests pass."
    message = {"role": "assistant", "content": None if call else answer}
    if summary and "JSON only" in system:
        message["content"] = json.dumps({"summary": answer})
    if call:
        if call[0] not in tools and "tool_call" in tools:
            call = ("tool_call", {"calls": [{"name": call[0], "arguments": call[1]}]})
        message["tool_calls"] = [{"id": "stub-" + uuid.uuid4().hex, "type": "function",
                                   "function": {"name": call[0], "arguments": json.dumps(call[1])}}]
    return io.BytesIO(json.dumps({"id": "stub-" + uuid.uuid4().hex, "model": body["model"], "provider": "Relace",
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if call else "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20, "cost": 0,
                  "prompt_tokens_details": {"cached_tokens": 0}, "completion_tokens_details": {"reasoning_tokens": 0}}}).encode())
