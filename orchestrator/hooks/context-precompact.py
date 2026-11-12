#!/usr/bin/env python3
"""PreCompact hook: preserve the session's worked task list without blocking compaction."""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from registered_scope import should_hook_act

CLI_TIMEOUT_SECONDS = 5


def bottega_bin():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    return os.path.join(root, "bin", "bottega")


def first_line(value):
    for line in (value or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def not_recorded(reason):
    return f"context: worked list not recorded: {reason}"


def record_worked(payload):
    if not isinstance(payload, dict):
        return not_recorded("hook input is not an object")
    session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
    cwd = payload.get("cwd")
    if not isinstance(session, str) or not session:
        return not_recorded("session_id is missing")
    if not isinstance(cwd, str) or not cwd:
        return not_recorded("cwd is missing")
    child_env = os.environ.copy()
    child_env["CLAUDE_CODE_SESSION_ID"] = session
    try:
        result = subprocess.run(
            [bottega_bin(), "agent", "context", "worked", "--session", session],
            cwd=cwd,
            env=child_env,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return not_recorded("timeout")
    except OSError as error:
        return not_recorded(str(error))
    if result.returncode != 0:
        detail = first_line(result.stderr) or first_line(result.stdout)
        suffix = f": {detail}" if detail else ""
        return not_recorded(f"exit {result.returncode}{suffix}")
    return (result.stdout or "").strip() or not_recorded("verb returned no output")


def main():
    try:
        payload = json.load(sys.stdin)
        if not should_hook_act(payload):
            return 0
        output = record_worked(payload)
    except Exception as error:
        output = not_recorded(str(error))
    sys.stdout.write(output + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
