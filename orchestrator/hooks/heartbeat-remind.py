#!/usr/bin/env python3
"""PostToolUse hook: detached work without a watcher disappears from view.

`bottega run start` returns before its worker does. Unless the session arms the heartbeat
under Monitor, waiting work and a worker asking for a ruling look exactly like
an abandoned session to the operator. Dispatch creates that obligation, so this
hook puts the runnable command back in the model's context at that moment.
"""
from __future__ import annotations  # bool | None must parse on macOS system python 3.9

import json
import os
import shlex
import subprocess
import sys

PROCESS_LIST_PS_TIMEOUT_SECONDS = 2

DETACHED_DISPATCHES = {
    ("bottega", "run", "start"): ("run start", 3),
    ("orch", "do"): ("do", 2),
}


def heartbeat_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "orch-heartbeat.sh"))


def heartbeat_armed(session_id: str) -> bool | None:
    process_list = os.environ.get("ORCH_HEARTBEAT_PROCESS_LIST")
    if process_list is None:
        try:
            observed = subprocess.run(
                ["ps", "-axo", "pid=,args="],
                capture_output=True,
                text=True,
                timeout=PROCESS_LIST_PS_TIMEOUT_SECONDS,
                check=True,
            )
            process_list = observed.stdout
        except Exception:
            return None
    for line in process_list.splitlines():
        try:
            _, command = line.strip().split(None, 1)
            words = shlex.split(command)
        except (ValueError, IndexError):
            continue
        for index, word in enumerate(words[:-1]):
            if os.path.basename(word) == "orch-heartbeat.sh" and words[index + 1] == session_id:
                return True
    return False


def detached_dispatch(command: object):
    """Return the detached dispatch spelling, or None for a blocking command."""
    if not isinstance(command, str):
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        words = list(lexer)
    except ValueError:
        return None
    for index, word in enumerate(words):
        executable = os.path.basename(word)
        match = next(
            (
                value
                for prefix, value in DETACHED_DISPATCHES.items()
                if executable == prefix[0]
                and tuple(words[index + 1 : index + len(prefix)]) == prefix[1:]
            ),
            None,
        )
        if match is None:
            continue
        kind, width = match
        args = []
        for arg in words[index + width :]:
            if arg in (";", "&", "|", "&&", "||"):
                break
            args.append(arg)
        return kind if "--follow" not in args else None
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        command = payload.get("tool_input", {}).get("command")
        kind = detached_dispatch(command)
        if not isinstance(sid, str) or not sid or kind is None:
            return 0
        armed = heartbeat_armed(sid)
        if armed is not False:
            return 0
        arm = f"{heartbeat_path()} {sid}"
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": f"Arm under Monitor from the main checkout: {arm}",
            }
        }) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
