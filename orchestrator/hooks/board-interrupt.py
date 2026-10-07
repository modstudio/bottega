#!/usr/bin/env python3
"""PostToolUse hook: inject due acknowledgement-required board notices."""
from __future__ import annotations

import json
import calendar
import os
import sqlite3
import subprocess
import sys
import time


def store_path() -> str:
    return os.path.abspath(os.environ["ORCH_DB"])


def might_have_pending(session: str, refresh_seconds: int) -> bool:
    path = store_path()
    if not os.path.exists(path):
        return False
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.05)
    try:
        local = connection.execute(
            """SELECT 1 FROM board_message m
               WHERE m.kind='notice' AND m.ack_required=1 AND m.withdrawn_at IS NULL
                 AND julianday(m.expires_at)>julianday('now') AND (m.author_session IS NULL OR m.author_session<>?)
                 AND NOT EXISTS (SELECT 1 FROM board_receipt r WHERE r.message_id=m.id
                   AND r.reader_session=? AND r.acknowledged_at IS NOT NULL) LIMIT 1""",
            (session, session),
        ).fetchone()
        hosted = connection.execute(
            """SELECT 1 FROM hosted_board_message_cache m
               WHERE m.kind='notice' AND json_extract(m.payload,'$.ackRequired')=1
                 AND json_extract(m.payload,'$.withdrawnAt') IS NULL
                 AND julianday(json_extract(m.payload,'$.expiresAt'))>julianday('now')
                 AND (json_extract(m.payload,'$.authorSession') IS NULL OR json_extract(m.payload,'$.authorSession')<>?)
                 AND NOT EXISTS (SELECT 1 FROM hosted_board_receipt_cache r WHERE r.message_id=m.id
                   AND r.reader_session=? AND r.acknowledged_at IS NOT NULL) LIMIT 1""",
            (session, session),
        ).fetchone()
        row = connection.execute(
            "SELECT value FROM schema_meta WHERE key='board_hosted_refresh_at'"
        ).fetchone()
        refreshed = 0.0 if not row else calendar.timegm(time.strptime(str(row[0])[:19], "%Y-%m-%dT%H:%M:%S"))
        return bool(local or hosted or time.time() - refreshed >= refresh_seconds)
    finally:
        connection.close()


def pending(session: str, all_notices: bool = False):
    binary = os.environ.get("ORCH_BOARD_BIN") or os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))
    command = [binary, "board", "pending", "--session", session, "--json"]
    if all_notices:
        command.append("--all")
    timeout = float(os.environ["BOARD_PUSH_SLOW_TIMEOUT_SECONDS"])
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=True)
    value = json.loads(result.stdout)
    notices = value.get("notices")
    if not isinstance(notices, list) or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str) for item in notices):
        raise ValueError("malformed board pending output")
    return notices


def main() -> int:
    try:
        if os.environ.get("ORCH_RUN_ID"):
            return 0
        payload = json.load(sys.stdin)
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        refresh = int(os.environ["BOARD_PUSH_REFRESH_SECONDS"])
        if not isinstance(session, str) or not session or not might_have_pending(session, refresh):
            return 0
        notices = pending(session)
        if notices:
            sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "\n\n".join(item["text"] for item in notices)}}) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
