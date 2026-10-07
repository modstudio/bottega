#!/usr/bin/env python3
"""Stop hook: hold an architect turn briefly for pending board acknowledgements."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from importlib.machinery import SourceFileLoader

interrupt = SourceFileLoader("board_interrupt", os.path.join(os.path.dirname(__file__), "board-interrupt.py")).load_module()


def observation_count(session: str, notice_id: str) -> int | None:
    root = os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(), "orch-board-ack-guard")
    key = f"{session}:{notice_id}"
    path = os.path.join(root, hashlib.sha256(key.encode()).hexdigest())
    try:
        os.makedirs(root, mode=0o700, exist_ok=True)
        count = 0
        if os.path.exists(path):
            with open(path, encoding="utf-8") as handle:
                count = int(handle.read())
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(str(count + 1))
        return count + 1
    except Exception:
        return None


def main() -> int:
    try:
        if os.environ.get("ORCH_RUN_ID"):
            return 0
        payload = json.load(sys.stdin)
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not isinstance(session, str) or not session or not os.path.exists(interrupt.store_path()):
            return 0
        notices = interrupt.pending(session, True)
        if not notices:
            return 0
        limit = int(os.environ["BOARD_ACK_STOP_BLOCKS"])
        counts = [observation_count(session, item["id"]) for item in notices]
        if any(count is None for count in counts):
            return 0
        blocking = [item for item, count in zip(notices, counts) if count <= limit]
        exhausted = [item for item, count in zip(notices, counts) if count > limit]
        if blocking:
            value = {"decision": "block", "reason": "\n\n".join(item["text"] for item in blocking)}
            if exhausted:
                value["systemMessage"] = "\n\n".join(item["text"] for item in exhausted)
            sys.stdout.write(json.dumps(value) + "\n")
        else:
            sys.stdout.write(json.dumps({"systemMessage": "\n\n".join(item["text"] for item in exhausted)}) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
