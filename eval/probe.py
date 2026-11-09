"""Single small live request to verify usage reporting before measured runs."""
import json
import urllib.request
from pathlib import Path

from proxy import MODEL, serve

directory = Path(__file__).resolve().parent / "results/setup-glm"
directory.mkdir(parents=True, exist_ok=True)
server = serve(directory)
try:
    payload = {"model": MODEL, "messages": [{"role": "user", "content": "Reply only OK."}], "max_tokens": 32, "usage": {"include": True}}
    request = urllib.request.Request(f"http://127.0.0.1:{server.server_port}/probe/v1/chat/completions", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        result = json.load(response)
    report = {"model": result.get("model"), "usage": result.get("usage"), "answer": result.get("choices")}
    (directory / "probe.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
finally:
    server.shutdown()
