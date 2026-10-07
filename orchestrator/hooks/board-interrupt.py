#!/usr/bin/env python3
"""PostToolUse hook: inject due acknowledgement-required board notices."""
from __future__ import annotations

import calendar
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time

from board_hook_common import pending, store_path


def cheap_state(session: str, refresh_seconds: int) -> tuple[set[str], bool]:
    """Return possible notice ids and whether the hosted cache needs refreshing."""
    path = store_path()
    if not os.path.exists(path):
        return set(), False
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.05)
    try:
        local = connection.execute(
            """SELECT CAST(m.id AS TEXT) FROM board_message m
               WHERE m.kind='notice' AND m.ack_required=1 AND m.withdrawn_at IS NULL
                 AND julianday(m.expires_at)>julianday('now')
                 AND (m.author_session IS NULL OR m.author_session<>?)
                 AND NOT EXISTS (SELECT 1 FROM board_receipt r WHERE r.message_id=m.id
                   AND r.reader_session=? AND r.acknowledged_at IS NOT NULL)""",
            (session, session),
        ).fetchall()
        hosted = connection.execute(
            """SELECT m.id FROM hosted_board_message_cache m
               WHERE m.kind='notice' AND json_extract(m.payload,'$.ackRequired')=1
                 AND json_extract(m.payload,'$.withdrawnAt') IS NULL
                 AND julianday(json_extract(m.payload,'$.expiresAt'))>julianday('now')
                 AND (json_extract(m.payload,'$.authorSession') IS NULL
                      OR json_extract(m.payload,'$.authorSession')<>?)
                 AND NOT EXISTS (SELECT 1 FROM hosted_board_receipt_cache r
                   WHERE r.message_id=m.id AND r.reader_session=?
                     AND r.acknowledged_at IS NOT NULL)""",
            (session, session),
        ).fetchall()
        row = connection.execute(
            "SELECT value FROM schema_meta WHERE key='board_hosted_refresh_at'"
        ).fetchone()
        refreshed = 0.0
        if row:
            refreshed = calendar.timegm(
                time.strptime(str(row[0])[:19], "%Y-%m-%dT%H:%M:%S")
            )
        candidates = {str(item[0]) for item in [*local, *hosted]}
        return candidates, time.time() - refreshed >= refresh_seconds
    finally:
        connection.close()


def marker_path(session: str) -> str:
    root = os.path.join(
        os.environ.get("TMPDIR") or tempfile.gettempdir(),
        "orch-board-interrupt",
    )
    name = hashlib.sha256(session.encode()).hexdigest()
    return os.path.join(root, name)


def read_marker(session: str) -> tuple[set[str], float] | None:
    path = marker_path(session)
    if not os.path.exists(path):
        return set(), 0.0
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
        ids = value.get("candidate_ids")
        ran_at = value.get("ran_at")
        if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
            return None
        if not isinstance(ran_at, (int, float)):
            return None
        return set(ids), float(ran_at)
    except Exception:
        return None


def write_marker(session: str, candidates: set[str], ran_at: float) -> bool:
    path = marker_path(session)
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"candidate_ids": sorted(candidates), "ran_at": ran_at}, handle)
        return True
    except Exception:
        return False


def should_run_slow_path(
    candidates: set[str],
    hosted_stale: bool,
    marker: tuple[set[str], float] | None,
    refresh_seconds: int,
    remind_seconds: int,
    now: float,
) -> bool:
    if marker is None:
        return True
    previous, ran_at = marker
    return bool(
        candidates - previous
        or (candidates and now - ran_at >= remind_seconds)
        or (hosted_stale and now - ran_at >= refresh_seconds)
    )


def main() -> int:
    try:
        if os.environ.get("ORCH_RUN_ID"):
            return 0
        payload = json.load(sys.stdin)
        session = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        refresh = int(os.environ["BOARD_PUSH_REFRESH_SECONDS"])
        remind = int(os.environ["BOARD_PUSH_REMIND_SECONDS"])
        if not isinstance(session, str) or not session:
            return 0
        candidates, hosted_stale = cheap_state(session, refresh)
        marker = read_marker(session)
        now = time.time()
        if not should_run_slow_path(
            candidates,
            hosted_stale,
            marker,
            refresh,
            remind,
            now,
        ):
            return 0
        try:
            notices = pending(session)
        finally:
            write_marker(session, candidates, now)
        if notices:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": "\n\n".join(item["text"] for item in notices),
                }
            }
            sys.stdout.write(json.dumps(output) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
