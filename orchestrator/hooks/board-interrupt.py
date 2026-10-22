#!/usr/bin/env python3
"""PostToolUse hook: inject due board delivery without changing Stop policy."""
from __future__ import annotations

import calendar
import json
import os
import sqlite3
import subprocess
import sys
import time

from board_hook_common import (
    board_bin,
    marker_path,
    mark_delivered,
    new_emission_id,
    pending,
    read_marker,
    store_path,
    write_marker,
)

BOARD_PRESENCE_CALL_TIMEOUT_SECONDS = 1


def presence_missing(session: str) -> bool:
    path = store_path()
    if not os.path.exists(path):
        return False
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.05)
        try:
            row = connection.execute(
                "SELECT 1 FROM presence WHERE session_id=? LIMIT 1",
                (session,),
            ).fetchone()
            return row is None
        finally:
            connection.close()
    except Exception:
        return False


def refresh_presence(session: str, now: float, interval: float) -> None:
    if not presence_missing(session):
        return
    path = marker_path("presence", session)
    marker = read_marker(path)
    last = 0.0
    if isinstance(marker, dict):
        ran_at = marker.get("ran_at", 0)
        if isinstance(ran_at, (int, float)):
            last = float(ran_at)
    if now - last < interval:
        return
    write_marker(path, {"ran_at": now})
    try:
        subprocess.run(
            [board_bin(), "board", "presence"],
            capture_output=True,
            timeout=BOARD_PRESENCE_CALL_TIMEOUT_SECONDS,
            check=False,
            env={**os.environ, "CLAUDE_CODE_SESSION_ID": session},
        )
    except Exception:
        pass


def cheap_state(session: str, refresh_seconds: int) -> tuple[set[str], bool]:
    """Broad prefilter for board-push-service.ts, the eligibility owner.

    This may accept a notice that the TypeScript recipients logic rejects, but
    must never reject one that the owner accepts.
    """
    path = store_path()
    if not os.path.exists(path):
        return set(), False
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=0.05)
    try:
        local = connection.execute(
            """SELECT CAST(m.number AS TEXT) FROM board_message m
               WHERE m.withdrawn_at IS NULL
                 AND (m.kind='reply' OR julianday(m.expires_at)>julianday('now'))
                 AND (m.author_session IS NULL OR m.author_session<>?)
                 AND (NOT EXISTS (SELECT 1 FROM board_receipt r WHERE r.message_record_id=m.record_id
                   AND r.reader_session=? AND r.delivered_at IS NOT NULL)
                   OR (m.kind='notice' AND m.ack_required=1 AND NOT EXISTS
                     (SELECT 1 FROM board_receipt r WHERE r.message_record_id=m.record_id
                      AND r.reader_session=? AND r.acknowledged_at IS NOT NULL)))""",
            (session, session, session),
        ).fetchall()
        hosted = connection.execute(
            """SELECT m.id FROM hosted_board_message_cache m
               WHERE json_extract(m.payload,'$.withdrawnAt') IS NULL
                 AND (m.kind='reply' OR julianday(json_extract(m.payload,'$.expiresAt'))>julianday('now'))
                 AND (json_extract(m.payload,'$.authorSession') IS NULL
                      OR json_extract(m.payload,'$.authorSession')<>?)
                 AND (NOT EXISTS (SELECT 1 FROM hosted_board_receipt_cache r
                   WHERE r.message_id=m.id AND r.reader_session=? AND r.delivered_at IS NOT NULL)
                   OR (m.kind='notice' AND json_extract(m.payload,'$.ackRequired')=1
                     AND NOT EXISTS (SELECT 1 FROM hosted_board_receipt_cache r
                       WHERE r.message_id=m.id AND r.reader_session=?
                         AND r.acknowledged_at IS NOT NULL)))""",
            (session, session, session),
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


def parse_marker(value):
    if value is None:
        return None
    ids = value.get("candidate_ids", [])
    ran_at = value.get("ran_at", 0)
    failure_at = value.get("failure_at", 0)
    injected_at = value.get("injected_at", {})
    valid_ids = isinstance(ids, list) and all(isinstance(item, str) for item in ids)
    valid_times = isinstance(ran_at, (int, float)) and isinstance(
        failure_at, (int, float)
    )
    valid_injected = isinstance(injected_at, dict) and all(
        isinstance(key, str) and isinstance(at, (int, float))
        for key, at in injected_at.items()
    )
    if not valid_ids or not valid_times or not valid_injected:
        return None
    return {
        "candidate_ids": set(ids),
        "ran_at": float(ran_at),
        "failure_at": float(failure_at),
        "injected_at": {key: float(at) for key, at in injected_at.items()},
    }


def should_run_slow_path(
    candidates: set[str],
    hosted_stale: bool,
    marker,
    refresh_seconds: int,
    remind_seconds: int,
    retry_seconds: int,
    now: float,
) -> bool:
    if marker is None:
        return True
    if marker["failure_at"] and now - marker["failure_at"] < retry_seconds:
        return False
    previous = marker["candidate_ids"]
    ran_at = marker["ran_at"]
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
        retry = int(os.environ["BOARD_PUSH_RETRY_SECONDS"])
        presence_refresh = int(os.environ["BOARD_PRESENCE_REFRESH_SECONDS"])
        if not isinstance(session, str) or not session:
            return 0
        now = time.time()
        refresh_presence(session, now, presence_refresh)
        candidates, hosted_stale = cheap_state(session, refresh)
        path = marker_path("interrupt", session)
        marker = parse_marker(read_marker(path))
        if not should_run_slow_path(
            candidates,
            hosted_stale,
            marker,
            refresh,
            remind,
            retry,
            now,
        ):
            return 0
        injected_at = {} if marker is None else marker["injected_at"]
        recently_injected = sorted(
            message_id
            for message_id, injected in injected_at.items()
            if now - injected < remind
        )
        try:
            notices, overflow, _pending_acknowledgements = pending(
                session, recently_injected
            )
        except Exception:
            previous = marker or {
                "candidate_ids": set(),
                "ran_at": 0,
                "injected_at": {},
            }
            write_marker(
                path,
                {
                    "candidate_ids": sorted(previous["candidate_ids"]),
                    "ran_at": previous["ran_at"],
                    "failure_at": now,
                    "injected_at": previous["injected_at"],
                },
            )
            return 0
        if notices:
            context = "\n\n".join(item["text"] for item in notices)
            if overflow:
                context += "\n\n" + overflow
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": context,
                }
            }
            sys.stdout.write(json.dumps(output) + "\n")
            sys.stdout.flush()
            mark_delivered(
                session, [item["id"] for item in notices], "after-tool-call",
                new_emission_id()
            )
            for notice in notices:
                injected_at[notice["id"]] = now
        recorded_candidates = candidates
        if overflow:
            recorded_candidates = candidates.intersection(
                item["id"] for item in notices
            )
        write_marker(
            path,
            {
                "candidate_ids": sorted(recorded_candidates),
                "ran_at": now,
                "failure_at": 0,
                "injected_at": injected_at,
            },
        )
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
