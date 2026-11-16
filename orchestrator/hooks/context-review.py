#!/usr/bin/env python3
"""Fail-silent PostToolUse injection of a due timed context review."""

import json
import os
import subprocess
import sys
import time
from datetime import datetime

from board_hook_common import marker_path, read_marker, write_marker
from hook_emission import record_emission
from hook_paths import bottega_bin
from registered_scope import should_hook_act
from registered_scope import orch_worker_session


def parsed_next_due(marker):
    if not isinstance(marker, dict):
        return None
    value = marker.get("next_due_at")
    return float(value) if isinstance(value, (int, float)) else None


def iso_seconds(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def write_backoff(path, now):
    minimum_seconds = float(os.environ["CONTEXT_REVIEW_MIN_MS"]) / 1000
    write_marker(path, {"next_due_at": now + minimum_seconds})


def main():
    try:
        payload = json.load(sys.stdin)
        if not should_hook_act(payload) or orch_worker_session():
            return 0
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not isinstance(session, str) or not session:
            return 0
        path = marker_path("context-review", session)
        now = time.time()
        next_due = parsed_next_due(read_marker(path))
        if next_due is not None and now < next_due:
            return 0
        try:
            result = subprocess.run(
                [bottega_bin(), "agent", "context", "review", "--session", session, "--json"],
                capture_output=True,
                text=True,
                timeout=float(os.environ["CONTEXT_REVIEW_HOOK_TIMEOUT_SECONDS"]),
                check=True,
            )
            review = json.loads(result.stdout)
            next_due_at = review.get("next_due_at")
            if not isinstance(next_due_at, str):
                raise ValueError("context review response has no next_due_at")
            write_marker(path, {"next_due_at": iso_seconds(next_due_at)})
        except Exception:
            write_backoff(path, now)
            return 0
        context = review.get("review")
        if review.get("due") is not True or not isinstance(context, str) or not context:
            return 0
        record_emission(payload, "additionalContext", context)
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PostToolUse",
                "additionalContext": context,
            }
        }) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
