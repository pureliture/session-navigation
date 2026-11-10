"""Loopback-only, env-key-only model guard; no authentication headers are logged."""
import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "z-ai/glm-5.3-flash"


def serve(directory, *, model=MODEL, provider=None, reasoning=None, budget=None):
    key = os.environ["OPENROUTER_API_KEY"]
    lock = threading.Lock()

    def event(**value):
        raw = json.dumps({"time": time.time(), **value}, ensure_ascii=False)
        if key in raw:
            raise ValueError("secret rejected before logging")
        with lock, gzip.open(directory / "wire.jsonl.gz", "at") as output:
            output.write(raw + "\n")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            identity = uuid.uuid4().hex
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            body = json.loads(raw)
            if body.get("model") != model or key.encode() in raw:
                self.send_error(400, "Only approved model and non-secret bodies allowed")
                event(kind="blocked", id=identity, path=self.path)
                return
            event(kind="request", id=identity, path=self.path, body=body)
            upstream_body = {**body, "stream": False, "usage": {"include": True}}
            if provider:
                upstream_body["provider"] = {"order": [provider], "allow_fallbacks": False}
            if budget is not None:
                if provider != "Relace":
                    self.send_error(400, "Budget pricing requires Relace")
                    return
                upstream_body["provider"]["max_price"] = {"prompt": .006, "completion": .5}
            if reasoning is not None:
                upstream_body["reasoning"] = reasoning
            upstream_body.pop("stream_options", None)
            for attempt in range(7):
                budget_id = f"{identity}:{attempt}"
                if budget is not None:
                    try:
                        budget.reserve(budget_id, upstream_body)
                    except ValueError as error:
                        event(kind="failure", id=identity, path=self.path, error=str(error), attempt=attempt)
                        self.send_error(402, "Campaign budget guard")
                        return
                event(kind="upstream_request", id=identity, path=self.path, attempt=attempt, body=upstream_body)
                request = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
                    data=json.dumps(upstream_body).encode(), headers={"Authorization": "Bearer " + key,
                    "Content-Type": "application/json", "X-Title": "Session Navigation A/B Evaluation"})
                try:
                    with urllib.request.urlopen(request, timeout=180) as response:
                        payload = response.read()
                    result = json.loads(payload)
                    if "error" in result:
                        code = int(result["error"].get("code", 502))
                        if code == 429 or code >= 500:
                            raise urllib.error.HTTPError(request.full_url, code, "provider error", {}, None)
                    if budget is not None:
                        budget.settle(budget_id, result.get("usage", {}))
                    event(kind="response", id=identity, path=self.path, body=result, attempt=attempt)
                    break
                except urllib.error.HTTPError as error:
                    detail = error.read().decode("utf-8", "replace") if error.fp else "provider error"
                    retry = (error.code == 429 or error.code >= 500) and attempt < 6
                    try:
                        after = float((error.headers or {}).get("Retry-After", 0))
                    except ValueError:
                        after = 0
                    delay = min(120, max(after, 2 ** (attempt + 1))) if retry else 0
                    event(kind="retry" if retry else "failure", id=identity, path=self.path,
                        status=error.code, attempt=attempt, delay=delay, detail=detail.replace(key, "[REDACTED]"))
                    if retry:
                        time.sleep(delay)
                        continue
                    self.send_error(error.code, "Upstream exhausted retries")
                    return
                except Exception as error:
                    event(kind="failure", id=identity, path=self.path, error=type(error).__name__)
                    self.send_error(502, "Upstream transport failure")
                    return
            if body.get("stream"):
                message = result["choices"][0]["message"]
                delta = {**message, "role": "assistant", "content": message.get("content") or ""}
                if message.get("tool_calls"):
                    delta["tool_calls"] = [{"index": i, **call} for i, call in enumerate(message["tool_calls"])]
                chunks = [{"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": result["choices"][0].get("finish_reason", "stop")}], "usage": result.get("usage", {})}]
                payload = ("".join("data: " + json.dumps({"id": result.get("id", identity), "object": "chat.completion.chunk",
                    "created": int(time.time()), "model": model, **chunk}) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode()
                content_type = "text/event-stream"
            else:
                payload = json.dumps(result).encode()
                content_type = "application/json"
            try:
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                event(kind="client_closed", id=identity, path=self.path)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
