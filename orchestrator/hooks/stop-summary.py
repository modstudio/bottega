#!/usr/bin/env python3
"""Stop hook: close terminal trees, then print one bounded session summary."""
import json
import os
import sqlite3
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from board_hook_common import marker_path, read_marker, write_marker
from hook_paths import bottega_bin
from registered_scope import should_hook_act

GLOBAL_BUDGET_SECONDS = 20


def session_ids(payload):
    return list(dict.fromkeys(filter(None, [
        payload.get("session_id"), os.environ.get("CLAUDE_CODE_SESSION_ID")
    ])))


def cleanup(ids, deadline):
    database = os.environ.get("BOTTEGA_ORCHESTRATOR_DB")
    if not database or not os.path.exists(database) or not ids:
        return
    try:
        con = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
        roots = con.execute(
            """SELECT MIN(number) FROM run WHERE session_id IN ({})
                 -- Restates TERMINAL_RUN_STATUSES from orchestrator/src/run/run-status.ts.
                 AND worktree IS NOT NULL AND status IN ('ok','failed','stale','stopped')
               GROUP BY worktree ORDER BY 1""".format(",".join("?" for _ in ids)), ids
        ).fetchall()
        con.close()
    except sqlite3.Error:
        return
    deferred = []
    for index, (root,) in enumerate(roots):
        remaining = max(0, deadline - time.monotonic())
        if remaining <= 0:
            deferred.extend(value for (value,) in roots[index:])
            break
        try:
            result = subprocess.run(
                [bottega_bin(), "run", "close-out", str(root), "--non-blocking", "--json"],
                capture_output=True, text=True, timeout=remaining,
            )
            report = json.loads((result.stdout or result.stderr).strip())
            if report.get("outcome") not in ("released", "absent", "held", "kept"):
                deferred.append(root)
        except Exception:
            deferred.append(root)
    if deferred:
        print(
            "bottega: Stop cleanup left run(s) {} for sweep".format(
                ", ".join(str(value) for value in dict.fromkeys(deferred))
            ), file=sys.stderr,
        )


def summary(payload, ids, deadline):
    sid = ids[0]
    path = marker_path("stop-summary", sid)
    marker = read_marker(path) if path else None
    prior = marker.get("blockKey") if isinstance(marker, dict) else None
    command = [
        bottega_bin(), "session", "status", "--stop", "--json",
        "--session", sid,
    ]
    if isinstance(prior, str):
        command.extend(["--block-key", prior])
    remaining = max(0, deadline - time.monotonic())
    if remaining <= 0:
        raise subprocess.TimeoutExpired("session status", 0)
    result = subprocess.run(
        command,
        cwd=payload.get("cwd") or None, capture_output=True, text=True,
        timeout=remaining, check=True,
    )
    report = json.loads(result.stdout)
    if not isinstance(report.get("lines"), list) or not isinstance(report.get("block"), bool):
        raise ValueError("malformed session status output")
    if report["block"]:
        reason = report.get("reason")
        if not isinstance(reason, str):
            raise ValueError("blocking session status has no reason")
        key = report.get("blockKey")
        if not isinstance(key, str):
            raise ValueError("blocking session status has no block key")
        if not write_marker(path, {"blockKey": key}):
            print("bottega: block-once marker could not be recorded; Stop proceeded", file=sys.stderr)
            return {"systemMessage": "\n".join(report["lines"])}
        return {"decision": "block", "reason": reason}
    return {"systemMessage": "\n".join(report["lines"])}


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("hook payload is not an object")
    except Exception as error:
        print(f"bottega: hook payload could not be parsed ({error.__class__.__name__}: {error})", file=sys.stderr)
        return 0
    if not should_hook_act(payload) or payload.get("stop_hook_active"):
        return 0
    ids = session_ids(payload)
    if not ids:
        return 0
    deadline = time.monotonic() + GLOBAL_BUDGET_SECONDS
    cleanup(ids, deadline)
    try:
        print(json.dumps(summary(payload, ids, deadline)))
    except Exception as error:
        print(json.dumps({"systemMessage": f"Session status unavailable; Stop proceeded ({error.__class__.__name__})."}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
