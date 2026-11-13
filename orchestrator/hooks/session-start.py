#!/usr/bin/env python3
"""SessionStart hook: open or reuse the session's explore workflow, never blocking."""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(__file__))
from hook_paths import bottega_bin
from registered_scope import should_hook_act

CLI_TIMEOUT_SECONDS = 10
PLATFORM_SLUG = os.path.basename(bottega_bin())


def emit(text):
    text = " ".join(text.split())
    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": text,
                }
            }
        )
        + "\n"
    )


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or not should_hook_act(payload):
            return 0
        if os.environ.get("BOTTEGA_RUN_ID"):
            return 0
        cwd = payload.get("cwd")
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not isinstance(cwd, str) or not cwd:
            emit(
                "session start could not establish the hook cwd; cleared by: "
                "start the session in a registered checkout"
            )
            return 0
        if not isinstance(session, str) or not session:
            emit(
                "session start could not establish the current harness session id; cleared by: "
                "start a new supported harness session"
            )
            return 0
        environment = os.environ.copy()
        environment["CLAUDE_CODE_SESSION_ID"] = session
        result = subprocess.run(
            [bottega_bin(), "session", "start"],
            cwd=cwd,
            env=environment,
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_SECONDS,
            check=False,
        )
        line = (result.stdout or "").strip()
        if not line:
            condition = (result.stderr or "").strip() or f"command exited {result.returncode}"
            line = (
                f"session start could not establish an explore cursor: {condition}; cleared by: "
                f"clear the reported condition and run {PLATFORM_SLUG} session start again"
            )
        emit(line)
    except Exception as error:
        emit(
            f"session start could not establish an explore cursor: {error}; cleared by: "
            f"clear the reported condition and run {PLATFORM_SLUG} session start again"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
