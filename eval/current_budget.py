"""Persistent, fail-closed spend reservations shared by all campaign proxies."""
import json
import threading
import time
from decimal import Decimal


class Budget:
    def __init__(self, path, limit="5"):
        self.path = path
        self.lock = threading.Lock()
        self.limit = Decimal(limit)
        self.state = json.loads(path.read_text()) if path.exists() else {
            "limit": str(self.limit), "spent": "0", "reservations": {}, "charges": {}, "over_3": None}
        if Decimal(self.state["limit"]) != self.limit:
            raise ValueError("Never change an existing campaign budget")
        self.save()

    def save(self):
        temporary = self.path.with_suffix(".pending")
        temporary.write_text(json.dumps(self.state, indent=2) + "\n")
        temporary.replace(self.path)

    def reserve(self, identity, body):
        maximum = body.get("max_tokens", body.get("max_completion_tokens", 943718))
        if not isinstance(maximum, int) or not 0 < maximum <= 943718:
            raise ValueError("Explicit bounded output required")
        if any(not isinstance(m.get("content"), (str, list, type(None))) for m in body.get("messages", [])):
            raise ValueError("Unsupported message content")
        if any(part.get("type") not in ("text",) for m in body.get("messages", [])
               if isinstance(m.get("content"), list) for part in m["content"]):
            raise ValueError("Text-only budget bound")
        # UTF-8 byte count overbounds text tokens; padding covers chat/tool framing.
        prompt_bound = len(json.dumps(body, ensure_ascii=False).encode()) + 4096
        amount = Decimal(prompt_bound) * Decimal("0.000000006") + Decimal(maximum) * Decimal("0.0000005") + Decimal("0.000001")
        with self.lock:
            held = sum(Decimal(v) for v in self.state["reservations"].values())
            if self.state.get("blocked") or Decimal(self.state["spent"]) + held + amount > self.limit:
                raise ValueError("Campaign budget exhausted or unresolved usage")
            if identity in self.state["reservations"] or identity in self.state["charges"]:
                raise ValueError("Duplicate budget attempt")
            self.state["reservations"][identity] = str(amount)
            self.save()
        return amount

    def settle(self, identity, usage):
        with self.lock:
            raw = usage.get("cost")
            if raw is None or not Decimal(str(raw)).is_finite() or Decimal(str(raw)) < 0:
                self.state["blocked"] = "Missing or invalid billed cost"
                self.save()
                raise ValueError(self.state["blocked"])
            cost = Decimal(str(raw))
            reserved = Decimal(self.state["reservations"][identity])
            if cost > reserved:
                self.state["blocked"] = "Billed cost exceeded conservative reservation"
            del self.state["reservations"][identity]
            self.state["charges"][identity] = str(cost)
            self.state["spent"] = str(Decimal(self.state["spent"]) + cost)
            if Decimal(self.state["spent"]) > 3 and self.state["over_3"] is None:
                self.state["over_3"] = {"time": time.time(), "spent": self.state["spent"]}
            self.save()
            if self.state.get("blocked"):
                raise ValueError(self.state["blocked"])
