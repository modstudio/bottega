#!/usr/bin/env python3
"""Stop hook: hold an architect turn briefly for pending board acknowledgements."""
from __future__ import annotations

import json
import os
import sys

from board_hook_common import (
    marker_path,
    pending,
    read_marker,
    store_path,
    write_marker,
)


def block_count(session: str) -> tuple[str, int | None]:
    """The session's spent Stop blocks, or None when the marker cannot be read."""
    path = marker_path("stop", session)
    value = read_marker(path)
    if not isinstance(value, dict):
        return path, None
    count = value.get("blocks", 0)
    if not isinstance(count, int) or count < 0:
        count = 0
    return path, count


def notice_summary(notices, stopping: bool = False) -> str:
    count = len(notices)
    state = "is stopping with" if stopping else "has"
    noun = "notice" if count == 1 else "notices"
    commands = "\n".join(f"orch board ack {item['id']}" for item in notices)
    lead = (
        f"This architect session {state} {count} unacknowledged board {noun}. "
        "Acknowledge with:\n"
        f"{commands}"
    )
    return lead + "\n\n" + "\n\n".join(item["text"] for item in notices)


def main() -> int:
    try:
        if os.environ.get("ORCH_RUN_ID"):
            return 0
        payload = json.load(sys.stdin)
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if (
            not isinstance(session, str)
            or not session
            or not os.path.exists(store_path())
        ):
            return 0
        _delivery, _overflow, notices = pending(session)
        path, count = block_count(session)
        if not notices:
            write_marker(path, {"blocks": 0})
            return 0
        limit = int(os.environ["BOARD_ACK_STOP_BLOCKS"])
        # A block is spent only once it is recorded: a marker that cannot be
        # read or written would otherwise hold the turn without ever counting.
        if count is None:
            return 0
        if count < limit:
            if not write_marker(path, {"blocks": count + 1}):
                return 0
            value = {
                "decision": "block",
                "reason": notice_summary(notices),
            }
            sys.stdout.write(json.dumps(value) + "\n")
        else:
            value = {"systemMessage": notice_summary(notices, True)}
            sys.stdout.write(json.dumps(value) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
