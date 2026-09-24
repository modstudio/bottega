#!/usr/bin/env python3
"""PreToolUse hook: refuse a commit or pull request that credits an AI.

Attribution trailers ("Co-Authored-By: Claude", "Generated with Claude Code",
session links) are house-banned, and a harness that appends them by default
will keep trying. This runs before every Bash tool call, finds the ones that
write a commit message or a PR body, and denies any whose text carries a
marker. It also reads a message file passed with -F/--file/--body-file, since
that is where a long message usually lives.
"""
import json
import os
import re
import sys
from pathlib import Path

MARKER_FILE = Path(__file__).resolve().parents[2] / "shared" / "attribution-markers.json"
with MARKER_FILE.open(encoding="utf-8") as marker_file:
    MARKERS = re.compile("|".join(json.load(marker_file)), re.IGNORECASE)
WRITES = re.compile(
    r"\bgit\s+(commit|merge|tag|rebase|cherry-pick|notes)\b"
    r"|\bgh\s+pr\s+(create|edit|merge)\b"
    r"|\bgh\s+release\s+(create|edit)\b",
)
FILE_FLAG = re.compile(r"(?:-F|--file|--body-file|--notes-file|--message-file)[= ]+(\S+)")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    command = str(payload.get("tool_input", {}).get("command", ""))
    if not WRITES.search(command):
        return 0
    text = command
    cwd = payload.get("cwd") or os.getcwd()
    for match in FILE_FLAG.finditer(command):
        path = match.group(1).strip("'\"")
        try:
            with open(os.path.join(cwd, os.path.expanduser(path)), encoding="utf-8", errors="replace") as fh:
                text += "\n" + fh.read()
        except OSError:
            pass
    hit = MARKERS.search(text)
    if not hit:
        return 0
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "AI attribution is not allowed in commits or pull requests "
                f"(matched: {hit.group(0)!r}). Remove the trailer and retry."
            ),
        }
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
