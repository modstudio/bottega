#!/usr/bin/env python3
"""Stop hook: live detached work must not silently lose its watcher.

A session can finish its turn while its workers are still running or waiting on
a ruling, leaving the operator unable to distinguish progress from abandonment.
The first stop is held long enough to arm Monitor. A dead worker can remain
recorded live forever, so the same observed run set is never allowed to wedge a
session on every later stop.
"""
from __future__ import annotations  # bool | None must parse on macOS system python 3.9

import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import tempfile


def heartbeat_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "orch-heartbeat.sh"))


def orch_path() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "bin", "orch"))


def heartbeat_armed(session_id: str) -> bool | None:
    process_list = os.environ.get("ORCH_HEARTBEAT_PROCESS_LIST")
    if process_list is None:
        try:
            observed = subprocess.run(
                ["ps", "-axo", "pid=,args="],
                capture_output=True,
                text=True,
                timeout=2,
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


def landing_db_path() -> str:
    return os.environ.get("ORCH_DB") or os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "orch.db")
    )


def live_landing_ids(session_id: str):
    """Landings this session has queued or running, [] if none, None if unknowable.

    A landing is NOT a run and has no row in the run table, so a session whose
    only work is a landing reads as idle to a runs-only check -- and the
    heartbeat then reports CLEAR, which is a positive claim of quiescence over
    a live ten-minute gate rather than merely a missing one. That false
    all-clear is the exact outcome orch-heartbeat.sh's own header warns about,
    reached by a route it did not anticipate.

    Absent store and unreadable store are deliberately different answers. No
    database means landings are not a concept in reach here (a session in
    another project, a fixture), so there is nothing to report. A database that
    exists but will not answer is genuine uncertainty, and the caller treats
    that as live: being wrong toward "work exists" costs one blocked stop that
    the one-shot guard already releases, while being wrong toward "clear"
    reproduces the failure this function exists to close.
    """
    path = landing_db_path()
    if not os.path.exists(path):
        return []
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)
        try:
            rows = connection.execute(
                "SELECT id FROM landing WHERE session_id = ? AND status IN ('queued','running')",
                (session_id,),
            ).fetchall()
        finally:
            connection.close()
        return sorted({int(row[0]) for row in rows})
    except Exception:
        return None


def live_run_ids(session_id: str):
    try:
        result = subprocess.run(
            [orch_path(), "runs", "--limit", "200", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        ids = []
        for raw in result.stdout.splitlines():
            if not raw.strip():
                continue
            row = json.loads(raw)
            if not isinstance(row, dict):
                raise ValueError("run is not an object")
            data = row.get("data") if "schema_version" in row else row
            if not isinstance(data, dict):
                raise ValueError("run data is not an object")
            if data.get("session_id") == session_id and data.get("status") in ("running", "asking"):
                run_id = data.get("id")
                if not isinstance(run_id, int):
                    raise ValueError("live run has no integer id")
                ids.append(run_id)
        return sorted(set(ids))
    except Exception:
        return None


def first_observation(session_id: str, run_ids) -> bool:
    key = json.dumps([session_id, run_ids], separators=(",", ":"))
    name = hashlib.sha256(key.encode()).hexdigest()
    root = os.path.join(os.environ.get("TMPDIR") or tempfile.gettempdir(), "orch-heartbeat-guard")
    try:
        os.makedirs(root, mode=0o700, exist_ok=True)
        marker = os.path.join(root, name)
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(key + "\n")
        return True
    except FileExistsError:
        return False
    except Exception:
        # State is part of the safety mechanism. If it cannot be recorded, a
        # block could repeat forever, so fail open rather than risk a wedge.
        return False


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        sid = payload.get("session_id") or os.environ.get("CLAUDE_CODE_SESSION_ID")
        if not isinstance(sid, str) or not sid:
            return 0
        run_ids = live_run_ids(sid) or []
        landing_ids = live_landing_ids(sid)
        # None from the landing query is uncertainty, not absence: count it as
        # live so an unreadable store cannot be reported as quiescence.
        landings = ["unknown"] if landing_ids is None else [str(i) for i in landing_ids]
        if not run_ids and not landings:
            return 0

        arm = f"{heartbeat_path()} {sid}"

        # Only RUNS are demandable. orch-heartbeat.sh computes its state from the
        # run table alone, so against a landing-only session it finds nothing to
        # watch and exits immediately -- arming it cannot satisfy a block, and
        # demanding one asks for something no available watcher provides. Report
        # the landings instead: the operator learns work is live and unwatched,
        # which is the whole point, without being handed an instruction that
        # cannot be carried out. Runs keep the block, because for those the
        # heartbeat does work and staying armed is achievable.
        if not run_ids:
            count = len(landings)
            sys.stdout.write(json.dumps({"systemMessage": (
                f"{count} live landing{'s' if count != 1 else ''} for this session"
                f"{'' if landing_ids is not None else ' (landing store unreadable; assuming live)'}"
                ". No watcher covers landings -- orch-heartbeat.sh reads the run table only, so"
                " arming it against a landing-only session exits at once. Track it with"
                " `orch land --status` from the project root."
            )}) + "\n")
            return 0

        armed = heartbeat_armed(sid)
        if armed is not False:
            return 0
        count = len(run_ids)
        trailer = (
            f" {len(landings)} landing{'s' if len(landings) != 1 else ''} are also live and"
            " unwatched by any heartbeat." if landings else ""
        )
        if first_observation(sid, run_ids):
            reason = (
                f"{count} live orch run{'s' if count != 1 else ''} for this session have no "
                f"heartbeat. Arm under Monitor from the main checkout: {arm}{trailer}"
            )
            sys.stdout.write(json.dumps({"decision": "block", "reason": reason}) + "\n")
        else:
            warning = (
                f"Allowing stop after the one-shot heartbeat guard: {count} live orch "
                f"run{'s' if count != 1 else ''} remain unarmed. Arm under Monitor: {arm}{trailer}"
            )
            sys.stdout.write(json.dumps({"systemMessage": warning}) + "\n")
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
