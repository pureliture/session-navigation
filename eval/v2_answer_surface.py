"""Supplement final-message scoring with user-visible answers before cleanup."""
import collections
import gzip
import json
from pathlib import Path
import sys

from analyze import text


def unit_answer(turn):
    messages = turn.get("messages", [])
    starts = [index for index, message in enumerate(messages)
              if message.get("role") == "user" and turn["prompt"] in text(message.get("content"))]
    if not starts:
        return turn.get("answer", ""), False
    return "\n".join(text(message.get("content")) for message in messages[starts[-1] + 1:]
                     if message.get("role") == "assistant"), True


def score_surfaces(directory):
    from v2_analyze import match_fact

    directory = Path(directory)
    groups, sessions = {}, []
    for report in json.loads((directory / "metrics-v2.json").read_text()):
        path = directory / report["id"] / "turns.json.gz"
        if not path.exists():
            continue
        turns = json.load(gzip.open(path, "rt"))
        checks = []
        for original in report["answer_checks"]:
            index = original["turn"] - 1
            answer, captured = unit_answer(turns[index]) if index < len(turns) else ("", False)
            checks.append({"turn": original["turn"], "captured_user_boundary": captured,
                           "matched": [match_fact(answer, fact) for fact in original["facts"]]})
        success = len(turns) == report["user_turns"] and all(all(row["matched"]) for row in checks)
        row = {"id": report["id"], "final_message_success": report["task_success"],
               "visible_unit_success": success, "checks": checks}
        sessions.append(row)
        key = report["host"] + "/" + report["arm"]
        group = groups.setdefault(key, collections.Counter())
        group["sessions"] += 1
        group["final_message_success"] += report["task_success"]
        group["visible_unit_success"] += success
        group["missing_user_boundaries"] += sum(not check["captured_user_boundary"] for check in checks)
    result = {"groups": {key: dict(value) for key, value in groups.items()}, "sessions": sessions}
    (directory / "answer-surface.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result["groups"], indent=2))
    return result


if __name__ == "__main__":
    score_surfaces(Path(sys.argv[1]))
